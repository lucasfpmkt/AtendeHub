import { prisma } from '../db.js';
import { emit } from '../realtime.js';
import type { ChatTurn } from './llm.js';
import {
  decideTarget,
  getActiveThemeAgents,
  getActiveTriage,
  getAgent,
  runAgent,
} from './agents.js';

function phoneFromJid(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

type SendText = (jid: string, text: string) => Promise<void>;

// Debounce por conversa: espera o cliente parar de digitar (delay do agente)
// antes de a IA responder. Uma nova mensagem reinicia o contador.
const pending = new Map<string, NodeJS.Timeout>();

async function historyOf(conversationId: string): Promise<ChatTurn[]> {
  const msgs = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    take: 40,
  });
  return msgs.map((m: { direction: string; body: string }) => ({
    role: (m.direction === 'in' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: m.body,
  }));
}

/** Processa uma mensagem recebida do WhatsApp. */
export async function handleInboundMessage(params: {
  waJid: string;
  pushName?: string;
  body: string;
  waMessageId?: string;
  sendText: SendText;
}) {
  const { waJid, pushName, body, waMessageId, sendText } = params;
  if (!body?.trim()) return;

  const phone = phoneFromJid(waJid);

  const contact = await prisma.contact.upsert({
    where: { waJid },
    update: { name: pushName || undefined },
    create: { waJid, phone, name: pushName || null },
  });

  let conversation = await prisma.conversation.findFirst({
    where: { contactId: contact.id, status: { not: 'closed' } },
    orderBy: { lastMessageAt: 'desc' },
  });

  if (!conversation) {
    // Conversa nova: se houver triagem ativa, liga a IA e atribui a ela.
    const triage = await getActiveTriage();
    conversation = await prisma.conversation.create({
      data: {
        contactId: contact.id,
        aiEnabled: Boolean(triage),
        assignedAgentId: triage?.id ?? null,
      },
    });
  }

  const message = await prisma.message.create({
    data: { conversationId: conversation.id, direction: 'in', author: 'contact', body, waMessageId },
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date(), status: 'open' },
  });

  emit({ type: 'message:new', conversationId: conversation.id, message });
  emit({ type: 'conversation:update', conversation });

  if (!conversation.aiEnabled) return;

  // Agenda a resposta da IA respeitando o delay do agente.
  const agent = await getAgent(conversation.assignedAgentId) ?? (await getActiveTriage());
  const delayMs = Math.max(1, agent?.delaySeconds ?? 8) * 1000;
  const convId = conversation.id;
  const existing = pending.get(convId);
  if (existing) clearTimeout(existing);
  pending.set(
    convId,
    setTimeout(() => {
      pending.delete(convId);
      void respondWithAI(convId, sendText).catch((err) =>
        console.error('[agentes] falha ao responder:', err),
      );
    }, delayMs),
  );
}

async function respondWithAI(conversationId: string, sendText: SendText) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation || !conversation.aiEnabled) return; // humano pode ter assumido

  let agent = await getAgent(conversation.assignedAgentId);
  if (!agent) agent = await getActiveTriage();
  if (!agent) return; // nenhum agente ativo

  const history = await historyOf(conversationId);
  if (history.length === 0 || history[history.length - 1].role !== 'user') return;

  const reply = await runAgent(agent, history);
  await deliver(conversationId, conversation.contactId, reply, sendText);

  // Se quem respondeu foi a triagem, decide para quem transferir.
  if (agent.type === 'triage') {
    const themeAgents = await getActiveThemeAgents();
    const lastUser = [...history].reverse().find((h) => h.role === 'user');
    const target = await decideTarget(lastUser?.content ?? '', themeAgents, history);
    if (target) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { assignedAgentId: target.id },
      });
    }
  }
}

async function deliver(
  conversationId: string,
  contactId: string,
  text: string,
  sendText: SendText,
) {
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return;
  await sendText(contact.waJid, text);
  const outMsg = await prisma.message.create({
    data: { conversationId, direction: 'out', author: 'ai', body: text },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: new Date() },
  });
  emit({ type: 'message:new', conversationId, message: outMsg });
}
