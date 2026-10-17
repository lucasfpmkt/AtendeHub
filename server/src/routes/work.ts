import { Router } from 'express';
import { prisma } from '../db.js';

/** Tarefas, Agenda, Mensagens rápidas, Automação por palavras e Dashboard. */
export const workRouter = Router();

const pick = (body: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));

/* ------------------------------ Tarefas ------------------------------ */

const TASK_KEYS = ['title', 'status', 'priority', 'responsavel', 'dueDate'];

workRouter.get('/tasks', async (_req, res) => {
  res.json(await prisma.task.findMany({ orderBy: [{ status: 'asc' }, { dueDate: 'asc' }] }));
});
workRouter.post('/tasks', async (req, res) => {
  const data = pick(req.body ?? {}, TASK_KEYS);
  if (!String(data.title ?? '').trim()) return res.status(400).json({ error: 'título obrigatório' });
  res.json(await prisma.task.create({ data: data as { title: string } }));
});
workRouter.patch('/tasks/:id', async (req, res) => {
  res.json(await prisma.task.update({ where: { id: req.params.id }, data: pick(req.body ?? {}, TASK_KEYS) }));
});
workRouter.delete('/tasks/:id', async (req, res) => {
  await prisma.task.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

/* ------------------------------- Agenda ------------------------------ */

const EVENT_KEYS = ['title', 'date', 'start', 'end', 'kind', 'notes'];

workRouter.get('/events', async (req, res) => {
  const from = String(req.query.from ?? '');
  const to = String(req.query.to ?? '');
  res.json(
    await prisma.event.findMany({
      where: from && to ? { date: { gte: from, lte: to } } : undefined,
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
  res.json(await prisma.event.create({ data: d as { title: string; date: string; start: string; end: string } }));
});
workRouter.patch('/events/:id', async (req, res) => {
  res.json(await prisma.event.update({ where: { id: req.params.id }, data: pick(req.body ?? {}, EVENT_KEYS) }));
});
workRouter.delete('/events/:id', async (req, res) => {
  await prisma.event.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

/* -------------------------- Mensagens rápidas ------------------------ */

workRouter.get('/quick-replies', async (_req, res) => {
  res.json(await prisma.quickReply.findMany({ orderBy: { shortcut: 'asc' } }));
});
workRouter.post('/quick-replies', async (req, res) => {
  let shortcut = String(req.body?.shortcut ?? '').trim();
  const text = String(req.body?.text ?? '').trim();
  if (!shortcut || !text) return res.status(400).json({ error: 'atalho e texto são obrigatórios' });
  if (!shortcut.startsWith('/')) shortcut = `/${shortcut}`;
  res.json(
    await prisma.quickReply.upsert({ where: { shortcut }, update: { text }, create: { shortcut, text } }),
  );
});
workRouter.delete('/quick-replies/:id', async (req, res) => {
  await prisma.quickReply.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

/* ----------------------- Automação por palavras ---------------------- */

workRouter.get('/keyword-rules', async (_req, res) => {
  res.json(await prisma.keywordRule.findMany({ orderBy: { createdAt: 'asc' } }));
});
workRouter.post('/keyword-rules', async (req, res) => {
  const keyword = String(req.body?.keyword ?? '').trim();
  const reply = String(req.body?.reply ?? '').trim();
  if (!keyword || !reply) return res.status(400).json({ error: 'palavra e resposta são obrigatórias' });
  res.json(await prisma.keywordRule.create({ data: { keyword, reply } }));
});
workRouter.patch('/keyword-rules/:id', async (req, res) => {
  res.json(
    await prisma.keywordRule.update({
      where: { id: req.params.id },
      data: pick(req.body ?? {}, ['keyword', 'reply', 'active']),
    }),
  );
});
workRouter.delete('/keyword-rules/:id', async (req, res) => {
  await prisma.keywordRule.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

/* ------------------------------ Dashboard ---------------------------- */

// Data local (YYYY-MM-DD) — evita deslocar o dia por causa do fuso UTC.
const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

workRouter.get('/dashboard', async (req, res) => {
  const days = Math.min(90, Math.max(7, Number(req.query.days) || 7));
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));

  const [contacts, deals, convs, tasksOpen, agents, funnels] = await Promise.all([
    prisma.contact.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
    prisma.deal.findMany({ include: { stage: true } }),
    prisma.conversation.findMany({ select: { status: true, aiEnabled: true, unread: true, assignedAgentId: true } }),
    prisma.task.count({ where: { status: { not: 'done' } } }),
    prisma.agent.findMany({ select: { id: true, name: true, active: true, type: true }, orderBy: [{ type: 'asc' }, { order: 'asc' }] }),
    prisma.funnel.findMany({
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

  const byAgent = agents.map((a) => ({
    ...a,
    conversations: convs.filter((c) => c.assignedAgentId === a.id && c.status !== 'closed').length,
  }));

  res.json({
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
    agents: byAgent,
    funnels: funnels.map((f) => ({
      id: f.id,
      name: f.name,
      stages: f.stages.map((s) => ({ id: s.id, name: s.name, color: s.color, deals: s._count.deals })),
    })),
  });
});
