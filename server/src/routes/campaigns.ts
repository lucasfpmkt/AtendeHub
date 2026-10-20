import { Router } from 'express';
import { wsOf } from '../auth.js';
import { prisma } from '../db.js';
import { startCampaign, type Audience } from '../services/campaigns.js';

export const campaignsRouter = Router();

campaignsRouter.get('/', async (req, res) => {
  res.json(await prisma.campaign.findMany({ where: { workspaceId: wsOf(req) }, orderBy: { createdAt: 'desc' }, take: 50 }));
});

campaignsRouter.post('/', async (req, res) => {
  const body = String(req.body?.body ?? '').trim();
  if (!body) return res.status(400).json({ error: 'mensagem obrigatória' });
  const type = (req.body?.audienceType as Audience['type']) || 'all';
  const audience: Audience = { type, value: req.body?.value ? String(req.body.value) : undefined };
  const campaign = await startCampaign(wsOf(req), body, audience);
  res.json(campaign);
});
