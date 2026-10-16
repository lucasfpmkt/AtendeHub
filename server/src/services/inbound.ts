import { prisma } from '../db.js';
import { emit } from '../realtime.js';
import { generateReply } from './ai.js';

function phoneFromJid(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

/**
 * Processa uma mensagem recebida do WhatsApp:
 *  1. garante o contato (cria se for número novo)
 *  2. garante a conversa aberta
 *  3. grava a mensagem
 *  4. emite em tempo real para o frontend
 *  5. se a auto-resposta por IA estiver ligada, responde
 *
 * `sendText` é injetado para evitar dependência circular com a sessão WA.
 */
export async function handleInboundMessage(params: {
  waJid: string;
  pushName?: string;
  body: string;
  waMessageId?: string;
  sendText: (jid: string, text: string) => Promise<void>;
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
    conversation = await prisma.conversation.create({
      data: { contactId: contact.id },
    });
  }

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: 'in',
      author: 'contact',
      body,
      waMessageId,
    },
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date(), status: 'open' },
  });

  emit({ type: 'message:new', conversationId: conversation.id, message });
  emit({ type: 'conversation:update', conversation });

  // Auto-resposta por IA, se habilitada nesta conversa.
  if (conversation.aiEnabled) {
    try {
      const reply = await generateReply(conversation.id);
      await sendText(waJid, reply);
      const outMsg = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          direction: 'out',
          author: 'ai',
          body: reply,
        },
      });
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });
      emit({ type: 'message:new', conversationId: conversation.id, message: outMsg });
    } catch (err) {
      console.error('[ia] falha na auto-resposta:', err);
    }
  }
}
