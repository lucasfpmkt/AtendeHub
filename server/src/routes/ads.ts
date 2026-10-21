import { Router } from 'express';
import { wsOf } from '../auth.js';
import { prisma } from '../db.js';
import { getMetaAdsSummary, sendCapiLead } from '../services/metaAds.js';
import { enc, dec } from '../crypto.js';

export const adsRouter = Router();

/* ------------------------------ Meta Ads ------------------------------- */
adsRouter.get('/meta', async (req, res) => {
  const ws = wsOf(req);
  let cfg = await prisma.metaConfig.findUnique({ where: { id: ws } });
  if (!cfg) cfg = await prisma.metaConfig.create({ data: { id: ws } });
  const stages = await prisma.pipelineStage.findMany({
    where: { workspaceId: ws },
    orderBy: { order: 'asc' },
    select: { id: true, name: true },
  });
  const { token, ...safe } = cfg;
  res.json({ ...safe, hasToken: Boolean(token), stages });
});

adsRouter.patch('/meta', async (req, res) => {
  const ws = wsOf(req);
  const { adAccountId, token, pixelId, capiEnabled, qualifiedStageId, eventName } = req.body ?? {};
  const data: Record<string, unknown> = {};
  if (typeof adAccountId === 'string') data.adAccountId = adAccountId.trim();
  if (typeof pixelId === 'string') data.pixelId = pixelId.trim();
  if (typeof qualifiedStageId === 'string') data.qualifiedStageId = qualifiedStageId;
  if (typeof eventName === 'string') data.eventName = eventName.trim() || 'Lead';
  if (typeof capiEnabled === 'boolean') data.capiEnabled = capiEnabled;
  if (typeof token === 'string' && token.trim()) data.token = enc(token.trim());
  await prisma.metaConfig.upsert({ where: { id: ws }, update: data, create: { id: ws, ...data } });
  res.json({ ok: true });
});

adsRouter.get('/meta/summary', async (req, res) => {
  const cfg = await prisma.metaConfig.findUnique({ where: { id: wsOf(req) } });
  if (!cfg?.adAccountId || !cfg?.token) return res.json({ configured: false });
  try {
    const summary = await getMetaAdsSummary(cfg.adAccountId, dec(cfg.token), String(req.query.preset || 'last_30d'));
    res.json({ configured: true, ...summary });
  } catch (err) {
    res.status(400).json({ configured: true, error: (err as Error).message });
  }
});

// Teste manual do evento de conversão (lead) para validar a configuração.
adsRouter.post('/meta/test-capi', async (req, res) => {
  const cfg = await prisma.metaConfig.findUnique({ where: { id: wsOf(req) } });
  if (!cfg?.pixelId || !cfg?.token) return res.status(400).json({ error: 'Informe o Pixel/Dataset ID e o token.' });
  try {
    await sendCapiLead({ pixelId: cfg.pixelId, token: dec(cfg.token), eventName: cfg.eventName, phone: String(req.body?.phone || '5500000000000') });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/* ----------------------------- Google Ads ------------------------------ */
adsRouter.get('/google', async (req, res) => {
  const ws = wsOf(req);
  let cfg = await prisma.googleAdsConfig.findUnique({ where: { id: ws } });
  if (!cfg) cfg = await prisma.googleAdsConfig.create({ data: { id: ws } });
  const { developerToken, refreshToken, clientSecret, ...safe } = cfg;
  res.json({ ...safe, hasDeveloperToken: Boolean(developerToken), hasRefreshToken: Boolean(refreshToken), hasClientSecret: Boolean(clientSecret) });
});

adsRouter.patch('/google', async (req, res) => {
  const ws = wsOf(req);
  const { customerId, developerToken, refreshToken, clientId, clientSecret } = req.body ?? {};
  const data: Record<string, unknown> = {};
  if (typeof customerId === 'string') data.customerId = customerId.trim();
  if (typeof clientId === 'string') data.clientId = clientId.trim();
  if (typeof developerToken === 'string' && developerToken.trim()) data.developerToken = enc(developerToken.trim());
  if (typeof refreshToken === 'string' && refreshToken.trim()) data.refreshToken = enc(refreshToken.trim());
  if (typeof clientSecret === 'string' && clientSecret.trim()) data.clientSecret = enc(clientSecret.trim());
  await prisma.googleAdsConfig.upsert({ where: { id: ws }, update: data, create: { id: ws, ...data } });
  res.json({ ok: true });
});
