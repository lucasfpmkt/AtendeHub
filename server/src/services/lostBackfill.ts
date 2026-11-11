/**
 * Uma vez só, após o deploy da aba Perdidos: finaliza as conversas abertas de leads que
 * já estavam na etapa "Perdido" e não escreveram depois de irem para lá.
 * Marcador em <pasta do banco>/backups/.perdidos-v1.
 */
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../db.js';
import { backupDir } from './backup.js';
import { finalizeIfLost } from './inbound.js';

export function startLostBackfillOnce() {
  const dir = backupDir();
  if (!dir) return;
  const marker = path.join(dir, '.perdidos-v1');
  if (existsSync(marker)) return;
  setTimeout(async () => {
    let n = 0;
    try {
      const lost = await prisma.pipelineStage.findMany({ select: { id: true, name: true, workspaceId: true } });
      const lostIds = lost.filter((s) => /perdid/i.test(s.name)).map((s) => s.id);
      const deals = await prisma.deal.findMany({ where: { stageId: { in: lostIds }, contactId: { not: null } }, select: { workspaceId: true, contactId: true, stageId: true, stageSince: true } });
      for (const d of deals) {
        if (!d.workspaceId || !d.contactId) continue;
        // Lead que escreveu depois de ir para Perdido voltou a conversar: não fecha.
        const back = await prisma.message.findFirst({ where: { direction: 'in', createdAt: { gt: d.stageSince }, conversation: { contactId: d.contactId, status: { not: 'closed' } } }, select: { id: true } });
        if (back) continue;
        const before = await prisma.conversation.count({ where: { contactId: d.contactId, status: { not: 'closed' } } });
        if (!before) continue;
        await finalizeIfLost(d.workspaceId, d.contactId, d.stageId);
        n += before;
      }
    } catch (e) {
      console.error('[perdidos] lote inicial falhou:', (e as Error).message);
    }
    console.log(`[perdidos] lote inicial: ${n} conversas finalizadas`);
    await writeFile(marker, String(n)).catch(() => {});
  }, 2 * 60_000);
}
