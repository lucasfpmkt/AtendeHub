import { createHash } from 'node:crypto';
import { prisma } from '../db.js';

const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_VERSION ?? 'v21.0'}`;
const sha256 = (s: string) => createHash('sha256').update(s.trim().toLowerCase()).digest('hex');

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
      token: cfg.token,
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
