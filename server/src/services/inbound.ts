import { prisma } from '../db.js';
import { emit } from '../realtime.js';
import type { ChatTurn } from './llm.js';
import { resolveLlm } from './llm.js';
import {
  decideTarget,
  findAgentByName,
  getActiveThemeAgents,
  getActiveTriage,
  getAgent,
  logAgent,
  normalize,
  offlineReply,
  runAgent,
  scriptHasActions,
  shouldTriageStart,
  type Agent,
} from './agents.js';

function phoneFromJid(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

type SendText = (jid: string, text: string) => Promise<string | undefined>;

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

/**
 * Garante que o lead esteja no CRM: cria um negócio na 1ª etapa do funil padrão
 * (o primeiro funil do cliente) se ainda não houver um para este contato.
 * Idempotente — pode ser chamado a cada mensagem recebida.
 */
export async function ensureDealForContact(ws: string, contactId: string) {
  const exists = await prisma.deal.findFirst({ where: { workspaceId: ws, contactId } });
  if (exists) return;

  const funnel = await prisma.funnel.findFirst({ where: { workspaceId: ws }, orderBy: { order: 'asc' } });
  if (!funnel) return; // cliente ainda não tem funil configurado
  const stage = await prisma.pipelineStage.findFirst({ where: { funnelId: funnel.id }, orderBy: { order: 'asc' } });

  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  await prisma.deal.create({
    data: {
      workspaceId: ws,
      title: contact?.name || contact?.phone || 'Lead',
      contactId,
      funnelId: funnel.id,
      stageId: stage?.id ?? null,
      source: 'WhatsApp',
      stageSince: new Date(),
    },
  });
  if (stage) await prisma.contact.update({ where: { id: contactId }, data: { stageId: stage.id } }).catch(() => {});
  emit(ws, { type: 'crm:update' });
}

/** Nota interna na conversa: aparece para a equipe, não vai para o WhatsApp nem para a IA. */
export async function systemNote(ws: string, conversationId: string, body: string) {
  const message = await prisma.message.create({
    data: { conversationId, direction: 'out', author: 'system', body },
  });
  emit(ws, { type: 'message:new', conversationId, message });
}

/**
 * Grava uma mensagem ENVIADA pelo próprio número (fromMe) — tipicamente quando
 * o operador responde o cliente direto pelo WhatsApp do celular. Dedup pelo id
 * da mensagem: se o próprio LawHub já a enviou, ignora o eco. Quando é mesmo do
 * celular, pausa a IA desta conversa (o operador assumiu).
 */
export async function recordOutgoingMessage(params: {
  workspaceId: string;
  waJid: string;
  body: string;
  waMessageId?: string;
}) {
  const { workspaceId: ws, waJid, body, waMessageId } = params;
  if (!body?.trim()) return;

  if (waMessageId) {
    const already = await prisma.message.findFirst({
      where: { waMessageId, conversation: { workspaceId: ws } },
    });
    if (already) return; // eco de uma mensagem que o LawHub mesmo enviou
  }

  const contact = await prisma.contact.upsert({
    where: { workspaceId_waJid: { workspaceId: ws, waJid } },
    update: {},
    create: { workspaceId: ws, waJid, phone: phoneFromJid(waJid) },
  });

  let conversation = await prisma.conversation.findFirst({
    where: { workspaceId: ws, contactId: contact.id, status: { not: 'closed' } },
    orderBy: { lastMessageAt: 'desc' },
  });
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { workspaceId: ws, contactId: contact.id },
    });
  }

  const message = await prisma.message.create({
    data: { conversationId: conversation.id, direction: 'out', author: 'agent', body, waMessageId },
  });

  // Operador respondeu pelo celular: pausa a IA e cancela resposta agendada.
  cancelPendingReply(conversation.id);
  const updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date(), aiEnabled: false },
  });

  emit(ws, { type: 'message:new', conversationId: conversation.id, message });
  emit(ws, { type: 'conversation:update', conversation: updated });
}

/**
 * Importa UMA mensagem do histórico do WhatsApp (sincronização inicial do Baileys).
 * Diferente de uma mensagem ao vivo: NÃO dispara IA, automações, follow-up nem
 * notificação de não-lida. Só registra a conversa com o horário original, para a
 * equipe ver a conversa inteira no LawHub. Idempotente (dedup pelo id da mensagem).
 */
export async function importHistoryMessage(params: {
  workspaceId: string;
  waJid: string;
  pushName?: string;
  body: string;
  fromMe: boolean;
  waMessageId?: string;
  timestampMs: number;
}) {
  const { workspaceId: ws, waJid, pushName, body, fromMe, waMessageId, timestampMs } = params;
  if (!body?.trim()) return;

  if (waMessageId) {
    const already = await prisma.message.findFirst({ where: { waMessageId, conversation: { workspaceId: ws } } });
    if (already) return; // já temos esta mensagem
  }

  const phone = phoneFromJid(waJid);
  const contact = await prisma.contact.upsert({
    where: { workspaceId_waJid: { workspaceId: ws, waJid } },
    update: pushName ? { name: pushName } : {},
    create: { workspaceId: ws, waJid, phone, name: pushName || null },
  });

  let conversation = await prisma.conversation.findFirst({
    where: { workspaceId: ws, contactId: contact.id },
    orderBy: { lastMessageAt: 'desc' },
  });
  if (!conversation) {
    conversation = await prisma.conversation.create({ data: { workspaceId: ws, contactId: contact.id } });
  }

  const createdAt = new Date(timestampMs || Date.now());
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: fromMe ? 'out' : 'in',
      author: fromMe ? 'agent' : 'contact',
      body,
      waMessageId,
      createdAt, // preserva o horário original para a ordem da conversa
    },
  });
  if (createdAt > conversation.lastMessageAt) {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: createdAt } });
  }
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
  // Todo lead que escreve entra no CRM (1ª etapa do funil), se ainda não estiver.
  await ensureDealForContact(ws, contact.id).catch((e) => console.error('[crm] falha ao criar negócio:', e));
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

    const llm = await resolveLlm(ws);
    const { text, actions } = llm.ready ? await runAgent(agent, history, llm) : offlineReply(agent, history);
    if (text) await deliver(ws, conversationId, text, sendText);

    // Ações de CRM pedidas pelo roteiro (podem vir junto com a mensagem).
    for (const act of actions) {
      if (act.type === 'stage') await applyStage(ws, conversationId, act.name);
      else if (act.type === 'tag') await applyTag(ws, conversationId, act.name);
      else if (act.type === 'notify') await applyNotify(ws, conversationId, act.reason);
    }

    if (actions.some((a) => a.type === 'deactivate')) {
      const updated = await prisma.conversation.update({
        where: { id: conversationId },
        data: { aiEnabled: false },
      });
      emit(ws, { type: 'conversation:update', conversation: updated });
      await systemNote(ws, conversationId, `${agent.name} encerrou a parte automática. A conversa está com a equipe.`);
      return;
    }

    let target: Agent | null = null;
    const transfer = actions.find((a): a is { type: 'transfer'; agentName: string } => a.type === 'transfer');
    if (transfer) {
      target = await findAgentByName(ws, transfer.agentName);
      if (!target) {
        await systemNote(ws, conversationId, `O roteiro pediu transferência para “${transfer.agentName}”, mas esse agente não existe ou está inativo.`);
        return;
      }
    } else if (agent.type === 'triage' && !scriptHasActions(agent)) {
      // Roteiro sem ações explícitas: mantém o roteamento automático por gatilho/IA.
      const themeAgents = await getActiveThemeAgents(ws);
      const lastUser = [...history].reverse().find((h) => h.role === 'user');
      target = await decideTarget(lastUser?.content ?? '', themeAgents, history, llm);
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
  const waMessageId = await sendText(conversation.contact.waJid, text);
  const outMsg = await prisma.message.create({
    data: { conversationId, direction: 'out', author: 'ai', body: text, waMessageId },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: new Date() },
  });
  emit(ws, { type: 'message:new', conversationId, message: outMsg });
}

/* -------------------------------------------------------------------------- */
/* Ações de CRM executadas pelo agente                                         */
/* -------------------------------------------------------------------------- */

/** Move o lead para uma etapa do funil (move o negócio existente ou cria um). */
async function applyStage(ws: string, conversationId: string, stageName: string) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { contactId: true },
  });
  if (!conv) return;

  const stages = await prisma.pipelineStage.findMany({ where: { workspaceId: ws } });
  const target =
    stages.find((s) => normalize(s.name) === normalize(stageName)) ??
    stages.find((s) => normalize(s.name).includes(normalize(stageName)));
  if (!target) {
    await systemNote(ws, conversationId, `Não encontrei a etapa "${stageName}" para mover o lead.`);
    return;
  }

  const contact = await prisma.contact.findUnique({ where: { id: conv.contactId } });
  await prisma.contact.update({ where: { id: conv.contactId }, data: { stageId: target.id } }).catch(() => {});

  const deal = await prisma.deal.findFirst({
    where: { workspaceId: ws, contactId: conv.contactId, funnelId: target.funnelId ?? undefined },
    orderBy: { createdAt: 'desc' },
  });
  if (deal) {
    await prisma.deal.update({
      where: { id: deal.id },
      data: { stageId: target.id, stageSince: new Date(), followupStageId: null },
    });
  } else {
    await prisma.deal.create({
      data: {
        workspaceId: ws,
        title: contact?.name || contact?.phone || 'Lead',
        contactId: conv.contactId,
        funnelId: target.funnelId ?? null,
        stageId: target.id,
        source: 'WhatsApp',
        stageSince: new Date(),
      },
    });
  }
  emit(ws, { type: 'crm:update' });
  await systemNote(ws, conversationId, `Etapa movida para "${target.name}".`);
}

/** Adiciona uma etiqueta ao contato (e ao catálogo de etiquetas, se for nova). */
async function applyTag(ws: string, conversationId: string, tagName: string) {
  const name = tagName.trim();
  if (!name) return;
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { contactId: true },
  });
  if (!conv) return;

  const contact = await prisma.contact.findUnique({ where: { id: conv.contactId } });
  const tags = (contact?.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  if (!tags.some((t) => normalize(t) === normalize(name))) {
    tags.push(name);
    await prisma.contact.update({ where: { id: conv.contactId }, data: { tags: tags.join(', ') } });
  }

  const exists = await prisma.tag.findFirst({ where: { workspaceId: ws, name } });
  if (!exists) await prisma.tag.create({ data: { workspaceId: ws, name, color: '#b71312' } }).catch(() => {});

  await systemNote(ws, conversationId, `Etiqueta "${name}" adicionada ao contato.`);
}

/** Avisa a equipe: nota de sistema + marca a conversa como não lida. */
async function applyNotify(ws: string, conversationId: string, reason: string) {
  await systemNote(ws, conversationId, `🔔 Equipe notificada: ${reason.trim() || 'atenção neste atendimento'}`);
  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { unread: { increment: 1 } },
  });
  emit(ws, { type: 'conversation:update', conversation: updated });
}
