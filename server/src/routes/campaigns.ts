import { Router } from 'express';
import { wsOf } from '../auth.js';
import { prisma } from '../db.js';
import { startCampaign, type Audience, type CampaignTemplate } from '../services/campaigns.js';

export const campaignsRouter = Router();

campaignsRouter.get('/', async (req, res) => {
  res.json(await prisma.campaign.findMany({ where: { workspaceId: wsOf(req) }, orderBy: { createdAt: 'desc' }, take: 50 }));
});

campaignsRouter.post('/', async (req, res) => {
  const body = String(req.body?.body ?? '').trim();
  const t = req.body?.template;
  const template: CampaignTemplate | undefined =
    t && t.name
      ? { name: String(t.name), lang: String(t.lang || 'pt_BR'), bodyText: String(t.bodyText || ''), params: Array.isArray(t.params) ? t.params.map(String) : [] }
      : undefined;
  if (!body && !template) return res.status(400).json({ error: 'mensagem ou template obrigatório' });
  const type = (req.body?.audienceType as Audience['type']) || 'all';
  const audience: Audience = { type, value: req.body?.value ? String(req.body.value) : undefined };
  const campaign = await startCampaign(wsOf(req), body, audience, template);
  res.json(campaign);
});
