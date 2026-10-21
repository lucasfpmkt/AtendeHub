import { Router } from 'express';
import type { Request } from 'express';
import { wsOf } from '../auth.js';
import { prisma } from '../db.js';
import {
  getMetaAdsSummary,
  sendCapiLead,
  signOauthState,
  verifyOauthState,
  metaLoginUrl,
  exchangeCodeForToken,
  getMetaUserName,
  listMetaAdAccounts,
  firstPixelOf,
} from '../services/metaAds.js';
import {
  googleLoginUrl,
  exchangeGoogleCode,
  listAccessibleCustomers,
  getGoogleAdsSummary,
} from '../services/googleAds.js';
import { enc, dec } from '../crypto.js';
import { env, metaOauthEnabled, googleOauthEnabled } from '../env.js';

export const adsRouter = Router();
// Routers PÚBLICOS só para o retorno do OAuth (o provedor redireciona o
// navegador, sem token de sessão). Montados em /api/ads/<provedor>/callback.
export const metaOauthRouter = Router();
export const googleOauthRouter = Router();

/** redirect_uri do OAuth — fixo por app; usa PUBLIC_URL ou deriva do request. */
function oauthRedirectUri(req: Request, provider: 'meta' | 'google' = 'meta'): string {
  const base = env.publicUrl || `${req.protocol}://${req.get('host')}`;
  return `${base}/api/ads/${provider}/callback`;
}

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
  const { token, tokenExpiresAt, ...safe } = cfg;
  res.json({
    ...safe,
    tokenExpiresAt: tokenExpiresAt != null ? Number(tokenExpiresAt) : null,
    hasToken: Boolean(token),
    oauthAvailable: metaOauthEnabled,
    stages,
  });
});

// URL do diálogo de login do Meta (o front redireciona o navegador para cá).
adsRouter.get('/meta/oauth-url', async (req, res) => {
  if (!metaOauthEnabled) return res.json({ available: false });
  const state = signOauthState(wsOf(req));
  res.json({ available: true, url: metaLoginUrl(oauthRedirectUri(req), state) });
});

// Contas de anúncios do usuário conectado (para o cliente escolher qual usar).
adsRouter.get('/meta/accounts', async (req, res) => {
  const cfg = await prisma.metaConfig.findUnique({ where: { id: wsOf(req) } });
  if (!cfg?.token) return res.json({ accounts: [] });
  try {
    res.json({ accounts: await listMetaAdAccounts(dec(cfg.token)) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Desconectar (limpa token e vínculo, preserva config de CAPI/etapa).
adsRouter.post('/meta/disconnect', async (req, res) => {
  await prisma.metaConfig.update({
    where: { id: wsOf(req) },
    data: { token: '', adAccountId: '', adAccountName: '', connectedVia: '', connectedName: '', tokenExpiresAt: null },
  }).catch(() => {});
  res.json({ ok: true });
});

// Retorno do OAuth (PÚBLICO). Troca o code por token, salva e volta ao app.
metaOauthRouter.get('/', async (req, res) => {
  const back = (ok: string) => res.redirect(`${env.publicUrl || ''}/?metaads=${ok}#metaads`);
  const ws = verifyOauthState(req.query.state as string | undefined);
  if (req.query.error) return back('cancelado');
  if (!ws || !req.query.code) return back('erro');
  try {
    const { token, expiresAt } = await exchangeCodeForToken(String(req.query.code), oauthRedirectUri(req));
    const [name, accounts] = await Promise.all([getMetaUserName(token), listMetaAdAccounts(token).catch(() => [])]);
    const first = accounts[0];
    const pixel = first ? await firstPixelOf(first.id, token) : '';
    const existing = await prisma.metaConfig.findUnique({ where: { id: ws } });
    await prisma.metaConfig.upsert({
      where: { id: ws },
      update: {
        token: enc(token),
        connectedVia: 'oauth',
        connectedName: name,
        tokenExpiresAt: expiresAt != null ? BigInt(expiresAt) : null,
        ...(first ? { adAccountId: first.id, adAccountName: first.name } : {}),
        ...(pixel && !existing?.pixelId ? { pixelId: pixel } : {}),
      },
      create: {
        id: ws,
        token: enc(token),
        connectedVia: 'oauth',
        connectedName: name,
        tokenExpiresAt: expiresAt != null ? BigInt(expiresAt) : null,
        adAccountId: first?.id ?? '',
        adAccountName: first?.name ?? '',
        pixelId: pixel,
      },
    });
    back('ok');
  } catch (err) {
    console.error('[meta-oauth] callback falhou:', (err as Error).message);
    back('erro');
  }
});

adsRouter.patch('/meta', async (req, res) => {
  const ws = wsOf(req);
  const { adAccountId, adAccountName, token, pixelId, capiEnabled, qualifiedStageId, eventName } = req.body ?? {};
  const data: Record<string, unknown> = {};
  if (typeof adAccountId === 'string') data.adAccountId = adAccountId.trim();
  if (typeof adAccountName === 'string') data.adAccountName = adAccountName.trim();
  if (typeof pixelId === 'string') data.pixelId = pixelId.trim();
  if (typeof qualifiedStageId === 'string') data.qualifiedStageId = qualifiedStageId;
  if (typeof eventName === 'string') data.eventName = eventName.trim() || 'Lead';
  if (typeof capiEnabled === 'boolean') data.capiEnabled = capiEnabled;
  if (typeof token === 'string' && token.trim()) {
    data.token = enc(token.trim());
    data.connectedVia = 'manual';
    data.tokenExpiresAt = null;
  }
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
  res.json({
    ...safe,
    hasDeveloperToken: Boolean(developerToken),
    hasRefreshToken: Boolean(refreshToken),
    hasClientSecret: Boolean(clientSecret),
    oauthAvailable: googleOauthEnabled,
    developerTokenReady: Boolean(env.googleAdsDeveloperToken),
  });
});

// URL do consentimento do Google (o front redireciona o navegador para cá).
adsRouter.get('/google/oauth-url', async (req, res) => {
  if (!googleOauthEnabled) return res.json({ available: false });
  const state = signOauthState(wsOf(req));
  res.json({ available: true, url: googleLoginUrl(oauthRedirectUri(req, 'google'), state) });
});

// Contas do Google Ads acessíveis pela conta conectada (para escolher qual).
adsRouter.get('/google/customers', async (req, res) => {
  const cfg = await prisma.googleAdsConfig.findUnique({ where: { id: wsOf(req) } });
  if (!cfg?.refreshToken) return res.json({ customers: [] });
  try {
    res.json({ customers: await listAccessibleCustomers(dec(cfg.refreshToken)) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

adsRouter.get('/google/summary', async (req, res) => {
  const cfg = await prisma.googleAdsConfig.findUnique({ where: { id: wsOf(req) } });
  if (!cfg?.refreshToken || !cfg?.customerId) return res.json({ configured: false });
  try {
    res.json({ configured: true, ...(await getGoogleAdsSummary(cfg.customerId, dec(cfg.refreshToken))) });
  } catch (err) {
    res.status(400).json({ configured: true, error: (err as Error).message });
  }
});

adsRouter.post('/google/disconnect', async (req, res) => {
  await prisma.googleAdsConfig
    .update({ where: { id: wsOf(req) }, data: { refreshToken: '', customerId: '', customerName: '', connectedVia: '', connectedEmail: '' } })
    .catch(() => {});
  res.json({ ok: true });
});

adsRouter.patch('/google', async (req, res) => {
  const ws = wsOf(req);
  const { customerId, customerName, developerToken, refreshToken, clientId, clientSecret } = req.body ?? {};
  const data: Record<string, unknown> = {};
  if (typeof customerId === 'string') data.customerId = customerId.trim();
  if (typeof customerName === 'string') data.customerName = customerName.trim();
  if (typeof clientId === 'string') data.clientId = clientId.trim();
  if (typeof developerToken === 'string' && developerToken.trim()) data.developerToken = enc(developerToken.trim());
  if (typeof refreshToken === 'string' && refreshToken.trim()) {
    data.refreshToken = enc(refreshToken.trim());
    data.connectedVia = 'manual';
  }
  if (typeof clientSecret === 'string' && clientSecret.trim()) data.clientSecret = enc(clientSecret.trim());
  await prisma.googleAdsConfig.upsert({ where: { id: ws }, update: data, create: { id: ws, ...data } });
  res.json({ ok: true });
});

// Retorno PÚBLICO do login com o Google (OAuth).
googleOauthRouter.get('/', async (req, res) => {
  const back = (ok: string) => res.redirect(`${env.publicUrl || ''}/?googleads=${ok}#googleads`);
  const ws = verifyOauthState(req.query.state as string | undefined);
  if (req.query.error) return back('cancelado');
  if (!ws || !req.query.code) return back('erro');
  try {
    const { refreshToken, email } = await exchangeGoogleCode(String(req.query.code), oauthRedirectUri(req, 'google'));
    let first: { id: string; name: string } | undefined;
    try {
      first = (await listAccessibleCustomers(refreshToken))[0];
    } catch {
      /* sem developer token ainda: salva o login mesmo assim */
    }
    await prisma.googleAdsConfig.upsert({
      where: { id: ws },
      update: {
        refreshToken: enc(refreshToken),
        connectedVia: 'oauth',
        connectedEmail: email,
        ...(first ? { customerId: first.id, customerName: first.name } : {}),
      },
      create: {
        id: ws,
        refreshToken: enc(refreshToken),
        connectedVia: 'oauth',
        connectedEmail: email,
        customerId: first?.id ?? '',
        customerName: first?.name ?? '',
      },
    });
    back('ok');
  } catch (err) {
    console.error('[google-oauth] callback falhou:', (err as Error).message);
    back('erro');
  }
});
