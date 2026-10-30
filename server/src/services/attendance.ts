import { prisma } from '../db.js';
import { resolveLlm } from './llm.js';
import { askJson, extractJson } from './llmJson.js';
import { brNow } from './adsInsights.js';

/**
 * Análise de atendimento do advogado (só o atendimento HUMANO).
 *
 * Travas para a IA não analisar tudo:
 * - só com a chave ligada no cliente;
 * - só leads de campanha (chegaram com uma frase-gatilho de algum roteiro);
 * - só leads que chegaram DEPOIS de ligar (attendanceSince);
 * - só até a etapa final escolhida (depois disso a análise do lead encerra);
 * - só reanalisa quando há mensagens novas.
 * Roda 1x por dia (19h, horário de Brasília) e sob demanda.
 */

type Msg = { direction: string; author: string; createdAt: Date; body: string };

const TZ = 'America/Sao_Paulo';
const BUSINESS_START = 8;
const BUSINESS_END = 20;

/** Partes da data no horário de Brasília. */
const BR_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false, day: '2-digit', month: '2-digit' });

function brParts(d: Date) {
  const p = Object.fromEntries(BR_FMT.formatToParts(d).map((x) => [x.type, x.value]));
  return {
    wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    label: `${['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'][['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday)]} ${p.day}/${p.month} ${p.hour}:${p.minute}`,
  };
}

/** Minutos entre a e b que caem em horário comercial (8h–20h, seg–sáb, Brasília). */
export function businessMinutes(a: Date, b: Date): number {
  if (b <= a) return 0;
  const end = Math.min(b.getTime(), a.getTime() + 30 * 86_400_000); // teto de 30 dias
  let t = a.getTime();
  let total = 0;
  while (t < end) {
    const step = Math.min(end - t, 15 * 60_000 - (t % (15 * 60_000)) || 15 * 60_000);
    const p = brParts(new Date(t));
    if (p.wd !== 0 && p.hour >= BUSINESS_START && p.hour < BUSINESS_END) total += step;
    t += step;
  }
  return Math.round(total / 60_000);
}

export type AttendanceMetrics = {
  leadMsgs: number;
  humanMsgs: number;
  aiMsgs: number;
  firstResponseMin: number | null; // horário comercial
  avgResponseMin: number | null;
  maxResponseMin: number | null;
  slowReplies: number; // respostas que demoraram > 60 min (horário comercial)
  rawAvgResponseMin: number | null; // tempo corrido, sem descontar noite/domingo
  unansweredMin: number | null; // lead esperando resposta humana agora
};

/**
 * Tempos de resposta do advogado. Uma espera começa na 1ª mensagem do lead ainda
 * sem resposta e termina na próxima mensagem HUMANA. Se a IA responder antes, a
 * espera não conta para o advogado (era a IA atendendo).
 */
export function responseMetrics(msgs: Msg[], opts: { humanOwns: boolean; now?: Date }): AttendanceMetrics {
  const now = opts.now ?? new Date();
  const waits: number[] = [];
  const raw: number[] = [];
  let pendingFrom: Date | null = null;
  let leadMsgs = 0;
  let humanMsgs = 0;
  let aiMsgs = 0;
  for (const m of msgs) {
    if (m.author === 'system') continue;
    if (m.direction === 'in') {
      leadMsgs++;
      if (!pendingFrom) pendingFrom = m.createdAt;
    } else if (m.author === 'ai') {
      aiMsgs++;
      pendingFrom = null;
    } else {
      humanMsgs++;
      if (pendingFrom) {
        waits.push(businessMinutes(pendingFrom, m.createdAt));
        raw.push(Math.round((m.createdAt.getTime() - pendingFrom.getTime()) / 60_000));
        pendingFrom = null;
      }
    }
  }
  const avg = (a: number[]) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null);
  return {
    leadMsgs,
    humanMsgs,
    aiMsgs,
    firstResponseMin: waits.length ? waits[0] : null,
    avgResponseMin: avg(waits),
    maxResponseMin: waits.length ? Math.max(...waits) : null,
    slowReplies: waits.filter((w) => w > 60).length,
    rawAvgResponseMin: avg(raw),
    // Só é "sem resposta" se a conversa está com a equipe (IA desligada) e já houve atendimento humano.
    unansweredMin: pendingFrom && opts.humanOwns && humanMsgs > 0 ? businessMinutes(pendingFrom, now) : null,
  };
}

/** Rapidez pela média de resposta em horário comercial. */
export function speedLabel(m: AttendanceMetrics): 'rapido' | 'ok' | 'lento' {
  const ref = Math.max(m.avgResponseMin ?? 0, m.unansweredMin ?? 0);
  if (ref <= 10) return 'rapido';
  if (ref <= 60) return 'ok';
  return 'lento';
}

/* --------------------------------- IA --------------------------------- */

const SYSTEM = `Você avalia a qualidade do atendimento de advogados/equipe de um escritório de advocacia no WhatsApp, para o dono do escritório melhorar o time.
Você recebe a conversa com um lead que veio de anúncio (Lead = cliente; IA = assistente automático do escritório; Advogado = atendimento humano) e métricas de tempo de resposta (minutos em horário comercial).

Avalie SOMENTE as mensagens do Advogado. As mensagens da IA servem apenas de contexto.
Observe: rapidez; se respondeu o que o lead perguntou; clareza e empatia; erros de informação, de português ou de tom; se conduziu para o próximo passo (documentos, consulta, contrato, honorários explicados); se deixou o lead sem resposta; ética da OAB (sem promessa de resultado, sem pressão).
Seja justo e específico: cite trechos curtos ou momentos da conversa. Não invente fatos.

Responda SOMENTE com JSON válido, sem texto fora dele. Dentro dos textos não use aspas duplas (use aspas simples) nem quebre linha:
{"nota":0-10,"veredito":"bom|regular|ruim","resumo":"2 a 3 frases","pontos_fortes":["..."],"erros":["..."],"faltou":["..."],"recomendacao":"o que o advogado deve fazer agora / na próxima vez"}`;

type Review = { score: number; verdict: string; summary: string; strengths: string[]; errors: string[]; missing: string[]; recommendation: string };

export function parseReview(raw: string): Review {
  const j = extractJson(raw) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 10) : []);
  const score = Math.max(0, Math.min(10, Math.round(Number(j.nota ?? j.score))));
  if (!Number.isFinite(score)) throw new Error('nota ausente');
  const v = String(j.veredito ?? j.verdict ?? '').toLowerCase();
  const verdict = v.includes('ruim') ? 'ruim' : v.includes('regular') ? 'regular' : v.includes('bom') ? 'bom' : score >= 7 ? 'bom' : score >= 5 ? 'regular' : 'ruim';
  return {
    score,
    verdict,
    summary: String(j.resumo ?? j.summary ?? '').trim().slice(0, 1500),
    strengths: list(j.pontos_fortes ?? j.strengths),
    errors: list(j.erros ?? j.errors),
    missing: list(j.faltou ?? j.missing),
    recommendation: String(j.recomendacao ?? j['recomendação'] ?? j.recommendation ?? '').trim().slice(0, 1500),
  };
}

function transcript(msgs: Msg[]): string {
  return msgs
    .filter((m) => m.author !== 'system' && m.body?.trim())
    .slice(-120)
    .map((m) => {
      const who = m.direction === 'in' ? 'Lead' : m.author === 'ai' ? 'IA' : 'Advogado';
      return `[${brParts(m.createdAt).label}] ${who}: ${m.body.trim().replace(/\s+/g, ' ').slice(0, 600)}`;
    })
    .join('\n');
}

/* ------------------------------- execução ------------------------------- */

export const finalStageIds = (csv: string) => new Set(csv.split(',').map((x) => x.trim()).filter(Boolean));

/** Etapas sugeridas como "final" (fechamento/perda) quando o cliente ainda não escolheu. */
export function suggestedFinalStage(name: string): boolean {
  return /assinad|fechad|ganho|contratad|perdid|desqualific|arquivad/i.test(name.normalize('NFD').replace(/[̀-ͯ]/g, ''));
}

const running = new Set<string>();

/** Analisa os leads de campanha elegíveis de um cliente. Devolve quantos foram analisados. */
export async function runAttendanceAnalysis(ws: string, opts: { max?: number } = {}): Promise<{ analyzed: number; skipped: number; errors: number }> {
  if (running.has(ws)) throw new Error('Já existe uma análise em andamento para este cliente.');
  const cfg = await prisma.aiConfig.findUnique({ where: { id: ws } });
  if (!cfg?.attendanceEnabled || !cfg.attendanceSince) throw new Error('A análise de atendimento está desligada para este cliente.');
  const llm = await resolveLlm(ws);
  if (!llm.ready) throw new Error('A IA da plataforma não está conectada.');

  running.add(ws);
  const max = opts.max ?? 40;
  let analyzed = 0;
  let skipped = 0;
  let errors = 0;
  try {
    const finals = finalStageIds(cfg.attendanceFinalStages);
    const convs = await prisma.conversation.findMany({
      where: { workspaceId: ws, campaignSource: { not: null }, campaignAt: { gte: cfg.attendanceSince } },
      orderBy: { lastMessageAt: 'desc' },
      take: 300,
      select: { id: true, contactId: true, aiEnabled: true, lastMessageAt: true, campaignAt: true },
    });

    for (const conv of convs) {
      if (analyzed >= max) break;
      const prev = await prisma.attendanceReview.findUnique({ where: { conversationId: conv.id } });
      if (prev?.final) continue; // já chegou na etapa final: encerrado
      if (prev && prev.analyzedUntil >= conv.lastMessageAt) continue; // nada novo

      const deal = await prisma.deal.findFirst({ where: { workspaceId: ws, contactId: conv.contactId }, orderBy: { updatedAt: 'desc' } });
      const isFinal = Boolean(deal?.stageId && finals.has(deal.stageId));

      // Só a partir do gatilho (não olha o histórico anterior da conversa).
      const msgs = await prisma.message.findMany({
        where: { conversationId: conv.id, createdAt: { gte: conv.campaignAt ?? cfg.attendanceSince } },
        orderBy: { createdAt: 'asc' },
        select: { direction: true, author: true, createdAt: true, body: true },
      });
      const metrics = responseMetrics(msgs, { humanOwns: !conv.aiEnabled });
      if (metrics.humanMsgs === 0) {
        skipped++; // ainda não houve atendimento humano: nada a avaliar
        continue;
      }

      try {
        const stage = deal?.stageId ? await prisma.pipelineStage.findUnique({ where: { id: deal.stageId }, select: { name: true } }) : null;
        const payload =
          `Etapa atual do lead no CRM: ${stage?.name ?? 'sem etapa'}\n` +
          `Métricas (minutos, horário comercial 8h-20h seg-sáb): ${JSON.stringify(metrics)}\n\nConversa:\n${transcript(msgs)}`;
        const r = await askJson(llm, SYSTEM, payload, parseReview, 2500);
        const data = {
          score: r.score,
          verdict: r.verdict,
          speed: speedLabel(metrics),
          metrics: JSON.stringify(metrics),
          summary: r.summary,
          strengths: JSON.stringify(r.strengths),
          errors: JSON.stringify(r.errors),
          missing: JSON.stringify(r.missing),
          recommendation: r.recommendation,
          analyzedUntil: conv.lastMessageAt,
          final: isFinal,
        };
        await prisma.attendanceReview.upsert({
          where: { conversationId: conv.id },
          update: data,
          create: { workspaceId: ws, conversationId: conv.id, ...data },
        });
        analyzed++;
      } catch (err) {
        errors++;
        console.error(`[atendimento:${ws}] falha ao analisar ${conv.id}:`, (err as Error).message);
      }
    }
    return { analyzed, skipped, errors };
  } finally {
    running.delete(ws);
  }
}

/* -------------------------------- agendador -------------------------------- */

const RUN_HOUR = 19; // fim do expediente
let timer: NodeJS.Timeout | null = null;

export async function runScheduledAttendanceOnce() {
  const now = brNow();
  if (now.hour < RUN_HOUR) return;
  const cfgs = await prisma.aiConfig.findMany({ where: { attendanceEnabled: true }, select: { id: true, attendanceLastRun: true } });
  for (const c of cfgs) {
    if (c.attendanceLastRun === now.date) continue;
    await prisma.aiConfig.update({ where: { id: c.id }, data: { attendanceLastRun: now.date } });
    const r = await runAttendanceAnalysis(c.id).catch((e) => {
      console.error(`[atendimento:${c.id}] rodada diária falhou:`, (e as Error).message);
      return null;
    });
    if (r) console.log(`[atendimento:${c.id}] rodada diária: ${r.analyzed} analisados, ${r.skipped} sem atendimento humano, ${r.errors} erros`);
  }
}

export function startAttendanceLoop() {
  if (timer) return;
  timer = setInterval(() => void runScheduledAttendanceOnce().catch((e) => console.error('[atendimento] ciclo falhou:', e)), 15 * 60_000);
  timer.unref();
  setTimeout(() => void runScheduledAttendanceOnce().catch(() => {}), 90_000);
}
