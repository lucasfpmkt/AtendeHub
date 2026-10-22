import { Router, type Request, type Response } from 'express';
import { prisma } from '../db.js';
import { wsOf } from '../auth.js';
import { dec } from '../crypto.js';
import { getMetaAdsSummary } from '../services/metaAds.js';
import { getGoogleAdsSummary, resolveClientGoogleCreds } from '../services/googleAds.js';

/** Tarefas, Agenda, Mensagens rápidas, Automação por palavras e Dashboard — por cliente. */
export const workRouter = Router();

const pick = (body: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

const notFound = (res: Response) => res.status(404).json({ error: 'não encontrado' });

/** Atualiza só se o registro for do cliente; devolve o registro ou 404. */
async function scopedUpdate(
  req: Request,
  res: Response,
  model: 'task' | 'event' | 'keywordRule',
  data: Record<string, unknown>,
) {
  const ws = wsOf(req);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const delegate = prisma[model] as any;
  const r = await delegate.updateMany({ where: { id: req.params.id, workspaceId: ws }, data });
  if (r.count === 0) return notFound(res);
  res.json(await delegate.findFirst({ where: { id: req.params.id, workspaceId: ws } }));
}

/* ------------------------------ Tarefas ------------------------------ */

const TASK_KEYS = ['title', 'status', 'priority', 'responsavel', 'dueDate'];

workRouter.get('/tasks', async (req, res) => {
  res.json(
    await prisma.task.findMany({ where: { workspaceId: wsOf(req) }, orderBy: [{ status: 'asc' }, { dueDate: 'asc' }] }),
  );
});
workRouter.post('/tasks', async (req, res) => {
  const data = pick(req.body ?? {}, TASK_KEYS);
  if (!String(data.title ?? '').trim()) return res.status(400).json({ error: 'título obrigatório' });
  res.json(await prisma.task.create({ data: { ...(data as { title: string }), workspaceId: wsOf(req) } }));
});
workRouter.patch('/tasks/:id', (req, res) => scopedUpdate(req, res, 'task', pick(req.body ?? {}, TASK_KEYS)));
workRouter.delete('/tasks/:id', async (req, res) => {
  const r = await prisma.task.deleteMany({ where: { id: req.params.id, workspaceId: wsOf(req) } });
  res.json({ ok: r.count > 0 });
});

/* ------------------------------- Agenda ------------------------------ */

const EVENT_KEYS = ['title', 'date', 'start', 'end', 'kind', 'notes'];

workRouter.get('/events', async (req, res) => {
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  res.json(
    await prisma.event.findMany({
      where: { workspaceId: wsOf(req), ...(from && to ? { date: { gte: from, lte: to } } : {}) },
      orderBy: [{ date: 'asc' }, { start: 'asc' }],
    }),
  );
});
workRouter.post('/events', async (req, res) => {
  const d = pick(req.body ?? {}, EVENT_KEYS) as Record<string, string>;
  if (!d.title?.trim() || !d.date || !d.start || !d.end) {
    return res.status(400).json({ error: 'título, data, início e fim são obrigatórios' });
  }
  if (d.end <= d.start) return res.status(400).json({ error: 'o fim precisa ser depois do início' });
  res.json(
    await prisma.event.create({
      data: { ...(d as { title: string; date: string; start: string; end: string }), workspaceId: wsOf(req) },
    }),
  );
});
workRouter.patch('/events/:id', (req, res) => scopedUpdate(req, res, 'event', pick(req.body ?? {}, EVENT_KEYS)));
workRouter.delete('/events/:id', async (req, res) => {
  const r = await prisma.event.deleteMany({ where: { id: req.params.id, workspaceId: wsOf(req) } });
  res.json({ ok: r.count > 0 });
});

/* -------------------------- Mensagens rápidas ------------------------ */

workRouter.get('/quick-replies', async (req, res) => {
  res.json(await prisma.quickReply.findMany({ where: { workspaceId: wsOf(req) }, orderBy: { shortcut: 'asc' } }));
});
workRouter.post('/quick-replies', async (req, res) => {
  const ws = wsOf(req);
  let shortcut = String(req.body?.shortcut ?? '').trim();
  const text = String(req.body?.text ?? '').trim();
  if (!shortcut || !text) return res.status(400).json({ error: 'atalho e texto são obrigatórios' });
  if (!shortcut.startsWith('/')) shortcut = `/${shortcut}`;
  res.json(
    await prisma.quickReply.upsert({
      where: { workspaceId_shortcut: { workspaceId: ws, shortcut } },
      update: { text },
      create: { workspaceId: ws, shortcut, text },
    }),
  );
});
workRouter.delete('/quick-replies/:id', async (req, res) => {
  const r = await prisma.quickReply.deleteMany({ where: { id: req.params.id, workspaceId: wsOf(req) } });
  res.json({ ok: r.count > 0 });
});

/* ----------------------- Automação por palavras ---------------------- */

workRouter.get('/keyword-rules', async (req, res) => {
  res.json(await prisma.keywordRule.findMany({ where: { workspaceId: wsOf(req) }, orderBy: { createdAt: 'asc' } }));
});
workRouter.post('/keyword-rules', async (req, res) => {
  const keyword = String(req.body?.keyword ?? '').trim();
  const reply = String(req.body?.reply ?? '').trim();
  if (!keyword || !reply) return res.status(400).json({ error: 'palavra e resposta são obrigatórias' });
  res.json(await prisma.keywordRule.create({ data: { keyword, reply, workspaceId: wsOf(req) } }));
});
workRouter.patch('/keyword-rules/:id', (req, res) =>
  scopedUpdate(req, res, 'keywordRule', pick(req.body ?? {}, ['keyword', 'reply', 'active'])),
);
workRouter.delete('/keyword-rules/:id', async (req, res) => {
  const r = await prisma.keywordRule.deleteMany({ where: { id: req.params.id, workspaceId: wsOf(req) } });
  res.json({ ok: r.count > 0 });
});

/* ------------------------------ Dashboard ---------------------------- */

// Data local (YYYY-MM-DD) — evita deslocar o dia por causa do fuso UTC.
const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

workRouter.get('/dashboard', async (req, res) => {
  const ws = wsOf(req);
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 7));
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));

  const [contacts, deals, convs, tasksOpen, agents, funnels] = await Promise.all([
    prisma.contact.findMany({ where: { workspaceId: ws, createdAt: { gte: since } }, select: { createdAt: true } }),
    prisma.deal.findMany({ where: { workspaceId: ws }, select: { valueCents: true } }),
    prisma.conversation.findMany({
      where: { workspaceId: ws },
      select: { status: true, aiEnabled: true, unread: true, assignedAgentId: true },
    }),
    prisma.task.count({ where: { workspaceId: ws, status: { not: 'done' } } }),
    prisma.agent.findMany({
      where: { workspaceId: ws },
      select: { id: true, name: true, active: true, type: true },
      orderBy: [{ type: 'asc' }, { order: 'asc' }],
    }),
    prisma.funnel.findMany({
      where: { workspaceId: ws },
      orderBy: { order: 'asc' },
      include: { stages: { orderBy: { order: 'asc' }, include: { _count: { select: { deals: true } } } } },
    }),
  ]);

  const perDay: { date: string; count: number }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setDate(since.getDate() + i);
    perDay.push({ date: isoDay(d), count: 0 });
  }
  for (const c of contacts) {
    const row = perDay.find((p) => p.date === isoDay(c.createdAt));
    if (row) row.count++;
  }

  // --- Métricas de atendimento/conversão ---
  const [messagesIn, messagesOut, dealsMeta, periodConvs] = await Promise.all([
    prisma.message.count({ where: { conversation: { workspaceId: ws }, direction: 'in', createdAt: { gte: since } } }),
    prisma.message.count({ where: { conversation: { workspaceId: ws }, direction: 'out', author: { not: 'system' }, createdAt: { gte: since } } }),
    prisma.deal.findMany({ where: { workspaceId: ws }, select: { source: true } }),
    prisma.conversation.findMany({ where: { workspaceId: ws, createdAt: { gte: since } }, select: { id: true } }),
  ]);

  // Tempo médio de 1ª resposta (conversas iniciadas no período).
  let avgFirstResponseMin: number | null = null;
  const convIds = periodConvs.map((c) => c.id);
  if (convIds.length) {
    // Filtro pela relação (subconsulta) em vez de `in: convIds`: com muitas conversas
    // a lista de ids + filtro negativo estoura o limite de parâmetros do SQLite (P2029).
    const msgs = await prisma.message.findMany({
      where: { conversation: { workspaceId: ws, createdAt: { gte: since } }, author: { not: 'system' } },
      select: { conversationId: true, direction: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const firstIn = new Map<string, Date>();
    const firstOut = new Map<string, Date>();
    for (const m of msgs) {
      if (m.direction === 'in' && !firstIn.has(m.conversationId)) firstIn.set(m.conversationId, m.createdAt);
      if (m.direction === 'out' && !firstOut.has(m.conversationId)) firstOut.set(m.conversationId, m.createdAt);
    }
    let sum = 0;
    let n = 0;
    for (const [cid, inAt] of firstIn) {
      const out = firstOut.get(cid);
      if (out && out.getTime() > inAt.getTime()) {
        sum += out.getTime() - inAt.getTime();
        n++;
      }
    }
    if (n) avgFirstResponseMin = Math.round(sum / n / 60000);
  }

  // Leads por origem.
  const sourceMap = new Map<string, number>();
  for (const d of dealsMeta) {
    const key = d.source?.trim() || 'Sem origem';
    sourceMap.set(key, (sourceMap.get(key) ?? 0) + 1);
  }
  const bySource = [...sourceMap.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count);

  // Resultados atribuídos pelo Meta Ads (conversas iniciadas) no mesmo período,
  // para comparar com as conversas que realmente chegaram no WhatsApp.
  const adsPreset = days <= 7 ? 'last_7d' : days <= 15 ? 'last_14d' : 'last_30d';
  let metaResults: number | null = null;
  const metaCfg = await prisma.metaConfig.findUnique({ where: { id: ws } });
  if (metaCfg?.adAccountId && metaCfg?.token) {
    try {
      const summary = await getMetaAdsSummary(metaCfg.adAccountId, dec(metaCfg.token), adsPreset);
      metaResults = summary.leads ?? 0;
    } catch {
      metaResults = null;
    }
  }
  // Leads do Google Ads (conversões) no mesmo período.
  let googleResults: number | null = null;
  const gCfg = await prisma.googleAdsConfig.findUnique({ where: { id: ws } });
  if (gCfg?.customerId) {
    const { refreshToken, developerToken } = await resolveClientGoogleCreds(gCfg);
    if (refreshToken) {
      try {
        const gs = await getGoogleAdsSummary(gCfg.customerId, refreshToken, developerToken, adsPreset);
        googleResults = Math.round(gs.conversions ?? 0);
      } catch {
        googleResults = null;
      }
    }
  }

  // Conversão: negócios em etapas de "ganho/fechado" vs total.
  const wonRe = /fechad|ganho|won|conclu|contrat/i;
  let won = 0;
  for (const f of funnels) for (const s of f.stages) if (wonRe.test(s.name)) won += s._count.deals;
  const totalDeals = deals.length;
  const conversion = { won, total: totalDeals, rate: totalDeals ? Math.round((won / totalDeals) * 100) : 0 };

  res.json({
    messages: { in: messagesIn, out: messagesOut },
    whatsappConversations: periodConvs.length, // conversas que chegaram de fato no WhatsApp
    metaResults, // leads atribuídos pelo Meta Ads (ou null)
    googleResults, // leads (conversões) do Google Ads (ou null)
    firstResponseMin: avgFirstResponseMin,
    bySource,
    conversion,
    perDay,
    totals: {
      newContacts: contacts.length,
      openConversations: convs.filter((c) => c.status !== 'closed').length,
      aiConversations: convs.filter((c) => c.status !== 'closed' && c.aiEnabled).length,
      unread: convs.reduce((s, c) => s + c.unread, 0),
      tasksOpen,
      deals: deals.length,
      pipelineCents: deals.reduce((s, d) => s + d.valueCents, 0),
    },
    agents: agents.map((a) => ({
      ...a,
      conversations: convs.filter((c) => c.assignedAgentId === a.id && c.status !== 'closed').length,
    })),
    funnels: funnels.map((f) => ({
      id: f.id,
      name: f.name,
      stages: f.stages.map((s) => ({ id: s.id, name: s.name, color: s.color, deals: s._count.deals })),
    })),
  });
});
