import { createHash } from 'node:crypto';
import { prisma } from '../db.js';
import { dec } from '../crypto.js';
import { env } from '../env.js';

const sha256 = (s: string) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');

const OAUTH_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN = 'https://oauth2.googleapis.com/token';
const ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';
const api = () => `https://googleads.googleapis.com/${env.googleAdsVersion}`;

/**
 * Credenciais GLOBAIS do Google Ads (MCC). Prioridade: o que o admin salvou na
 * aba Clientes (PlatformConfig) e, se vazio, a variável de ambiente.
 */
export type GoogleGlobals = {
  clientId: string;
  clientSecret: string;
  developerToken: string;
  loginCustomerId: string;
  refreshToken: string;
};
export async function googleGlobals(): Promise<GoogleGlobals> {
  const p = await prisma.platformConfig.findUnique({ where: { id: 'global' } });
  return {
    clientId: p?.gadsClientId?.trim() || env.googleClientId,
    clientSecret: dec(p?.gadsClientSecret ?? '').trim() || env.googleClientSecret,
    developerToken: dec(p?.gadsDeveloperToken ?? '').trim() || env.googleAdsDeveloperToken,
    loginCustomerId: (p?.gadsLoginCustomerId || '').replace(/\D/g, '') || env.googleLoginCustomerId,
    refreshToken: dec(p?.gadsRefreshToken ?? '').trim() || env.googleRefreshToken,
  };
}
/** OAuth do Google disponível (tem client id/secret globais). */
export async function googleOauthReady(): Promise<boolean> {
  const g = await googleGlobals();
  return Boolean(g.clientId && g.clientSecret);
}
/** MCC global pronta (refresh + developer token) — por cliente só o Customer ID. */
export async function googleGlobalReady(): Promise<boolean> {
  const g = await googleGlobals();
  return Boolean(g.refreshToken && g.developerToken);
}
/** Credenciais efetivas de um cliente: as dele e, se vazias, as globais. */
export async function resolveClientGoogleCreds(cfg: { refreshToken?: string | null; developerToken?: string | null } | null) {
  const g = await googleGlobals();
  return {
    refreshToken: cfg?.refreshToken ? dec(cfg.refreshToken) : g.refreshToken,
    developerToken: cfg?.developerToken ? dec(cfg.developerToken) : g.developerToken,
  };
}

const noDevTokenError = 'Developer token do Google Ads não configurado (defina na aba Clientes, área do admin).';

/** URL do consentimento do Google (pede refresh token offline). */
export async function googleLoginUrl(redirectUri: string, state: string): Promise<string> {
  const g = await googleGlobals();
  const q = new URLSearchParams({
    client_id: g.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: `${ADS_SCOPE} email`,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${OAUTH_AUTH}?${q}`;
}

/** Troca o code por refresh token (e descobre o e-mail da conta). */
export async function exchangeGoogleCode(code: string, redirectUri: string): Promise<{ refreshToken: string; email: string }> {
  const g = await googleGlobals();
  const body = new URLSearchParams({
    client_id: g.clientId,
    client_secret: g.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const resp = await fetch(OAUTH_TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.refresh_token) {
    throw new Error(data?.error_description || data?.error || 'Falha ao obter o refresh token do Google.');
  }
  let email = '';
  try {
    if (data.access_token) {
      const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${data.access_token}` } });
      const u: any = await r.json().catch(() => ({}));
      email = u?.email || '';
    }
  } catch {
    /* ignora */
  }
  return { refreshToken: data.refresh_token, email };
}

/** Access token de curta duração a partir do refresh token. */
async function accessTokenFrom(refreshToken: string, g: GoogleGlobals): Promise<string> {
  const body = new URLSearchParams({
    client_id: g.clientId,
    client_secret: g.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const resp = await fetch(OAUTH_TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new Error(data?.error_description || 'Não foi possível renovar o acesso ao Google.');
  return data.access_token;
}

function adsHeaders(accessToken: string, devToken: string, loginCustomerId: string): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    'developer-token': devToken,
    'content-type': 'application/json',
  };
  if (loginCustomerId) h['login-customer-id'] = loginCustomerId;
  return h;
}

/** Contas do Google Ads acessíveis pela conta conectada. */
export async function listAccessibleCustomers(refreshToken: string, developerToken?: string): Promise<{ id: string; name: string }[]> {
  const g = await googleGlobals();
  const dt = (developerToken?.trim() || g.developerToken).trim();
  if (!dt) throw new Error(noDevTokenError);
  const access = await accessTokenFrom(refreshToken, g);
  const resp = await fetch(`${api()}/customers:listAccessibleCustomers`, { headers: adsHeaders(access, dt, g.loginCustomerId) });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `Google respondeu ${resp.status}`);
  const ids: string[] = (data?.resourceNames ?? []).map((r: string) => r.split('/')[1]).filter(Boolean);
  // Busca o nome descritivo de cada conta (best-effort).
  const out: { id: string; name: string }[] = [];
  for (const id of ids) {
    let name = id;
    try {
      const r = await fetch(`${api()}/customers/${id}/googleAds:search`, {
        method: 'POST',
        headers: adsHeaders(access, dt, g.loginCustomerId),
        body: JSON.stringify({ query: 'SELECT customer.descriptive_name FROM customer LIMIT 1' }),
      });
      const d: any = await r.json().catch(() => ({}));
      name = d?.results?.[0]?.customer?.descriptiveName || id;
    } catch {
      /* mantém o id */
    }
    out.push({ id, name });
  }
  return out;
}

const fmtId = (s: string) => s.replace(/\D/g, '');

/** Resumo da conta (gasto, cliques, impressões, conversões + campanhas). */
export async function getGoogleAdsSummary(customerId: string, refreshToken: string, developerToken?: string) {
  const g = await googleGlobals();
  const dt = (developerToken?.trim() || g.developerToken).trim();
  if (!dt) throw new Error(noDevTokenError);
  const cid = fmtId(customerId);
  const access = await accessTokenFrom(refreshToken, g);

  const metricsQuery =
    'SELECT metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.average_cpc ' +
    'FROM customer WHERE segments.date DURING LAST_30_DAYS';
  const mResp = await fetch(`${api()}/customers/${cid}/googleAds:search`, {
    method: 'POST',
    headers: adsHeaders(access, dt, g.loginCustomerId),
    body: JSON.stringify({ query: metricsQuery }),
  });
  const m: any = await mResp.json().catch(() => ({}));
  if (!mResp.ok) throw new Error(m?.error?.message || `Google respondeu ${mResp.status}`);
  const agg = (m?.results ?? []).reduce(
    (a: any, r: any) => {
      const x = r.metrics ?? {};
      a.costMicros += Number(x.costMicros || 0);
      a.impressions += Number(x.impressions || 0);
      a.clicks += Number(x.clicks || 0);
      a.conversions += Number(x.conversions || 0);
      return a;
    },
    { costMicros: 0, impressions: 0, clicks: 0, conversions: 0 },
  );

  const campQuery =
    'SELECT campaign.name, campaign.status FROM campaign WHERE segments.date DURING LAST_30_DAYS ORDER BY campaign.name LIMIT 50';
  const cResp = await fetch(`${api()}/customers/${cid}/googleAds:search`, {
    method: 'POST',
    headers: adsHeaders(access, dt, g.loginCustomerId),
    body: JSON.stringify({ query: campQuery }),
  });
  const c: any = await cResp.json().catch(() => ({}));
  const seen = new Set<string>();
  const campaigns = (c?.results ?? [])
    .map((r: any) => ({ name: r.campaign?.name as string, status: r.campaign?.status as string }))
    .filter((x: any) => x.name && !seen.has(x.name) && seen.add(x.name));

  const spend = agg.costMicros / 1_000_000;
  return {
    spend,
    impressions: agg.impressions,
    clicks: agg.clicks,
    conversions: agg.conversions,
    cpc: agg.clicks ? spend / agg.clicks : 0,
    campaigns,
  };
}

/* ------------- Detalhamento campanhas → grupos → anúncios --------------- */

// Cache simples por conta+período (evita bloqueios/rate-limit do Google).
const gCache = new Map<string, { at: number; data: unknown }>();
const G_TTL = 5 * 60_000;
const DATE_LITERAL: Record<string, string> = {
  today: 'TODAY',
  yesterday: 'YESTERDAY',
  last_7d: 'LAST_7_DAYS',
  last_30d: 'LAST_30_DAYS',
  this_month: 'THIS_MONTH',
  maximum: 'LAST_30_DAYS',
};

/** Árvore campanha → grupo de anúncios → anúncio com métricas (1 consulta). */
export async function getGoogleAdsBreakdown(customerId: string, refreshToken: string, preset = 'last_30d', developerToken?: string) {
  const g = await googleGlobals();
  const dt = (developerToken?.trim() || g.developerToken).trim();
  if (!dt) throw new Error(noDevTokenError);
  const cid = fmtId(customerId);
  const during = DATE_LITERAL[preset] || 'LAST_30_DAYS';
  const ck = `gbrk:${cid}:${during}`;
  const cached = gCache.get(ck);
  if (cached && Date.now() - cached.at < G_TTL) return cached.data;

  const access = await accessTokenFrom(refreshToken, g);
  const query =
    'SELECT campaign.id, campaign.name, campaign.status, ad_group.id, ad_group.name, ad_group.status, ' +
    'ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.status, ' +
    'metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions ' +
    `FROM ad_group_ad WHERE segments.date DURING ${during}`;

  const rows: any[] = [];
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const r = await fetch(`${api()}/customers/${cid}/googleAds:search`, {
      method: 'POST',
      headers: adsHeaders(access, dt, g.loginCustomerId),
      body: JSON.stringify({ query, pageSize: 1000, ...(pageToken ? { pageToken } : {}) }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `Google respondeu ${r.status}`);
    rows.push(...(j?.results ?? []));
    pageToken = j?.nextPageToken || '';
    if (!pageToken) break;
  }

  type Metr = { spend: number; impressions: number; clicks: number; leads: number; cpc: number };
  type Node = { id: string; name: string; status?: string; children?: Map<string, Node> } & Metr;
  const blank = (): Metr => ({ spend: 0, impressions: 0, clicks: 0, leads: 0, cpc: 0 });
  const add = (n: Node, x: any) => {
    n.spend += Number(x.costMicros || 0) / 1_000_000;
    n.impressions += Number(x.impressions || 0);
    n.clicks += Number(x.clicks || 0);
    n.leads += Number(x.conversions || 0);
  };
  const campaigns = new Map<string, Node>();
  for (const r of rows) {
    const c = r.campaign ?? {}, g = r.adGroup ?? {}, a = r.adGroupAd?.ad ?? {}, m = r.metrics ?? {};
    let camp = campaigns.get(c.id);
    if (!camp) campaigns.set(c.id, (camp = { id: c.id, name: c.name || c.id, status: c.status, ...blank(), children: new Map() }));
    add(camp, m);
    let grp = camp.children!.get(g.id);
    if (!grp) camp.children!.set(g.id, (grp = { id: g.id, name: g.name || g.id, status: g.status, ...blank(), children: new Map() }));
    add(grp, m);
    const adId = a.id || `${g.id}-ad`;
    let ad = grp.children!.get(adId);
    if (!ad) grp.children!.set(adId, (ad = { id: adId, name: a.name || `Anúncio ${adId}`, status: r.adGroupAd?.status, ...blank() }));
    add(ad, m);
  }
  const fin = (n: Node) => {
    n.cpc = n.clicks ? n.spend / n.clicks : 0;
    const { children, ...flat } = n;
    return flat;
  };
  const tree = [...campaigns.values()]
    .map((camp) => ({
      ...fin(camp),
      adsets: [...camp.children!.values()]
        .map((grp) => ({ ...fin(grp), ads: [...grp.children!.values()].map(fin).sort((a, b) => b.spend - a.spend) }))
        .sort((a, b) => b.spend - a.spend),
    }))
    .sort((a, b) => b.spend - a.spend);

  const result = { preset, campaigns: tree };
  gCache.set(ck, { at: Date.now(), data: result });
  return result;
}

/* ------------------- Conversões (Enhanced Conversions for Leads) ---------- */

/** Ações de conversão de upload disponíveis na conta (para escolher na UI). */
export async function listConversionActions(customerId: string, refreshToken: string, developerToken?: string): Promise<{ id: string; name: string }[]> {
  const g = await googleGlobals();
  const dt = (developerToken?.trim() || g.developerToken).trim();
  if (!dt) throw new Error(noDevTokenError);
  const cid = fmtId(customerId);
  const access = await accessTokenFrom(refreshToken, g);
  const resp = await fetch(`${api()}/customers/${cid}/googleAds:search`, {
    method: 'POST',
    headers: adsHeaders(access, dt, g.loginCustomerId),
    body: JSON.stringify({
      query:
        "SELECT conversion_action.id, conversion_action.name, conversion_action.status FROM conversion_action " +
        "WHERE conversion_action.status = 'ENABLED' ORDER BY conversion_action.name",
    }),
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `Google respondeu ${resp.status}`);
  return (data?.results ?? [])
    .map((r: any) => ({ id: String(r.conversionAction?.id ?? ''), name: r.conversionAction?.name || String(r.conversionAction?.id ?? '') }))
    .filter((x: any) => x.id);
}

/** Momento no formato exigido pelo Google Ads: "yyyy-MM-dd HH:mm:ss+00:00". */
function gAdsDateTime(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+00:00`
  );
}

/**
 * Envia uma conversão de lead usando o telefone (hashed) — Enhanced
 * Conversions for Leads, sem precisar de gclid. A ação de conversão precisa
 * estar configurada para esse uso na conta do Google Ads.
 */
export async function uploadLeadConversion(params: {
  customerId: string;
  refreshToken: string;
  conversionActionId: string;
  phone: string;
  when?: Date;
  developerToken?: string;
}) {
  const g = await googleGlobals();
  const dt = (params.developerToken?.trim() || g.developerToken).trim();
  if (!dt) throw new Error(noDevTokenError);
  const cid = fmtId(params.customerId);
  const access = await accessTokenFrom(params.refreshToken, g);
  const e164 = `+${params.phone.replace(/\D/g, '')}`;
  const body = {
    conversions: [
      {
        conversionAction: `customers/${cid}/conversionActions/${fmtId(params.conversionActionId)}`,
        conversionDateTime: gAdsDateTime(params.when ?? new Date()),
        userIdentifiers: [{ hashedPhoneNumber: sha256(e164) }],
      },
    ],
    partialFailure: true,
  };
  const resp = await fetch(`${api()}/customers/${cid}:uploadClickConversions`, {
    method: 'POST',
    headers: adsHeaders(access, dt, g.loginCustomerId),
    body: JSON.stringify(body),
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `Google respondeu ${resp.status}`);
  // partialFailureError traz erros por-item mesmo com HTTP 200.
  if (data?.partialFailureError?.message) throw new Error(data.partialFailureError.message);
  return data;
}

/** Dispara a conversão de lead qualificado no Google Ads (se configurado). */
export async function maybeFireGoogleConversion(ws: string, contactId: string, stageId: string) {
  const cfg = await prisma.googleAdsConfig.findUnique({ where: { id: ws } });
  const refreshToken = cfg?.refreshToken ? dec(cfg.refreshToken) : env.googleRefreshToken;
  if (!cfg || !cfg.conversionsEnabled || !refreshToken || !cfg.customerId || !cfg.conversionActionId) return;
  const qualifiedId = cfg.qualifiedStageId || (await findQualifiedStageId(ws));
  if (!qualifiedId || qualifiedId !== stageId) return;
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact?.phone) return;
  try {
    await uploadLeadConversion({
      customerId: cfg.customerId,
      refreshToken,
      conversionActionId: cfg.conversionActionId,
      phone: contact.phone,
      developerToken: cfg.developerToken ? dec(cfg.developerToken) : env.googleAdsDeveloperToken,
    });
  } catch (err) {
    console.error(`[google-conv:${ws}] falha ao enviar conversão:`, (err as Error).message);
  }
}
