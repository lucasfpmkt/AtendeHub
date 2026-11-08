/**
 * Alertas operacionais pelo WhatsApp.
 *
 * Duas direções:
 *  - alertAdmin: para quem opera a plataforma (número em Configurações › Clientes ›
 *    Alertas). Sai pelo WhatsApp de um cliente conectado (o escolhido ou o primeiro).
 *  - alertOffice: para o escritório (número de Avisos do cliente). Sai pelo WhatsApp
 *    do próprio cliente; se ele estiver caído, pelo mesmo canal do administrador.
 *
 * Cada tipo de alerta tem um intervalo mínimo entre repetições, para não virar spam
 * quando o mesmo problema se repete a cada chamada.
 */
import { prisma } from '../db.js';
import { getPlatformConfig } from './platform.js';

const lastSent = new Map<string, number>();
const HOUR = 60 * 60_000;

function cooled(key: string, ms: number): boolean {
  const now = Date.now();
  const prev = lastSent.get(key) ?? 0;
  if (now - prev < ms) return false;
  lastSent.set(key, now);
  // mapa não cresce sem limite
  if (lastSent.size > 5000) for (const [k, t] of lastSent) if (now - t > 24 * HOUR) lastSent.delete(k);
  return true;
}

/** Número informado nas configurações → JID (assume Brasil sem DDI). */
export function jidFromNumber(raw: string): string | null {
  let d = (raw ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return d.length >= 12 && d.length <= 15 ? `${d}@s.whatsapp.net` : null;
}

/** Cliente cujo WhatsApp envia os alertas do administrador: o configurado ou o primeiro conectado. */
async function senderWorkspace(preferred: string): Promise<string | null> {
  const { getStatus } = await import('../whatsapp/session.js');
  if (preferred && getStatus(preferred).status === 'connected') return preferred;
  const all = await prisma.workspace.findMany({ where: { active: true }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  for (const w of all) if (getStatus(w.id).status === 'connected') return w.id;
  return null;
}

async function send(ws: string, to: string, text: string) {
  const { sendText } = await import('../whatsapp/session.js');
  await sendText(ws, to, text);
}

/**
 * Alerta para o administrador da plataforma. `kind` identifica o problema (ex.:
 * "llm_billing", "wa_down:<ws>") e controla a repetição.
 */
export async function alertAdmin(kind: string, text: string, opts: { cooldownMs?: number } = {}): Promise<boolean> {
  if (!cooled(`admin:${kind}`, opts.cooldownMs ?? HOUR)) return false;
  try {
    const cfg = await getPlatformConfig();
    const ws = await senderWorkspace(cfg.alertWorkspaceId);
    if (!ws) {
      console.warn(`[alerta] sem WhatsApp conectado para avisar o administrador: ${kind}`);
      return false;
    }
    const { ownJid } = await import('../whatsapp/session.js');
    const to = jidFromNumber(cfg.alertNumber) ?? ownJid(ws);
    if (!to) return false;
    await send(ws, to, `🚨 *LawHub*\n\n${text}`);
    console.log(`[alerta] administrador avisado: ${kind}`);
    return true;
  } catch (err) {
    console.error('[alerta] falha ao avisar o administrador:', (err as Error).message);
    return false;
  }
}

/** Alerta para o escritório (número de Avisos do cliente). */
export async function alertOffice(ws: string, kind: string, text: string, opts: { cooldownMs?: number } = {}): Promise<boolean> {
  if (!cooled(`office:${ws}:${kind}`, opts.cooldownMs ?? HOUR)) return false;
  try {
    const ai = await prisma.aiConfig.findUnique({ where: { id: ws }, select: { notifyNumber: true } });
    const { getStatus, ownJid } = await import('../whatsapp/session.js');
    const own = getStatus(ws).status === 'connected';
    const to = jidFromNumber(ai?.notifyNumber ?? '') ?? (own ? ownJid(ws) : null);
    if (!to) return false;
    // Pelo WhatsApp do próprio escritório; se ele estiver caído, pelo canal do administrador.
    const via = own ? ws : await senderWorkspace((await getPlatformConfig()).alertWorkspaceId);
    if (!via) return false;
    await send(via, to, `🔔 *LawHub*\n\n${text}`);
    return true;
  } catch (err) {
    console.error(`[alerta:${ws}] falha ao avisar o escritório:`, (err as Error).message);
    return false;
  }
}

/* ------------------------------ IA (provedor) ----------------------------- */

/** Classifica um erro do provedor de IA e avisa o administrador quando for cobrança, chave ou indisponibilidade. */
export function reportLlmFailure(provider: string, model: string, err: unknown) {
  const e = err as { status?: number; message?: string };
  const msg = String(e?.message ?? err ?? '');
  const status = Number(e?.status ?? (msg.match(/\b(4\d\d|5\d\d)\b/)?.[1] ?? 0));
  const low = msg.toLowerCase();
  let kind = '';
  let text = '';
  if (/credit balance|billing|insufficient_quota|quota exceeded|payment/i.test(msg)) {
    kind = 'llm_billing';
    text = `A IA parou por falta de saldo no provedor *${provider}* (${model}). Nenhum lead está sendo respondido até recarregar.\n\nErro: ${msg.slice(0, 200)}`;
  } else if (status === 401 || status === 403 || /invalid x-api-key|authentication|invalid api key|unauthorized/.test(low)) {
    kind = 'llm_auth';
    text = `A chave da IA (*${provider}*) foi recusada. Confira em Clientes › IA da plataforma.\n\nErro: ${msg.slice(0, 200)}`;
  } else if (status === 429) {
    kind = 'llm_rate';
    text = `O provedor de IA (*${provider}*) está limitando as chamadas (429). As respostas vão atrasar até normalizar.`;
  } else if (status >= 500 || /econnreset|etimedout|fetch failed|timeout|overloaded/.test(low)) {
    kind = 'llm_down';
    text = `O provedor de IA (*${provider}*) está instável (${status || 'sem resposta'}). O LawHub tenta de novo sozinho; se persistir, troque o modelo.`;
  }
  if (!kind) return;
  void alertAdmin(kind, text, { cooldownMs: kind === 'llm_rate' || kind === 'llm_down' ? 30 * 60_000 : HOUR });
}

/* --------------------------------- WhatsApp -------------------------------- */

const downTimers = new Map<string, ReturnType<typeof setTimeout>>();
const downAlerted = new Set<string>();

/**
 * Chamado a cada mudança de status da sessão. Só avisa quando um número que ESTAVA
 * conectado fica fora por mais de 2 minutos (reinício do servidor não dispara), e
 * avisa de novo quando volta.
 */
export function trackWaStatus(ws: string, prev: string, next: string, detail?: string) {
  const t = downTimers.get(ws);
  if (next === 'connected') {
    if (t) clearTimeout(t);
    downTimers.delete(ws);
    if (downAlerted.delete(ws)) {
      void withWorkspaceName(ws, (name) => alertAdmin(`wa_up:${ws}`, `✅ O WhatsApp de *${name}* voltou a conectar.`, { cooldownMs: 0 }));
    }
    return;
  }
  if (prev !== 'connected' || t) return;
  downTimers.set(
    ws,
    setTimeout(async () => {
      downTimers.delete(ws);
      const { getStatus } = await import('../whatsapp/session.js');
      if (getStatus(ws).status === 'connected') return;
      downAlerted.add(ws);
      await withWorkspaceName(ws, async (name) => {
        const why = detail ? `\nMotivo: ${detail}` : '';
        await alertAdmin(`wa_down:${ws}`, `⚠️ O WhatsApp de *${name}* está desconectado há mais de 2 minutos. Leads não estão sendo respondidos.${why}\n\nAbra Conectar WhatsApp no LawHub do cliente.`, { cooldownMs: 30 * 60_000 });
        await alertOffice(ws, 'wa_down', `⚠️ O WhatsApp do escritório desconectou do LawHub e os leads não estão sendo respondidos. Abra o LawHub › Conectar WhatsApp e escaneie o QR de novo.`, { cooldownMs: 30 * 60_000 });
      });
    }, 2 * 60_000),
  );
}

/** Aparelho desvinculado (precisa de QR novo): avisa na hora. */
export function reportWaLoggedOut(ws: string) {
  void withWorkspaceName(ws, async (name) => {
    await alertAdmin(`wa_logout:${ws}`, `⛔ O WhatsApp de *${name}* foi desvinculado (aparelho saiu da sessão). É preciso escanear o QR de novo no LawHub do cliente.`, { cooldownMs: 10 * 60_000 });
    await alertOffice(ws, 'wa_logout', `⛔ O WhatsApp do escritório foi desvinculado do LawHub. Abra o LawHub › Conectar WhatsApp e escaneie o QR de novo para a IA voltar a atender.`, { cooldownMs: 10 * 60_000 });
  });
}

async function withWorkspaceName(ws: string, fn: (name: string) => Promise<unknown>) {
  const w = await prisma.workspace.findUnique({ where: { id: ws }, select: { name: true } }).catch(() => null);
  await fn(w?.name ?? ws);
}

/* --------------------------- Leads sem resposta --------------------------- */

const WAIT_MIN = 30;
const waitAlerted = new Map<string, number>(); // conversationId → quando avisou

function businessHoursNow(): boolean {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', hour12: false })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  const hour = Number(p.hour) % 24;
  return p.weekday !== 'Sun' && hour >= 8 && hour < 20;
}

/**
 * Leads cuja última mensagem é deles, há mais de 30 min, em conversa que a IA não vai
 * responder (IA desligada ou pausada). Avisa o escritório em lote, no máximo a cada
 * hora, e cada conversa no máximo a cada 3 horas. Só em horário comercial.
 */
export async function checkWaitingLeads() {
  if (!businessHoursNow()) return;
  const now = Date.now();
  const since = new Date(now - 48 * HOUR);
  const until = new Date(now - WAIT_MIN * 60_000);
  const workspaces = await prisma.workspace.findMany({ where: { active: true }, select: { id: true } });
  for (const { id: ws } of workspaces) {
    try {
      // Só conversas de LEAD: a IA chegou a atender e foi pausada, ou o contato está no
      // funil. Conversa pessoal do advogado (sem IA e sem negócio) não gera aviso.
      const convs = await prisma.conversation.findMany({
        where: {
          workspaceId: ws,
          status: { not: 'closed' },
          lastMessageAt: { gte: since, lte: until },
          OR: [{ aiPausedBy: { not: null } }, { aiEnabled: false, contact: { deals: { some: {} } } }],
        },
        include: { contact: { select: { name: true, phone: true } } },
        orderBy: { lastMessageAt: 'asc' },
        take: 100,
      });
      const waiting: { name: string; minutes: number }[] = [];
      for (const c of convs) {
        const last = await prisma.message.findFirst({
          where: { conversationId: c.id, author: { not: 'system' } },
          orderBy: { createdAt: 'desc' },
          select: { direction: true, createdAt: true },
        });
        if (!last || last.direction !== 'in') continue;
        const prev = waitAlerted.get(c.id) ?? 0;
        if (now - prev < 3 * HOUR) continue;
        waiting.push({ name: c.contact?.name?.trim() || `+${c.contact?.phone ?? ''}`, minutes: Math.round((now - last.createdAt.getTime()) / 60_000) });
        waitAlerted.set(c.id, now);
      }
      if (!waiting.length) continue;
      const lines = waiting.slice(0, 8).map((w) => `• ${w.name} (há ${w.minutes >= 120 ? `${Math.round(w.minutes / 60)} h` : `${w.minutes} min`})`);
      const more = waiting.length > 8 ? `\n… e mais ${waiting.length - 8}.` : '';
      const ok = await alertOffice(
        ws,
        'leads_waiting',
        `⏳ ${waiting.length === 1 ? '1 lead está' : `${waiting.length} leads estão`} esperando resposta há mais de ${WAIT_MIN} minutos:\n${lines.join('\n')}${more}\n\nAbra o LawHub › Conversas para responder.`,
        { cooldownMs: HOUR },
      );
      if (!ok) for (const c of convs) waitAlerted.delete(c.id); // não enviou: tenta de novo no próximo ciclo
    } catch (err) {
      console.error(`[alerta:${ws}] leads sem resposta:`, (err as Error).message);
    }
  }
  if (waitAlerted.size > 5000) for (const [k, t] of waitAlerted) if (now - t > 24 * HOUR) waitAlerted.delete(k);
}

let loopStarted = false;
export function startAlertsLoop() {
  if (loopStarted) return;
  loopStarted = true;
  setTimeout(() => void checkWaitingLeads().catch(() => {}), 3 * 60_000); // 3 min após subir
  setInterval(() => void checkWaitingLeads().catch(() => {}), 5 * 60_000);
}
