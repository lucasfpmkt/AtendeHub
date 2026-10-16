import { Router } from 'express';
import { prisma } from '../db.js';
import { llmReady } from '../services/llm.js';

export const agentsRouter = Router();

agentsRouter.get('/', async (_req, res) => {
  const agents = await prisma.agent.findMany({ orderBy: [{ type: 'asc' }, { order: 'asc' }] });
  res.json({ agents, providerConnected: llmReady });
});

agentsRouter.post('/', async (req, res) => {
  const { name, type, description, script, triggers, delaySeconds, active } = req.body ?? {};
  if (!name?.trim()) return res.status(400).json({ error: 'nome obrigatório' });
  const count = await prisma.agent.count();
  const agent = await prisma.agent.create({
    data: {
      name: String(name).trim(),
      type: type === 'triage' ? 'triage' : 'theme',
      description: description ?? '',
      script: script ?? '',
      triggers: triggers ?? '',
      delaySeconds: Number(delaySeconds ?? 15),
      active: active ?? true,
      order: count,
    },
  });
  res.json(agent);
});

agentsRouter.patch('/:id', async (req, res) => {
  const { name, type, description, script, triggers, delaySeconds, active, order } = req.body ?? {};
  const agent = await prisma.agent.update({
    where: { id: req.params.id },
    data: {
      name,
      type: type === undefined ? undefined : type === 'triage' ? 'triage' : 'theme',
      description,
      script,
      triggers,
      delaySeconds: delaySeconds === undefined ? undefined : Number(delaySeconds),
      active,
      order,
    },
  });
  res.json(agent);
});

agentsRouter.delete('/:id', async (req, res) => {
  await prisma.agent.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});
