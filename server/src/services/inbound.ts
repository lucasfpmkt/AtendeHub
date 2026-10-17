import { prisma } from '../db.js';
import { emit } from '../realtime.js';
import type { ChatTurn } from './llm.js';
import { llmReady } from './llm.js';
import {
  decideTarget,
  findAgentByName,
  getActiveThemeAgents,
  getActiveTriage,
  getAgent,
  logAgent,
  offlineReply,
  runAgent,
  scriptHasActions,
  shouldTriageStart,
  type Agent,
} from './agents.js';

function phoneFromJid(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

type SendText = (jid: string, text: string) => Promise<void>;

// Debounce por conversa: espera o cliente parar de digitar (delay do agente)
// antes de a IA responder. Uma nova mensagem reinicia o contador.
const pending = new Map<string, NodeJS.Timeout>();

/** Cancela uma resposta agendada (ex.: um humano assumiu a conversa). */
export function cancelPendingReply(conversationId: string) {
  const t = pending.get(conversationId);
  if (t) clearTimeout(t);
  pending.delete(conversationId);
}

async function historyOf(conversationId: string): Promise<ChatTurn[]> {
  const msgs = await prisma.message.findMany({
    where: { conversationId, author: { not: 'system' } },
    orderBy: { createdAt: 'desc' },
    take: 40,
  });
  return msgs.reverse().map((m: { direction: string; body: string }) => ({
    role: (m.direction === 'in' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: m.body,
  }));
}

/** Nota interna na conversa: aparece para a equipe, não vai para o WhatsApp nem para a IA. */
export async function systemNote(ws: string, conversationId: string, body: string) {
  const message = await prisma.message.create({
    data: { conversationId, direction: 'out', author: 'system', body },
  });
  emit(ws, { type: 'message:new', conversationId, message });
}

/** Processa uma mensagem recebida do WhatsApp. */
export async function handleInboundMessage(params: {
  workspaceId: string;
  waJid: string;
  pushName?: string;
  body: string;
  waMessageId?: string;
  sendText: SendText;
}) {
  const { workspaceId: ws, waJid, pushName, body, waMessageId, sendText } = params;
  if (!body?.trim()) return;

  const phone = phoneFromJid(waJid);

  const contact = await prisma.contact.upsert({
    where: { workspaceId_waJid: { workspaceId: ws, waJid } },
    update: { name: pushName || undefined },
    create: { workspaceId: ws, waJid, phone, name: pushName || null },
  });

  let conversation = await prisma.conversation.findFirst({
    where: { workspaceId: ws, contactId: contact.id, status: { not: 'closed' } },
    orderBy: { lastMessageAt: 'desc' },
  });

  let startedBy: Agent | null = null;
  if (!conversation) {
    // Conversa nova: a triagem só assume se passar pela porta de entrada (gatilhos).
    const triage = await getActiveTriage(ws);
    const start = triage ? await shouldTriageStart(ws, triage, body) : false;
    conversation = await prisma.conversation.create({
      data: {
        workspaceId: ws,
        contactId: contact.id,
        aiEnabled: start,
        assignedAgentId: start ? triage!.id : null,
      },
    });
    if (start) startedBy = triage;
  }

  const message = await prisma.message.create({
    data: { conversationId: conversation.id, direction: 'in', author: 'contact', body, waMessageId },
  });

  conversation = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date(), status: 'open', unread: { increment: 1 } },
  });

  emit(ws, { type: 'message:new', conversationId: conversation.id, message });
  emit(ws, { type: 'conversation:update', conversation });
  if (startedBy) await systemNote(ws, conversation.id, `${startedBy.name} assumiu o atendimento.`);

  if (!conversation.aiEnabled) {
    // Sem IA: respostas automáticas por palavra-chave.
    const rules = await prisma.keywordRule.findMany({ where: { workspaceId: ws, active: true } });
    const lower = body.toLowerCase();
    const rule = rules.find((r) => r.keyword.trim() && lower.includes(r.keyword.trim().toLowerCase()));
    if (rule) {
      try {
        await deliver(ws, conversation.id, rule.reply, sendText);
      } catch (err) {
        console.error('[automação] falha ao responder palavra-chave:', err);
      }
    }
    return;
  }

  // Agenda a resposta da IA respeitando o delay do agente.
  const agent = (await getAgent(ws, conversation.assignedAgentId)) ?? (await getActiveTriage(ws));
  schedule(ws, conversation.id, sendText, Math.max(1, agent?.delaySeconds ?? 8) * 1000, 0);
}

function schedule(ws: string, conversationId: string, sendText: SendText, delayMs: number, hop: number) {
  cancelPendingReply(conversationId);
  pending.set(
    conversationId,
    setTimeout(() => {
      pending.delete(conversationId);
      void respondWithAI(ws, conversationId, sendText, hop);
    }, delayMs),
  );
}

async function respondWithAI(ws: string, conversationId: string, sendText: SendText, hop: number) {
  try {
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || !conversation.aiEnabled) return; // humano pode ter assumido

    let agent = await getAgent(ws, conversation.assignedAgentId);
    if (!agent || !agent.active) agent = await getActiveTriage(ws);
    if (!agent) return; // nenhum agente ativo

    const history = await historyOf(conversationId);
    if (history.length === 0) return;
    // Na 1ª resposta após transferência, o novo agente fala mesmo sem nova mensagem do cliente.
    if (hop === 0 && history[history.length - 1].role !== 'user') return;

    const { text, action } = llmReady ? await runAgent(agent, history) : offlineReply(agent, history);
    if (text) await deliver(ws, conversationId, text, sendText);

    if (action?.type === 'deactivate') {
      const updated = await prisma.conversation.update({
        where: { id: conversationId },
        data: { aiEnabled: false },
      });
      emit(ws, { type: 'conversation:update', conversation: updated });
      await systemNote(ws, conversationId, `${agent.name} encerrou a parte automática. A conversa está com a equipe.`);
      return;
    }

    let target: Agent | null = null;
    if (action?.type === 'transfer') {
      target = await findAgentByName(ws, action.agentName);
      if (!target) {
        await systemNote(ws, conversationId, `O roteiro pediu transferência para “${action.agentName}”, mas esse agente não existe ou está inativo.`);
        return;
      }
    } else if (agent.type === 'triage' && !scriptHasActions(agent)) {
      // Roteiro sem ações explícitas: mantém o roteamento automático por gatilho/IA.
      const themeAgents = await getActiveThemeAgents(ws);
      const lastUser = [...history].reverse().find((h) => h.role === 'user');
      target = await decideTarget(lastUser?.content ?? '', themeAgents, history);
    }

    if (target && target.id !== agent.id) {
      const updated = await prisma.conversation.update({
        where: { id: conversationId },
        data: { assignedAgentId: target.id, aiEnabled: true },
      });
      emit(ws, { type: 'conversation:update', conversation: updated });
      await systemNote(ws, conversationId, `Transferido de ${agent.name} para ${target.name}.`);
      await logAgent(target.id, 'Recebeu uma conversa transferida');
      // O agente de tema continua o atendimento logo em seguida (no máximo 2 saltos).
      if (hop < 2) schedule(ws, conversationId, sendText, 3000, hop + 1);
    }
  } catch (err) {
    console.error('[agentes] falha ao responder:', err);
    await systemNote(
      ws,
      conversationId,
      `A IA não conseguiu responder (${(err as Error).message}). Verifique a chave e o modelo em Ajustes ou responda manualmente.`,
    ).catch(() => {});
  }
}

async function deliver(ws: string, conversationId: string, text: string, sendText: SendText) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { contact: true },
  });
  if (!conversation) return;
  await sendText(conversation.contact.waJid, text);
  const outMsg = await prisma.message.create({
    data: { conversationId, direction: 'out', author: 'ai', body: text },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: new Date() },
  });
  emit(ws, { type: 'message:new', conversationId, message: outMsg });
}
