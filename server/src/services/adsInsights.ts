import { prisma } from '../db.js';
import { dec } from '../crypto.js';
import { resolveLlm } from './llm.js';
import { isQualifiedStage } from './crmSeed.js';
import { getMetaAdsBreakdown } from './metaAds.js';
import { getGoogleAdsBreakdown, resolveClientGoogleCreds } from './googleAds.js';

/**
 * Análise automática das campanhas de Meta Ads e Google Ads.
 * Toda segunda e quarta (8h, horário de Brasília) — ou sob demanda — junta os
 * números das duas plataformas (7 e 30 dias) e os resultados reais do CRM, e a
 * IA devolve sugestões de otimização classificadas por gravidade.
 */

export type Severity = 'critica' | 'media' | 'leve';
export type InsightItem = {
  severity: Severity;
  platform: 'meta' | 'google' | 'geral';
  campaign: string;
  title: string;
  detail: string;
  action: string;
};

const TZ = 'America/Sao_Paulo';

/** Data (AAAA-MM-DD), dia da semana (0=dom) e hora no horário de Brasília. */
export function brNow(d = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false, weekday: 'short' })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: wd, hour: Number(parts.hour) % 24 };
}

/* ------------------------------ coleta de dados ------------------------------ */

type Row = { name: string; status?: string; spend: number; impressions: number; clicks: number; leads: number; adsets?: Row[]; ads?: Row[] };

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Linha compacta para a IA (economiza tokens e já traz CTR/CPC/CPL calculados). */
function compact(n: Row) {
  return {
    nome: n.name,
    status: n.status ?? '',
    gasto: r2(n.spend),
    impressoes: n.impressions,
    cliques: n.clicks,
    leads: r2(n.leads),
    ctr: n.impressions ? r2((n.clicks / n.impressions) * 100) : 0,
    cpc: n.clicks ? r2(n.spend / n.clicks) : 0,
    cpl: n.leads ? r2(n.spend / n.leads) : null,
  };
}

/** Campanhas (com conjuntos e os principais anúncios) dos últimos 7 dias + campanhas de 30 dias. */
function shape(last7: { campaigns: Row[] }, last30: { campaigns: Row[] }) {
  const active = (c: Row) => c.spend > 0 || /ACTIVE|ENABLED/i.test(c.status ?? '');
  return {
    ultimos_7_dias: last7.campaigns
      .filter(active)
      .slice(0, 15)
      .map((c) => ({
        ...compact(c),
        conjuntos: (c.adsets ?? []).filter((a) => a.spend > 0).slice(0, 8).map((a) => ({
          ...compact(a),
          anuncios: (a.ads ?? []).filter((x) => x.spend > 0).slice(0, 5).map(compact),
        })),
      })),
    ultimos_30_dias: last30.campaigns.filter(active).slice(0, 20).map(compact),
  };
}

async function collect(ws: string) {
  const data: Record<string, unknown> = {};
  const platforms: string[] = [];
  const errors: string[] = [];

  const meta = await prisma.metaConfig.findUnique({ where: { id: ws } });
  if (meta?.adAccountId && meta?.token) {
    try {
      const token = dec(meta.token);
      const [d7, d30] = await Promise.all([
        getMetaAdsBreakdown(meta.adAccountId, token, 'last_7d'),
        getMetaAdsBreakdown(meta.adAccountId, token, 'last_30d'),
      ]);
      data.meta_ads = shape(d7 as { campaigns: Row[] }, d30 as { campaigns: Row[] });
      platforms.push('meta');
    } catch (err) {
      errors.push(`Meta Ads: ${(err as Error).message}`);
    }
  }

  const gcfg = await prisma.googleAdsConfig.findUnique({ where: { id: ws } });
  const { refreshToken, developerToken } = await resolveClientGoogleCreds(gcfg);
  if (refreshToken && gcfg?.customerId) {
    try {
      const [d7, d30] = await Promise.all([
        getGoogleAdsBreakdown(gcfg.customerId, refreshToken, 'last_7d', developerToken),
        getGoogleAdsBreakdown(gcfg.customerId, refreshToken, 'last_30d', developerToken),
      ]);
      data.google_ads = shape(d7 as { campaigns: Row[] }, d30 as { campaigns: Row[] });
      platforms.push('google');
    } catch (err) {
      errors.push(`Google Ads: ${(err as Error).message}`);
    }
  }

  // Resultado real no LawHub: quantos leads chegaram e quantos a IA qualificou.
  const since = (days: number) => new Date(Date.now() - days * 86_400_000);
  const stages = await prisma.pipelineStage.findMany({ where: { workspaceId: ws }, select: { id: true, name: true } });
  const qualifiedIds = stages.filter((s) => isQualifiedStage(s.name)).map((s) => s.id);
  const [conv7, conv30, qual7, qual30] = await Promise.all([
    prisma.conversation.count({ where: { workspaceId: ws, createdAt: { gte: since(7) } } }),
    prisma.conversation.count({ where: { workspaceId: ws, createdAt: { gte: since(30) } } }),
    prisma.deal.count({ where: { workspaceId: ws, stageId: { in: qualifiedIds }, stageSince: { gte: since(7) } } }),
    prisma.deal.count({ where: { workspaceId: ws, stageId: { in: qualifiedIds }, stageSince: { gte: since(30) } } }),
  ]);
  data.resultado_no_crm = {
    conversas_novas_whatsapp: { ultimos_7_dias: conv7, ultimos_30_dias: conv30 },
    leads_qualificados_pela_ia: { ultimos_7_dias: qual7, ultimos_30_dias: qual30 },
  };

  return { data, platforms, errors };
}

/* --------------------------------- análise --------------------------------- */

const SYSTEM = `Você é um gestor de tráfego sênior especializado em escritórios de advocacia no Brasil (Meta Ads e Google Ads).
Analise os dados de campanhas (JSON) e devolva sugestões de otimização PRÁTICAS e ESPECÍFICAS, citando campanha/conjunto/anúncio pelo nome e os números.

Classifique cada sugestão:
- "critica": dinheiro sendo desperdiçado ou resultado em risco AGORA (ex.: gasto sem nenhum lead; CPL muito acima da média da conta; campanha ativa sem entrega; queda forte de leads entre 30 e 7 dias; conta/campanha com problema de veiculação).
- "media": melhoria relevante de resultado (ex.: redistribuir verba para o que tem melhor CPL; CTR baixo pedindo novo criativo; conjunto saturado; teste de público/palavra-chave).
- "leve": ajuste fino ou boa prática (ex.: nomenclatura, testes A/B pequenos, extensões de anúncio, horários).

Regras:
- Use os dados de "resultado_no_crm" para avaliar a QUALIDADE: muitos leads nas plataformas e poucos qualificados no CRM indicam público ou mensagem errados.
- Não invente números nem campanhas que não estão nos dados. Se faltar dado para concluir algo, diga o que verificar.
- Respeite o Código de Ética da OAB e o Provimento 205/2021: nunca sugira anúncios com promessa de resultado, mercantilização, "consulta grátis" como isca ou captação indevida.
- Escreva em português do Brasil, direto, sem jargão desnecessário. Valores em R$.
- Entre 3 e 15 sugestões, ordenadas da mais crítica para a mais leve.

Responda SOMENTE com JSON válido, sem texto fora dele, no formato:
{"resumo":"2 a 4 frases sobre a saúde geral das campanhas","sugestoes":[{"gravidade":"critica|media|leve","plataforma":"meta|google|geral","campanha":"nome ou vazio","titulo":"curto","detalhe":"o que os números mostram","acao":"o que fazer, passo a passo curto"}]}`;

const SEV: Record<string, Severity> = { critica: 'critica', 'crítica': 'critica', critical: 'critica', media: 'media', 'média': 'media', medium: 'media', leve: 'leve', low: 'leve' };
const ORDER: Record<Severity, number> = { critica: 0, media: 1, leve: 2 };

/**
 * Extrai o JSON da resposta da IA com tolerância: texto/cercas ```json em volta,
 * só a lista de sugestões, ou JSON cortado no meio (quando a resposta estoura o
 * limite de tokens) — nesse caso aproveita as sugestões completas.
 */
function extractJson(raw: string): Record<string, unknown> {
  const text = raw.replace(/```(?:json)?/gi, '');
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  // Só a lista: [ {...}, {...} ]
  if (arrStart >= 0 && (objStart < 0 || arrStart < objStart) && !/"sugestoes"\s*:/.test(text.slice(0, arrStart + 1))) {
    const end = text.lastIndexOf(']');
    if (end > arrStart) {
      try {
        return { sugestoes: JSON.parse(text.slice(arrStart, end + 1)) };
      } catch {
        /* tenta como objeto abaixo */
      }
    }
  }
  if (objStart < 0) throw new Error('sem JSON');
  const body = text.slice(objStart);
  try {
    return JSON.parse(body.slice(0, body.lastIndexOf('}') + 1));
  } catch {
    // Cortado: recua até o fim de uma sugestão completa e fecha a lista/objeto.
    let cut = body.lastIndexOf('}');
    for (let i = 0; i < 40 && cut > 0; i++) {
      for (const close of [']}', '}]}', '"}]}']) {
        try {
          return JSON.parse(body.slice(0, cut + 1) + close);
        } catch {
          /* próxima tentativa */
        }
      }
      cut = body.lastIndexOf('}', cut - 1);
    }
    throw new Error('JSON inválido');
  }
}

/** Lê a resposta da IA e normaliza as sugestões. */
export function parseInsights(raw: string): { summary: string; items: InsightItem[] } {
  const j = extractJson(raw) as { sugestoes?: unknown; items?: unknown; resumo?: unknown; summary?: unknown };
  const list = Array.isArray(j.sugestoes) ? j.sugestoes : Array.isArray(j.items) ? j.items : [];
  const items: InsightItem[] = list
    .map((x: Record<string, unknown>) => {
      const sev = SEV[String(x.gravidade ?? x.severity ?? '').toLowerCase().trim()];
      const plat = String(x.plataforma ?? x.platform ?? 'geral').toLowerCase();
      const title = String(x.titulo ?? x.title ?? '').trim();
      if (!sev || !title) return null;
      return {
        severity: sev,
        platform: plat.includes('meta') || plat.includes('face') ? 'meta' : plat.includes('google') ? 'google' : 'geral',
        campaign: String(x.campanha ?? x.campaign ?? '').trim().slice(0, 200),
        title: title.slice(0, 200),
        detail: String(x.detalhe ?? x.detail ?? '').trim().slice(0, 1500),
        action: String(x.acao ?? x['ação'] ?? x.action ?? '').trim().slice(0, 1500),
      } as InsightItem;
    })
    .filter((x: InsightItem | null): x is InsightItem => Boolean(x))
    .sort((a: InsightItem, b: InsightItem) => ORDER[a.severity] - ORDER[b.severity])
    .slice(0, 20);
  if (!items.length) throw new Error('nenhuma sugestão válida');
  return { summary: String(j.resumo ?? j.summary ?? '').trim().slice(0, 2000), items };
}

const preview = (s: string) => (s.trim() ? `"${s.trim().replace(/\s+/g, ' ').slice(0, 300)}…"` : '(resposta vazia)');

/**
 * Pede a análise à IA. Se a resposta não vier em JSON, tenta de novo: com a
 * análise em texto, pede para converter; se veio vazia (modelos que "pensam"
 * podem gastar todo o limite raciocinando), repete com mais espaço.
 */
export async function askInsights(llm: Awaited<ReturnType<typeof resolveLlm>>, payload: string) {
  const first = await llm.complete({ system: SYSTEM, messages: [{ role: 'user', content: payload }], maxTokens: 6000 });
  try {
    return parseInsights(first);
  } catch {
    /* segunda tentativa */
  }
  const retry = first.trim()
    ? `Converta a análise abaixo para o formato JSON pedido. Responda SOMENTE com o JSON, começando com { e terminando com }.\n\n${first.slice(0, 15000)}`
    : `${payload}\n\nResponda SOMENTE com o JSON pedido, começando com { e terminando com }. Seja objetivo.`;
  const second = await llm.complete({ system: SYSTEM, messages: [{ role: 'user', content: retry }], maxTokens: 8000 });
  try {
    return parseInsights(second);
  } catch (err) {
    console.error(`[ads-insights] resposta não aproveitável (${llm.provider}/${llm.model}): 1ª ${preview(first)} | 2ª ${preview(second)}`);
    throw new Error(
      `A IA (${llm.provider} · ${llm.model}) não devolveu as sugestões no formato esperado (${(err as Error).message}). Início da resposta: ${preview(second || first)}`,
    );
  }
}

const running = new Set<string>();

/** Gera (e salva) o relatório de um cliente. */
export async function runAdsInsights(ws: string, trigger: 'auto' | 'manual') {
  if (running.has(ws)) throw new Error('Já existe uma análise em andamento para este cliente.');
  running.add(ws);
  const runDate = brNow().date;
  try {
    const { data, platforms, errors } = await collect(ws);
    if (!platforms.length) {
      throw new Error(errors.length ? errors.join(' | ') : 'Nenhuma conta de Meta Ads ou Google Ads conectada.');
    }
    const llm = await resolveLlm(ws);
    if (!llm.ready) throw new Error('A IA da plataforma não está conectada.');
    const { summary, items } = await askInsights(llm, `Dados das campanhas (gerado em ${runDate}):\n${JSON.stringify(data)}`);
    const note = errors.length ? `\n\n(Não foi possível ler: ${errors.join(' | ')})` : '';
    return await prisma.adsInsightReport.create({
      data: { workspaceId: ws, trigger, runDate, status: 'ok', summary: summary + note, items: JSON.stringify(items), platforms: platforms.join(',') },
    });
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[ads-insights:${ws}] falhou:`, message);
    return prisma.adsInsightReport.create({ data: { workspaceId: ws, trigger, runDate, status: 'error', error: message.slice(0, 1000) } });
  } finally {
    running.delete(ws);
  }
}

/* -------------------------------- agendador -------------------------------- */

const RUN_DAYS = new Set([1, 3]); // segunda e quarta
const RUN_HOUR = 8;
let timer: NodeJS.Timeout | null = null;

/** Clientes com Meta ou Google Ads configurado. */
async function workspacesWithAds(): Promise<string[]> {
  const [metas, googles, actives] = await Promise.all([
    prisma.metaConfig.findMany({ where: { adAccountId: { not: '' } }, select: { id: true, token: true } }),
    prisma.googleAdsConfig.findMany({ where: { customerId: { not: '' } }, select: { id: true } }),
    prisma.workspace.findMany({ where: { active: true }, select: { id: true } }),
  ]);
  const active = new Set(actives.map((w) => w.id));
  const ids = new Set([...metas.filter((m) => m.token).map((m) => m.id), ...googles.map((g) => g.id)]);
  return [...ids].filter((id) => active.has(id));
}

/** Uma verificação: se é segunda/quarta depois das 8h, roda quem ainda não rodou hoje. */
export async function runScheduledInsightsOnce() {
  const now = brNow();
  if (!RUN_DAYS.has(now.weekday) || now.hour < RUN_HOUR) return;
  for (const ws of await workspacesWithAds()) {
    const done = await prisma.adsInsightReport.findFirst({ where: { workspaceId: ws, trigger: 'auto', runDate: now.date } });
    if (done) continue;
    console.log(`[ads-insights:${ws}] análise automática de ${now.date}`);
    await runAdsInsights(ws, 'auto').catch(() => {}); // um cliente por vez (limites das APIs)
  }
}

export function startAdsInsightsLoop() {
  if (timer) return;
  timer = setInterval(() => void runScheduledInsightsOnce().catch((e) => console.error('[ads-insights] ciclo falhou:', e)), 15 * 60_000);
  timer.unref();
  setTimeout(() => void runScheduledInsightsOnce().catch(() => {}), 60_000);
}
