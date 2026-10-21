import { env } from '../env.js';

const OAUTH_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN = 'https://oauth2.googleapis.com/token';
const ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';
const api = () => `https://googleads.googleapis.com/${env.googleAdsVersion}`;

/** URL do consentimento do Google (pede refresh token offline). */
export function googleLoginUrl(redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: `${ADS_SCOPE} email`,
    access_type: 'offline',
    prompt: 'consent', // força vir o refresh_token mesmo em re-login
    include_granted_scopes: 'true',
    state,
  });
  return `${OAUTH_AUTH}?${q}`;
}

/** Troca o code por refresh token (e descobre o e-mail da conta). */
export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
): Promise<{ refreshToken: string; email: string }> {
  const body = new URLSearchParams({
    client_id: env.googleClientId,
    client_secret: env.googleClientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  });
  const resp = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.refresh_token) {
    throw new Error(data?.error_description || data?.error || 'Falha ao obter o refresh token do Google.');
  }
  let email = '';
  try {
    if (data.access_token) {
      const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { authorization: `Bearer ${data.access_token}` },
      });
      const u: any = await r.json().catch(() => ({}));
      email = u?.email || '';
    }
  } catch {
    /* ignora */
  }
  return { refreshToken: data.refresh_token, email };
}

/** Access token de curta duração a partir do refresh token. */
async function accessTokenFrom(refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.googleClientId,
    client_secret: env.googleClientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const resp = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new Error(data?.error_description || 'Não foi possível renovar o acesso ao Google.');
  return data.access_token;
}

function adsHeaders(accessToken: string): Record<string, string> {
  const h: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    'developer-token': env.googleAdsDeveloperToken,
    'content-type': 'application/json',
  };
  if (env.googleLoginCustomerId) h['login-customer-id'] = env.googleLoginCustomerId;
  return h;
}

/** Contas do Google Ads acessíveis pela conta conectada. */
export async function listAccessibleCustomers(refreshToken: string): Promise<{ id: string; name: string }[]> {
  if (!env.googleAdsDeveloperToken) throw new Error('Developer token do Google Ads não configurado no servidor.');
  const access = await accessTokenFrom(refreshToken);
  const resp = await fetch(`${api()}/customers:listAccessibleCustomers`, { headers: adsHeaders(access) });
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
        headers: adsHeaders(access),
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
export async function getGoogleAdsSummary(customerId: string, refreshToken: string) {
  if (!env.googleAdsDeveloperToken) throw new Error('Developer token do Google Ads não configurado no servidor.');
  const cid = fmtId(customerId);
  const access = await accessTokenFrom(refreshToken);

  const metricsQuery =
    'SELECT metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.average_cpc ' +
    'FROM customer WHERE segments.date DURING LAST_30_DAYS';
  const mResp = await fetch(`${api()}/customers/${cid}/googleAds:search`, {
    method: 'POST',
    headers: adsHeaders(access),
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
    headers: adsHeaders(access),
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
