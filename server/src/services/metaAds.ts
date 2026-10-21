import { createHash, createHmac, randomBytes } from 'node:crypto';
import { prisma } from '../db.js';
import { dec } from '../crypto.js';
import { env } from '../env.js';

const GRAPH = `https://graph.facebook.com/${env.graphVersion}`;
const sha256 = (s: string) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');

/* --------------------------- OAuth (login Meta) ------------------------- */

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Estado assinado para o OAuth: carrega o workspace e expira em 15 min. */
export function signOauthState(ws: string): string {
  const payload = b64url(JSON.stringify({ ws, n: randomBytes(8).toString('hex'), exp: Date.now() + 15 * 60_000 }));
  const sig = b64url(createHmac('sha256', env.appSecret).update(payload).digest());
  return `${payload}.${sig}`;
}

/** Valida o estado e devolve o workspace, ou null. */
export function verifyOauthState(state?: string | null): string | null {
  if (!state) return null;
  const [payload, sig] = state.split('.');
  if (!payload || !sig) return null;
  const expected = b64url(createHmac('sha256', env.appSecret).update(payload).digest());
  if (sig.length !== expected.length) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (typeof data.exp !== 'number' || data.exp <= Date.now() || !data.ws) return null;
    return String(data.ws);
  } catch {
    return null;
  }
}

/** Monta a URL do diálogo de login do Facebook. */
export function metaLoginUrl(redirectUri: string, state: string): string {
  const scope = 'ads_read,ads_management,business_management';
  const q = new URLSearchParams({
    client_id: env.fbAppId,
    redirect_uri: redirectUri,
    state,
    scope,
    response_type: 'code',
  });
  return `https://www.facebook.com/${env.graphVersion}/dialog/oauth?${q}`;
}

/** Troca o code pelo token de curta duração e depois pelo de longa duração. */
export async function exchangeCodeForToken(code: string, redirectUri: string): Promise<{ token: string; expiresAt: number | null }> {
  const shortQ = new URLSearchParams({
    client_id: env.fbAppId,
    client_secret: env.fbAppSecret,
    redirect_uri: redirectUri,
    code,
  });
  const shortResp = await fetch(`${GRAPH}/oauth/access_token?${shortQ}`);
  const short: any = await shortResp.json().catch(() => ({}));
  if (!shortResp.ok || !short.access_token) throw new Error(short?.error?.message || 'Falha ao obter o token do Meta.');

  const longQ = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: env.fbAppId,
    client_secret: env.fbAppSecret,
    fb_exchange_token: short.access_token,
  });
  const longResp = await fetch(`${GRAPH}/oauth/access_token?${longQ}`);
  const long: any = await longResp.json().catch(() => ({}));
  const token = long.access_token || short.access_token;
  const expiresIn = Number(long.expires_in || short.expires_in || 0);
  return { token, expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : null };
}

/** Nome do usuário Meta conectado (para exibir "Conectado como …"). */
export async function getMetaUserName(token: string): Promise<string> {
  try {
    const r = await fetch(`${GRAPH}/me?fields=name&access_token=${encodeURIComponent(token)}`);
    const d: any = await r.json().catch(() => ({}));
    return d?.name || '';
  } catch {
    return '';
  }
}

/** Lista as contas de anúncios que o usuário conectado administra. */
export async function listMetaAdAccounts(token: string): Promise<{ id: string; name: string }[]> {
  const r = await fetch(`${GRAPH}/me/adaccounts?fields=account_id,name&limit=200&access_token=${encodeURIComponent(token)}`);
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `Meta respondeu ${r.status}`);
  return (d?.data ?? []).map((a: any) => ({ id: a.account_id ? `act_${a.account_id}` : a.id, name: a.name || a.id }));
}

/** Primeiro pixel/dataset da conta (para preencher a Conversions API sozinho). */
export async function firstPixelOf(adAccountId: string, token: string): Promise<string> {
  const acct = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  try {
    const r = await fetch(`${GRAPH}/${acct}/adspixels?fields=id,name&limit=1&access_token=${encodeURIComponent(token)}`);
    const d: any = await r.json().catch(() => ({}));
    return d?.data?.[0]?.id || '';
  } catch {
    return '';
  }
}

/**
 * Envia um evento de conversão (lead qualificado) para a Meta via Conversions API.
 * Para anúncios Click-to-WhatsApp, usa o ctwa_clid capturado na 1ª mensagem.
 */
export async function sendCapiLead(params: {
  pixelId: string;
  token: string;
  eventName: string;
  phone: string;
  ctwaClid?: string;
}) {
  const userData: Record<string, unknown> = { ph: [sha256(params.phone.replace(/\D/g, ''))] };
  if (params.ctwaClid) userData.ctwa_clid = params.ctwaClid;
  const event: Record<string, unknown> = {
    event_name: params.eventName || 'Lead',
    event_time: Math.floor(Date.now() / 1000),
    action_source: params.ctwaClid ? 'business_messaging' : 'system_generated',
    messaging_channel: 'whatsapp',
    user_data: userData,
  };
  const resp = await fetch(`${GRAPH}/${params.pixelId}/events?access_token=${encodeURIComponent(params.token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: [event] }),
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `Meta CAPI respondeu ${resp.status}`);
  return data;
}

/** Dispara o evento de lead qualificado se o cliente configurou e a etapa bate. */
export async function maybeFireQualifiedLead(ws: string, contactId: string, stageId: string) {
  const cfg = await prisma.metaConfig.findUnique({ where: { id: ws } });
  if (!cfg || !cfg.capiEnabled || !cfg.pixelId || !cfg.token || !cfg.qualifiedStageId) return;
  if (cfg.qualifiedStageId !== stageId) return;
  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact?.phone) return;
  try {
    await sendCapiLead({
      pixelId: cfg.pixelId,
      token: dec(cfg.token),
      eventName: cfg.eventName,
      phone: contact.phone,
      ctwaClid: contact.ctwaClid || undefined,
    });
  } catch (err) {
    console.error(`[meta-capi:${ws}] falha ao enviar lead:`, (err as Error).message);
  }
}

/** Resumo da conta de anúncios (gasto, resultados e campanhas) via Graph API. */
export async function getMetaAdsSummary(adAccountId: string, token: string, preset = 'last_30d') {
  const acct = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  const auth = `access_token=${encodeURIComponent(token)}`;

  const insightsResp = await fetch(
    `${GRAPH}/${acct}/insights?fields=spend,impressions,clicks,cpc,ctr,actions&date_preset=${preset}&${auth}`,
  );
  const insights: any = await insightsResp.json().catch(() => ({}));
  if (!insightsResp.ok) throw new Error(insights?.error?.message || `Meta respondeu ${insightsResp.status}`);
  const row = insights?.data?.[0] ?? {};
  const actions: { action_type: string; value: string }[] = row.actions ?? [];
  const leads = actions
    .filter((a) => /lead|messaging_conversation_started|onsite_conversion/.test(a.action_type))
    .reduce((s, a) => s + Number(a.value || 0), 0);

  const campResp = await fetch(`${GRAPH}/${acct}/campaigns?fields=name,status,effective_status,objective&limit=50&${auth}`);
  const camp: any = await campResp.json().catch(() => ({}));
  const campaigns = (camp?.data ?? []).map((c: any) => ({ name: c.name, status: c.effective_status || c.status, objective: c.objective }));

  return {
    spend: Number(row.spend || 0),
    impressions: Number(row.impressions || 0),
    clicks: Number(row.clicks || 0),
    cpc: Number(row.cpc || 0),
    ctr: Number(row.ctr || 0),
    leads,
    campaigns,
  };
}
