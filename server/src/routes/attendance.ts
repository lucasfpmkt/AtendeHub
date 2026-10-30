import { Router } from 'express';
import { prisma } from '../db.js';
import { wsOf } from '../auth.js';
import { finalStageIds, runAttendanceAnalysis, suggestedFinalStage } from '../services/attendance.js';

/** Análise de atendimento do advogado (aba "Análise de atendimento"). */
export const attendanceRouter = Router();

async function cfgOf(ws: string) {
  return (
    (await prisma.aiConfig.findUnique({ where: { id: ws } })) ??
    // Cliente sem configuração de IA ainda: cria com os padrões.
    (await prisma.aiConfig.create({ data: { id: ws, systemPrompt: '' } }))
  );
}

async function stagesOf(ws: string) {
  const funnels = await prisma.funnel.findMany({
    where: { workspaceId: ws },
    orderBy: { order: 'asc' },
    include: { stages: { orderBy: { order: 'asc' }, select: { id: true, name: true } } },
  });
  return funnels.flatMap((f) => f.stages.map((s) => ({ id: s.id, name: s.name, funnelName: f.name })));
}

attendanceRouter.get('/config', async (req, res) => {
  const ws = wsOf(req);
  const cfg = await cfgOf(ws);
  const stages = await stagesOf(ws);
  let finals = [...finalStageIds(cfg.attendanceFinalStages)].filter((id) => stages.some((s) => s.id === id));
  const suggested = !cfg.attendanceFinalStages;
  if (suggested) finals = stages.filter((s) => suggestedFinalStage(s.name)).map((s) => s.id);
  res.json({ enabled: cfg.attendanceEnabled, since: cfg.attendanceSince, finalStages: finals, suggested, stages });
});

attendanceRouter.patch('/config', async (req, res) => {
  const ws = wsOf(req);
  const cfg = await cfgOf(ws);
  const data: Record<string, unknown> = {};
  if (typeof req.body?.enabled === 'boolean') {
    data.attendanceEnabled = req.body.enabled;
    // Ligou agora: só analisa leads que chegarem a partir deste momento.
    if (req.body.enabled && !cfg.attendanceEnabled) data.attendanceSince = new Date();
  }
  if (Array.isArray(req.body?.finalStages)) {
    const valid = new Set((await stagesOf(ws)).map((s) => s.id));
    data.attendanceFinalStages = req.body.finalStages.map(String).filter((id: string) => valid.has(id)).join(',');
  }
  const updated = await prisma.aiConfig.update({ where: { id: ws }, data });
  res.json({ enabled: updated.attendanceEnabled, since: updated.attendanceSince, finalStages: [...finalStageIds(updated.attendanceFinalStages)] });
});

const parseList = (s: string) => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

attendanceRouter.get('/reviews', async (req, res) => {
  const ws = wsOf(req);
  const reviews = await prisma.attendanceReview.findMany({ where: { workspaceId: ws }, orderBy: { updatedAt: 'desc' }, take: 300 });
  const convs = await prisma.conversation.findMany({
    where: { id: { in: reviews.map((r) => r.conversationId) } },
    select: { id: true, campaignAd: true, campaignAt: true, contactId: true, contact: { select: { name: true, phone: true } } },
  });
  const byConv = new Map(convs.map((c) => [c.id, c]));
  const deals = await prisma.deal.findMany({
    where: { workspaceId: ws, contactId: { in: convs.map((c) => c.contactId) } },
    orderBy: { updatedAt: 'desc' },
    select: { contactId: true, stage: { select: { name: true } } },
  });
  const stageByContact = new Map<string, string>();
  for (const d of deals) if (!stageByContact.has(d.contactId!)) stageByContact.set(d.contactId!, d.stage?.name ?? '');

  const items = reviews
    .filter((r) => byConv.has(r.conversationId)) // conversa apagada: some da lista
    .map((r) => {
      const c = byConv.get(r.conversationId)!;
      let metrics: Record<string, unknown> = {};
      try {
        metrics = JSON.parse(r.metrics);
      } catch {
        /* vazio */
      }
      return {
        id: r.id,
        conversationId: r.conversationId,
        name: c.contact?.name || c.contact?.phone || 'Lead',
        phone: c.contact?.phone ?? '',
        campaign: c.campaignAd ?? '',
        stage: stageByContact.get(c.contactId) ?? '',
        score: r.score,
        verdict: r.verdict,
        speed: r.speed,
        metrics,
        summary: r.summary,
        strengths: parseList(r.strengths),
        errors: parseList(r.errors),
        missing: parseList(r.missing),
        recommendation: r.recommendation,
        final: r.final,
        updatedAt: r.updatedAt,
      };
    });

  const n = items.length;
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
  const firsts = items.map((i) => i.metrics.firstResponseMin).filter((x): x is number => typeof x === 'number');
  res.json({
    summary: {
      leads: n,
      avgScore: avg(items.map((i) => i.score)),
      avgFirstResponseMin: avg(firsts),
      slow: items.filter((i) => i.speed === 'lento').length,
      bad: items.filter((i) => i.verdict === 'ruim').length,
      waiting: items.filter((i) => typeof i.metrics.unansweredMin === 'number').length,
    },
    items,
  });
});

attendanceRouter.post('/run', async (req, res) => {
  try {
    res.json(await runAttendanceAnalysis(wsOf(req)));
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});
