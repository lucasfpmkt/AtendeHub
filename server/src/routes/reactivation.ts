import { Router } from 'express';
import { prisma } from '../db.js';
import { wsOf } from '../auth.js';
import { createReactivation } from '../services/reactivation.js';

/** Reativação de leads antigos: gerar rascunhos, revisar, enviar aos poucos. */
export const reactivationRouter = Router();

async function jobView(ws: string, id: string) {
  const job = await prisma.reactivationJob.findFirst({ where: { id, workspaceId: ws } });
  if (!job) return null;
  const items = await prisma.reactivationItem.findMany({ where: { jobId: id }, orderBy: { createdAt: 'asc' } });
  const count = (st: string) => items.filter((i) => i.status === st).length;
  return { ...job, filters: JSON.parse(job.filters || '{}'), items, counts: { pending: count('pending'), sent: count('sent'), excluded: count('excluded'), skipped: count('skipped'), failed: count('failed') } };
}

reactivationRouter.get('/', async (req, res) => {
  const ws = wsOf(req);
  const last = await prisma.reactivationJob.findFirst({ where: { workspaceId: ws, status: { not: 'canceled' } }, orderBy: { createdAt: 'desc' } });
  res.json({ job: last ? await jobView(ws, last.id) : null });
});

reactivationRouter.post('/', async (req, res) => {
  const b = req.body ?? {};
  try {
    const job = await createReactivation(wsOf(req), {
      stageIds: Array.isArray(b.stageIds) ? b.stageIds.map(String) : [],
      minDays: Number(b.minDays) || 3,
      maxDays: Number(b.maxDays) || 90,
      limit: Number(b.limit) || 50,
    });
    res.json({ job: await jobView(wsOf(req), job.id) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

reactivationRouter.patch('/items/:id', async (req, res) => {
  const ws = wsOf(req);
  const item = await prisma.reactivationItem.findFirst({ where: { id: req.params.id, workspaceId: ws } });
  if (!item || !['pending', 'excluded'].includes(item.status)) return res.status(400).json({ error: 'Item já enviado ou inexistente.' });
  const data: Record<string, unknown> = {};
  if (typeof req.body?.text === 'string') data.text = req.body.text.trim().slice(0, 1500);
  if (req.body?.status === 'excluded' || req.body?.status === 'pending') data.status = req.body.status;
  if (data.status === 'pending' && !String(data.text ?? item.text).trim()) return res.status(400).json({ error: 'Escreva a mensagem antes de incluir.' });
  res.json(await prisma.reactivationItem.update({ where: { id: item.id }, data }));
});

reactivationRouter.post('/:id/:action', async (req, res) => {
  const ws = wsOf(req);
  const job = await prisma.reactivationJob.findFirst({ where: { id: req.params.id, workspaceId: ws } });
  if (!job) return res.status(404).json({ error: 'não encontrada' });
  const a = req.params.action;
  if (a === 'start') {
    if (!['draft', 'paused'].includes(job.status)) return res.status(400).json({ error: 'Só dá para iniciar uma lista revisada ou pausada.' });
    const perHour = Math.min(40, Math.max(5, Number(req.body?.perHour) || job.perHour || 20));
    await prisma.reactivationJob.update({ where: { id: job.id }, data: { status: 'running', perHour } });
  } else if (a === 'pause') {
    if (job.status === 'running') await prisma.reactivationJob.update({ where: { id: job.id }, data: { status: 'paused' } });
  } else if (a === 'cancel') {
    await prisma.reactivationJob.update({ where: { id: job.id }, data: { status: 'canceled' } });
    return res.json({ job: null });
  } else return res.status(400).json({ error: 'ação inválida' });
  res.json({ job: await jobView(ws, job.id) });
});
