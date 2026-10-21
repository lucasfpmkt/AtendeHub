import { rm } from 'node:fs/promises';
import { prisma } from '../db.js';
import { emit } from '../realtime.js';
import { getStatus, sendText } from '../whatsapp/session.js';
import { mediaFilePath } from '../whatsapp/media.js';

const today = () => new Date().toISOString().slice(0, 10);

/** Clientes ativos e dentro do prazo (não envia para conta desativada/vencida). */
async function activeWorkspaceIds(): Promise<Set<string>> {
  const all = await prisma.workspace.findMany({ where: { active: true }, select: { id: true, expiresAt: true } });
  const t = today();
  return new Set(all.filter((w) => !w.expiresAt || w.expiresAt >= t).map((w) => w.id));
}

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

  const active = await activeWorkspaceIds();
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
      if (!ws || !contact?.waJid || !active.has(ws)) continue; // cliente inativo/vencido
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

/** Envia as mensagens agendadas (lembretes) cujo horário chegou. */
async function runScheduledMessagesOnce() {
  const due = await prisma.scheduledMessage.findMany({
    where: { sent: false, sendAt: { lte: new Date() } },
    take: 50,
  });
  const active = due.length ? await activeWorkspaceIds() : new Set<string>();
  for (const sched of due) {
    try {
      if (!active.has(sched.workspaceId)) continue; // cliente inativo/vencido
      const conversation = await prisma.conversation.findUnique({
        where: { id: sched.conversationId },
        include: { contact: true },
      });
      if (!conversation) {
        await prisma.scheduledMessage.update({ where: { id: sched.id }, data: { sent: true } });
        continue;
      }
      if (getStatus(sched.workspaceId).status !== 'connected') continue; // tenta no próximo ciclo
      const waMessageId = await sendText(sched.workspaceId, conversation.contact.waJid, sched.body);
      const message = await prisma.message.create({
        data: { conversationId: conversation.id, direction: 'out', author: 'agent', body: sched.body, waMessageId },
      });
      const updated = await prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });
      await prisma.scheduledMessage.update({ where: { id: sched.id }, data: { sent: true } });
      emit(sched.workspaceId, { type: 'message:new', conversationId: conversation.id, message });
      emit(sched.workspaceId, { type: 'conversation:update', conversation: updated });
    } catch (err) {
      console.error('[agendada] falha ao enviar:', (err as Error).message);
    }
  }
}

let timer: NodeJS.Timeout | null = null;

/** Apaga mídia antiga (quando MEDIA_RETENTION_DAYS > 0) e zera o id na mensagem. */
async function cleanupOldMedia() {
  const days = Number(process.env.MEDIA_RETENTION_DAYS || 0);
  if (!days || days < 1) return; // desligado por padrão
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const old = await prisma.message.findMany({
    where: { mediaId: { not: null }, createdAt: { lt: cutoff } },
    select: { id: true, mediaId: true, conversation: { select: { workspaceId: true } } },
    take: 500,
  });
  for (const m of old) {
    const ws = m.conversation?.workspaceId;
    if (ws && m.mediaId) await rm(mediaFilePath(ws, m.mediaId), { force: true }).catch(() => {});
    await prisma.message.update({ where: { id: m.id }, data: { mediaId: null } }).catch(() => {});
  }
}

/** Marca como interrompidas campanhas que ficaram "running" (restart no meio). */
async function cleanupStuckCampaigns() {
  const stale = new Date(Date.now() - 2 * 3_600_000); // 2h
  await prisma.campaign
    .updateMany({ where: { status: 'running', createdAt: { lt: stale } }, data: { status: 'error' } })
    .catch(() => {});
}

/** Liga o laço de follow-up e mensagens agendadas (verifica a cada minuto). */
export function startFollowupLoop() {
  if (timer) return;
  let ticks = 0;
  timer = setInterval(() => {
    void runFollowupsOnce().catch((e) => console.error('[follow-up] ciclo falhou:', e));
    void runScheduledMessagesOnce().catch((e) => console.error('[agendada] ciclo falhou:', e));
    if (++ticks % 1440 === 0) void cleanupOldMedia().catch(() => {}); // 1x por dia
  }, 60_000);
  // Primeira verificação logo após subir (dá tempo das sessões conectarem).
  setTimeout(() => {
    void runFollowupsOnce().catch(() => {});
    void runScheduledMessagesOnce().catch(() => {});
    void cleanupStuckCampaigns().catch(() => {});
    void cleanupOldMedia().catch(() => {});
  }, 20_000);
}
