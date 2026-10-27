import { Router } from 'express';
import type { Request } from 'express';
import { wsOf } from '../auth.js';
import { prisma } from '../db.js';
import {
  getMetaAdsSummary,
  getMetaAdsBreakdown,
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
  getGoogleAdsBreakdown,
  listConversionActions,
  uploadLeadConversion,
  googleGlobalReady,
  googleOauthReady,
  resolveClientGoogleCreds,
} from '../services/googleAds.js';
import { findQualifiedStageId } from '../services/crmSeed.js';
import { enc, dec } from '../crypto.js';
import { runAdsInsights } from '../services/adsInsights.js';
import { env, metaOauthEnabled } from '../env.js';

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
  // Pré-seleciona a etapa "Lead Qualificado" quando ainda não há uma escolhida.
  if (!cfg.qualifiedStageId) {
    const qid = await findQualifiedStageId(ws);
    if (qid) cfg = await prisma.metaConfig.update({ where: { id: ws }, data: { qualifiedStageId: qid } });
  }
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

// Detalhamento campanhas → conjuntos → anúncios (1 chamada + cache).
adsRouter.get('/meta/breakdown', async (req, res) => {
  const cfg = await prisma.metaConfig.findUnique({ where: { id: wsOf(req) } });
  if (!cfg?.adAccountId || !cfg?.token) return res.json({ configured: false });
  try {
    const data = await getMetaAdsBreakdown(cfg.adAccountId, dec(cfg.token), String(req.query.preset || 'last_30d'));
    res.json({ configured: true, ...data });
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
// Credenciais do Google: por padrão globais (MCC, definidas na aba Clientes) —
// só o Customer ID muda por cliente. resolveClientGoogleCreds faz a resolução.
adsRouter.get('/google', async (req, res) => {
  const ws = wsOf(req);
  let cfg = await prisma.googleAdsConfig.findUnique({ where: { id: ws } });
  if (!cfg) cfg = await prisma.googleAdsConfig.create({ data: { id: ws } });
  if (!cfg.qualifiedStageId) {
    const qid = await findQualifiedStageId(ws);
    if (qid) cfg = await prisma.googleAdsConfig.update({ where: { id: ws }, data: { qualifiedStageId: qid } });
  }
  const stages = await prisma.pipelineStage.findMany({
    where: { workspaceId: ws },
    orderBy: { order: 'asc' },
    select: { id: true, name: true },
  });
  const { developerToken, refreshToken, clientSecret, ...safe } = cfg;
  res.json({
    ...safe,
    hasDeveloperToken: Boolean(developerToken),
    hasRefreshToken: Boolean(refreshToken),
    hasClientSecret: Boolean(clientSecret),
    oauthAvailable: await googleOauthReady(),
    developerTokenReady: Boolean(env.googleAdsDeveloperToken || developerToken),
    globalReady: await googleGlobalReady(), // MCC global configurada: só falta o Customer ID
    stages,
  });
});

// Ações de conversão de upload (para escolher qual disparar no qualificado).
adsRouter.get('/google/conversion-actions', async (req, res) => {
  const cfg = await prisma.googleAdsConfig.findUnique({ where: { id: wsOf(req) } });
  const { refreshToken, developerToken } = await resolveClientGoogleCreds(cfg);
  if (!refreshToken || !cfg?.customerId) return res.json({ actions: [] });
  try {
    res.json({ actions: await listConversionActions(cfg.customerId, refreshToken, developerToken) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Teste manual do envio de conversão.
adsRouter.post('/google/test-conversion', async (req, res) => {
  const cfg = await prisma.googleAdsConfig.findUnique({ where: { id: wsOf(req) } });
  const { refreshToken, developerToken } = await resolveClientGoogleCreds(cfg);
  if (!refreshToken || !cfg?.customerId || !cfg?.conversionActionId) {
    return res.status(400).json({ error: 'Conecte a conta e escolha a ação de conversão antes de testar.' });
  }
  try {
    await uploadLeadConversion({
      customerId: cfg.customerId,
      refreshToken,
      developerToken,
      conversionActionId: cfg.conversionActionId,
      phone: String(req.body?.phone || '5500000000000'),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// URL do consentimento do Google (o front redireciona o navegador para cá).
adsRouter.get('/google/oauth-url', async (req, res) => {
  if (!(await googleOauthReady())) return res.json({ available: false });
  const state = signOauthState(wsOf(req));
  res.json({ available: true, url: await googleLoginUrl(oauthRedirectUri(req, 'google'), state) });
});

// Contas do Google Ads acessíveis pela conta conectada (para escolher qual).
adsRouter.get('/google/customers', async (req, res) => {
  const cfg = await prisma.googleAdsConfig.findUnique({ where: { id: wsOf(req) } });
  const { refreshToken, developerToken } = await resolveClientGoogleCreds(cfg);
  if (!refreshToken) return res.json({ customers: [] });
  try {
    res.json({ customers: await listAccessibleCustomers(refreshToken, developerToken) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

adsRouter.get('/google/breakdown', async (req, res) => {
  const cfg = await prisma.googleAdsConfig.findUnique({ where: { id: wsOf(req) } });
  const { refreshToken, developerToken } = await resolveClientGoogleCreds(cfg);
  if (!refreshToken || !cfg?.customerId) return res.json({ configured: false });
  try {
    const data = await getGoogleAdsBreakdown(cfg.customerId, refreshToken, String(req.query.preset || 'last_30d'), developerToken);
    res.json({ configured: true, ...data });
  } catch (err) {
    res.json({ configured: true, error: (err as Error).message });
  }
});

adsRouter.get('/google/summary', async (req, res) => {
  const cfg = await prisma.googleAdsConfig.findUnique({ where: { id: wsOf(req) } });
  const { refreshToken, developerToken } = await resolveClientGoogleCreds(cfg);
  if (!refreshToken || !cfg?.customerId) return res.json({ configured: false });
  try {
    res.json({ configured: true, ...(await getGoogleAdsSummary(cfg.customerId, refreshToken, developerToken)) });
  } catch (err) {
    res.json({ configured: true, error: (err as Error).message });
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
  const { customerId, customerName, developerToken, refreshToken, clientId, clientSecret, conversionsEnabled, qualifiedStageId, conversionActionId, conversionName } =
    req.body ?? {};
  const data: Record<string, unknown> = {};
  if (typeof customerId === 'string') data.customerId = customerId.trim();
  if (typeof customerName === 'string') data.customerName = customerName.trim();
  if (typeof conversionsEnabled === 'boolean') data.conversionsEnabled = conversionsEnabled;
  if (typeof qualifiedStageId === 'string') data.qualifiedStageId = qualifiedStageId;
  if (typeof conversionActionId === 'string') data.conversionActionId = conversionActionId.trim();
  if (typeof conversionName === 'string') data.conversionName = conversionName.trim();
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

/* ----------------------- Otimizações (análise por IA) ----------------------- */
// Relatórios gerados toda segunda e quarta (ou sob demanda) com sugestões
// classificadas como crítica / média / leve.

const reportOut = (r: { id: string; trigger: string; runDate: string; status: string; summary: string; items: string; platforms: string; error: string | null; createdAt: Date }) => {
  let items: unknown = [];
  try {
    items = JSON.parse(r.items || '[]');
  } catch {
    /* mantém [] */
  }
  return { id: r.id, trigger: r.trigger, runDate: r.runDate, status: r.status, summary: r.summary, items, platforms: r.platforms ? r.platforms.split(',') : [], error: r.error, createdAt: r.createdAt };
};

adsRouter.get('/insights', async (req, res) => {
  const reports = await prisma.adsInsightReport.findMany({ where: { workspaceId: wsOf(req) }, orderBy: { createdAt: 'desc' }, take: 12 });
  res.json(reports.map(reportOut));
});

adsRouter.post('/insights/run', async (req, res) => {
  try {
    const report = await runAdsInsights(wsOf(req), 'manual');
    res.json(reportOut(report));
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});
