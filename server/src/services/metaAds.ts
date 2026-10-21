import { createHash, createHmac, randomBytes } from 'node:crypto';
import { prisma } from '../db.js';
import { dec } from '../crypto.js';
import { env } from '../env.js';
import { findQualifiedStageId } from './crmSeed.js';

const GRAPH = `https://graph.facebook.com/${env.graphVersion}`;
const sha256 = (s: string) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');

/* --------------------------- Cache (evita bloqueios) -------------------- */
// Guarda respostas da Graph API por alguns minutos, por conta+período, para
// não chamar o Meta a cada abertura de tela (principal causa de rate-limit).
const apiCache = new Map<string, { at: number; data: unknown }>();
const CACHE_TTL = 5 * 60_000;
function cacheGet<T>(key: string): T | null {
  const hit = apiCache.get(key);
  return hit && Date.now() - hit.at < CACHE_TTL ? (hit.data as T) : null;
}
function cacheSet(key: string, data: unknown) {
  apiCache.set(key, { at: Date.now(), data });
}

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
  if (!cfg || !cfg.capiEnabled || !cfg.pixelId || !cfg.token) return;
  // Etapa qualificada: a escolhida, ou por padrão a etapa "Lead Qualificado".
  const qualifiedId = cfg.qualifiedStageId || (await findQualifiedStageId(ws));
  if (!qualifiedId || qualifiedId !== stageId) return;
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
  const ckey = `sum:${acct}:${preset}`;
  const cached = cacheGet<Record<string, unknown>>(ckey);
  if (cached) return cached;
  const auth = `access_token=${encodeURIComponent(token)}`;

  const insightsResp = await fetch(
    `${GRAPH}/${acct}/insights?fields=spend,impressions,clicks,cpc,ctr,actions&date_preset=${preset}&${auth}`,
  );
  const insights: any = await insightsResp.json().catch(() => ({}));
  if (!insightsResp.ok) throw new Error(insights?.error?.message || `Meta respondeu ${insightsResp.status}`);
  const row = insights?.data?.[0] ?? {};
  const actions: { action_type: string; value: string }[] = row.actions ?? [];
  const leads = leadsFrom(actions);

  const campResp = await fetch(`${GRAPH}/${acct}/campaigns?fields=name,status,effective_status,objective&limit=50&${auth}`);
  const camp: any = await campResp.json().catch(() => ({}));
  const campaigns = (camp?.data ?? []).map((c: any) => ({ name: c.name, status: c.effective_status || c.status, objective: c.objective }));

  const result = {
    spend: Number(row.spend || 0),
    impressions: Number(row.impressions || 0),
    clicks: Number(row.clicks || 0),
    cpc: Number(row.cpc || 0),
    ctr: Number(row.ctr || 0),
    leads,
    campaigns,
  };
  cacheSet(ckey, result);
  return result;
}

/* ---------------- Detalhamento campanhas → conjuntos → anúncios ---------- */

type AdsRow = {
  id: string;
  name: string;
  status?: string;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  cpc: number;
  ctr: number;
};
// O Meta devolve a MESMA conversa/lead em vários tipos de ação e janelas de
// atribuição. Somar tudo infla o número (ex.: 13 vira 73). Então contamos só
// UM tipo — o "resultado" da campanha — escolhido por prioridade.
const LEAD_ACTION_PRIORITY = [
  'onsite_conversion.messaging_conversation_started_7d',
  'onsite_conversion.messaging_conversation_started',
  'onsite_conversion.lead_grouped',
  'leadgen.other',
  'offsite_conversion.fb_pixel_lead',
  'lead',
];
const leadsFrom = (actions: { action_type: string; value: string }[] = []) => {
  const byType = new Map(actions.map((a) => [a.action_type, Number(a.value || 0)]));
  for (const t of LEAD_ACTION_PRIORITY) if (byType.has(t)) return byType.get(t)!;
  // fallback: qualquer "conversa iniciada", sem somar janelas repetidas.
  const started = actions.find((a) => /messaging_conversation_started/.test(a.action_type));
  return started ? Number(started.value || 0) : 0;
};
const blank = (): Omit<AdsRow, 'id' | 'name' | 'status'> => ({ spend: 0, impressions: 0, clicks: 0, leads: 0, cpc: 0, ctr: 0 });

/**
 * Árvore campanha → conjunto → anúncio com métricas, em UMA chamada de
 * insights (level=ad) + 3 chamadas leves só de status. Resultado em cache
 * por 5 min para não repetir chamadas e evitar bloqueios/rate-limit.
 */
export async function getMetaAdsBreakdown(adAccountId: string, token: string, preset = 'last_30d') {
  const acct = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  const ckey = `brk:${acct}:${preset}`;
  const cached = cacheGet<unknown>(ckey);
  if (cached) return cached;
  const auth = `access_token=${encodeURIComponent(token)}`;

  // 1) Insights no nível de anúncio — traz nomes de campanha/conjunto/anúncio
  //    e métricas numa resposta só (paginando até um limite de segurança).
  const fields =
    'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,clicks,cpc,ctr,actions';
  let url = `${GRAPH}/${acct}/insights?level=ad&fields=${fields}&date_preset=${preset}&limit=500&${auth}`;
  const rows: any[] = [];
  for (let page = 0; page < 10 && url; page++) {
    const r = await fetch(url);
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `Meta respondeu ${r.status}`);
    rows.push(...(j?.data ?? []));
    url = j?.paging?.next || '';
  }

  // 2) Status efetivo de cada nível (chamadas leves, cacheáveis).
  const statusMap = async (edge: 'campaigns' | 'adsets' | 'ads') => {
    const r = await fetch(`${GRAPH}/${acct}/${edge}?fields=id,effective_status&limit=500&${auth}`);
    const j: any = await r.json().catch(() => ({}));
    const m = new Map<string, string>();
    for (const e of j?.data ?? []) m.set(e.id, e.effective_status);
    return m;
  };
  const [campStatus, adsetStatus, adStatus] = await Promise.all([statusMap('campaigns'), statusMap('adsets'), statusMap('ads')]);

  // 3) Agrupa em árvore somando métricas.
  type Node = AdsRow & { children?: Map<string, Node> };
  const campaigns = new Map<string, Node>();
  const add = (acc: Node, r: any) => {
    acc.spend += Number(r.spend || 0);
    acc.impressions += Number(r.impressions || 0);
    acc.clicks += Number(r.clicks || 0);
    acc.leads += leadsFrom(r.actions);
  };
  for (const r of rows) {
    let camp = campaigns.get(r.campaign_id);
    if (!camp) {
      camp = { id: r.campaign_id, name: r.campaign_name || r.campaign_id, status: campStatus.get(r.campaign_id), ...blank(), children: new Map() };
      campaigns.set(r.campaign_id, camp);
    }
    add(camp, r);
    let adset = camp.children!.get(r.adset_id);
    if (!adset) {
      adset = { id: r.adset_id, name: r.adset_name || r.adset_id, status: adsetStatus.get(r.adset_id), ...blank(), children: new Map() };
      camp.children!.set(r.adset_id, adset);
    }
    add(adset, r);
    let ad = adset.children!.get(r.ad_id);
    if (!ad) {
      ad = { id: r.ad_id, name: r.ad_name || r.ad_id, status: adStatus.get(r.ad_id), ...blank() };
      adset.children!.set(r.ad_id, ad);
    }
    add(ad, r);
  }

  const finalize = (n: Node): AdsRow & { adsets?: any[]; ads?: any[] } => {
    n.cpc = n.clicks ? n.spend / n.clicks : 0;
    n.ctr = n.impressions ? (n.clicks / n.impressions) * 100 : 0;
    const { children, ...flat } = n;
    return { ...flat, ...(children ? {} : {}) } as AdsRow;
  };
  const tree = [...campaigns.values()]
    .map((camp) => ({
      ...finalize(camp),
      adsets: [...camp.children!.values()]
        .map((adset) => ({
          ...finalize(adset),
          ads: [...adset.children!.values()].map((ad) => finalize(ad)).sort((a, b) => b.spend - a.spend),
        }))
        .sort((a, b) => b.spend - a.spend),
    }))
    .sort((a, b) => b.spend - a.spend);

  const result = { preset, campaigns: tree };
  cacheSet(ckey, result);
  return result;
}
