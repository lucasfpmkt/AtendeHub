import { prisma } from '../db.js';
import { emit } from '../realtime.js';
import { getStatus, sendText } from '../whatsapp/session.js';

/**
 * Follow-up automático por etapa do funil.
 *
 * Cada etapa pode ter `followupMinutes` (> 0) e `followupMessage`. Quando um
 * negócio fica parado na etapa por mais que esse tempo (contado a partir de
 * `stageSince`) e ainda não recebeu follow-up nesta etapa, enviamos a mensagem
 * pelo WhatsApp do cliente. `followupStageId` guarda a etapa já notificada para
 * não repetir; ele é zerado toda vez que o negócio muda de etapa.
 */
async function runFollowupsOnce() {
  const stages = await prisma.pipelineStage.findMany({
    where: { followupMinutes: { gt: 0 }, NOT: { followupMessage: '' } },
  });
  if (stages.length === 0) return;

  const now = Date.now();
  for (const stage of stages) {
    const cutoff = new Date(now - stage.followupMinutes * 60_000);
    const deals = await prisma.deal.findMany({
      where: {
        stageId: stage.id,
        stageSince: { lte: cutoff },
        NOT: { followupStageId: stage.id },
      },
      include: { contact: true },
      take: 50,
    });

    for (const deal of deals) {
      const ws = deal.workspaceId;
      const contact = deal.contact;
      if (!ws || !contact?.waJid) continue;
      if (getStatus(ws).status !== 'connected') continue; // WhatsApp desconectado: tenta no próximo ciclo

      try {
        // Thread na conversa aberta do contato (ou cria uma).
        let conversation = await prisma.conversation.findFirst({
          where: { workspaceId: ws, contactId: contact.id, status: { not: 'closed' } },
          orderBy: { lastMessageAt: 'desc' },
        });
        if (!conversation) {
          conversation = await prisma.conversation.create({ data: { workspaceId: ws, contactId: contact.id } });
        }

        const waMessageId = await sendText(ws, contact.waJid, stage.followupMessage);
        const message = await prisma.message.create({
          data: { conversationId: conversation.id, direction: 'out', author: 'ai', body: stage.followupMessage, waMessageId },
        });
        const updated = await prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastMessageAt: new Date() },
        });

        // Marca como já notificado nesta etapa e registra a nota de sistema.
        await prisma.deal.update({ where: { id: deal.id }, data: { followupStageId: stage.id } });
        const note = await prisma.message.create({
          data: {
            conversationId: conversation.id,
            direction: 'out',
            author: 'system',
            body: `⏰ Follow-up automático enviado (etapa "${stage.name}").`,
          },
        });

        emit(ws, { type: 'message:new', conversationId: conversation.id, message });
        emit(ws, { type: 'message:new', conversationId: conversation.id, message: note });
        emit(ws, { type: 'conversation:update', conversation: updated });
      } catch (err) {
        console.error('[follow-up] falha ao enviar:', (err as Error).message);
      }
    }
  }
}

let timer: NodeJS.Timeout | null = null;

/** Liga o laço de follow-up (verifica a cada minuto). */
export function startFollowupLoop() {
  if (timer) return;
  timer = setInterval(() => {
    void runFollowupsOnce().catch((e) => console.error('[follow-up] ciclo falhou:', e));
  }, 60_000);
  // Primeira verificação logo após subir (dá tempo das sessões conectarem).
  setTimeout(() => void runFollowupsOnce().catch(() => {}), 20_000);
}
