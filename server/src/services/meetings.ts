/**
 * Reuniões na Agenda.
 *
 * Sempre que uma mensagem da conversa fala de agendamento (do lead, da IA ou do
 * advogado), uma IA lê o trecho recente e decide se ficou combinada uma reunião com
 * dia e hora. Se sim, cria (ou remarca) o evento da Agenda ligado ao lead:
 *   "Reunião: <nome do lead>"  ·  data  ·  início/fim  ·  notas com telefone e resumo.
 *
 * Um evento automático por conversa: se a data mudar (remarcação), o mesmo evento é
 * atualizado. Evento criado ou movido à mão na Agenda (source "manual") não é tocado.
 * Também roda em lote para conversas antigas (backfillMeetings).
 */
import { prisma } from '../db.js';
import { emit } from '../realtime.js';
import { resolveCrmLlm, resolveLlm } from './llm.js';
import { extractJson } from './llmJson.js';

/** Palavras que indicam agendamento: só nessas mensagens chamamos a IA. */
const HINT = /agend|reuni[aã]o|marc(?:ar|ad[oa]|amos)|consulta|hor[aá]rio|atendimento (?:online|presencial)|\b(?:amanh[aã]|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado)\b|\b\d{1,2}\s?(?:h|hs|:\d{2})\b|\b\d{1,2}\/\d{1,2}\b|v[ií]deo ?chamada|meet|zoom/i;

export function looksLikeScheduling(text: string): boolean {
  return HINT.test(text || '');
}

const fmtBr = (d: Date) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);

const SYSTEM = [
  'Você lê conversas de WhatsApp entre um escritório de advocacia (IA ou advogado) e um lead e diz se ficou AGENDADA uma reunião/consulta/ligação com o advogado.',
  'Cada mensagem traz a data e a hora em que foi enviada (horário de Brasília): use-as para resolver "amanhã", "segunda", "dia 12" etc.',
  'Considere agendado SOMENTE quando há um DIA definido e as duas partes concordaram (ou o escritório confirmou: "agendado", "fica marcado", "confirmado para…"). Preferência vaga ("de manhã", "semana que vem", "o advogado vai confirmar o horário") NÃO é agendamento; se o lead escolheu dia e hora e o escritório aceitou, é.',
  'Se a reunião foi remarcada, use a data MAIS RECENTE combinada. Se foi desmarcada/cancelada, agendado=false.',
  'Responda APENAS um JSON, sem texto fora dele:',
  '{"agendado": true|false, "data": "AAAA-MM-DD", "hora": "HH:MM" ou "", "modalidade": "online"|"presencial"|"ligação"|"", "resumo": "uma linha: assunto do caso e o que foi combinado"}',
].join('\n');

type Detected = { agendado: boolean; data?: string; hora?: string; modalidade?: string; resumo?: string };

async function detect(ws: string, conversationId: string): Promise<Detected | null> {
  const msgs = await prisma.message.findMany({
    where: { conversationId, author: { not: 'system' } },
    orderBy: { createdAt: 'desc' },
    take: 40,
    select: { direction: true, author: true, body: true, createdAt: true },
  });
  if (!msgs.length) return null;
  msgs.reverse();
  const transcript = msgs
    .filter((m) => m.body?.trim())
    .map((m) => `[${fmtBr(m.createdAt)}] ${m.direction === 'in' ? 'Lead' : m.author === 'ai' ? 'IA do escritório' : 'Advogado'}: ${m.body.trim().slice(0, 600)}`)
    .join('\n');
  const crm = await resolveCrmLlm(ws).catch(() => null);
  const llm = crm?.ready ? crm : await resolveLlm(ws);
  if (!llm.ready) return null;
  const raw = await llm.complete({ system: SYSTEM, messages: [{ role: 'user', content: `Agora: ${fmtBr(new Date())}\n\nConversa:\n${transcript}` }], maxTokens: 300 });
  const j = extractJson(raw) as Detected;
  if (typeof j?.agendado !== 'boolean') return null;
  return j;
}

const addMin = (hm: string, min: number) => {
  const [h, m] = hm.split(':').map(Number);
  const t = Math.min(23 * 60 + 59, h * 60 + m + min);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

/**
 * Lê a conversa e cria/atualiza a reunião na Agenda. Devolve o que fez.
 * `quiet`: não grava nota na conversa (lote de conversas antigas).
 */
export async function syncMeetingFromConversation(ws: string, conversationId: string, opts: { quiet?: boolean } = {}): Promise<'created' | 'moved' | 'same' | 'none'> {
  const conv = await prisma.conversation.findFirst({ where: { id: conversationId, workspaceId: ws }, include: { contact: true } });
  if (!conv) return 'none';
  const d = await detect(ws, conversationId);
  if (!d?.agendado || !/^\d{4}-\d{2}-\d{2}$/.test(d.data ?? '')) return 'none';
  const hora = /^\d{2}:\d{2}$/.test(d.hora ?? '') ? d.hora! : '';
  const start = hora || '09:00';
  const end = addMin(start, 60);
  const who = conv.contact.name?.trim() || conv.contact.phone;
  const title = `Reunião: ${who}`;
  const notes = [
    `Lead: ${who} · WhatsApp ${conv.contact.phone}`,
    d.modalidade ? `Modalidade: ${d.modalidade}` : '',
    hora ? '' : 'Horário a confirmar (a conversa não definiu a hora).',
    d.resumo ? `Resumo: ${String(d.resumo).slice(0, 300)}` : '',
    'Registrada automaticamente a partir da conversa no LawHub.',
  ]
    .filter(Boolean)
    .join('\n');

  const existing = await prisma.event.findFirst({ where: { workspaceId: ws, conversationId, source: { in: ['auto', 'manual'] } }, orderBy: { createdAt: 'desc' } });
  if (existing?.source === 'manual') return 'same'; // ajustado à mão na Agenda: não mexe
  let result: 'created' | 'moved' | 'same';
  if (existing) {
    if (existing.date === d.data && existing.start === start) return 'same';
    await prisma.event.update({ where: { id: existing.id }, data: { title, date: d.data!, start, end, notes } });
    result = 'moved';
  } else {
    await prisma.event.create({ data: { workspaceId: ws, title, date: d.data!, start, end, kind: 'meet', notes, contactId: conv.contactId, conversationId, source: 'auto' } });
    result = 'created';
  }
  emit(ws, { type: 'crm:update' });
  if (!opts.quiet) {
    const [y, m, dd] = d.data!.split('-');
    const body = `📅 Reunião ${result === 'moved' ? 'remarcada' : 'registrada'} na Agenda: ${dd}/${m}/${y}${hora ? ` às ${hora}` : ' (horário a confirmar)'}.`;
    const message = await prisma.message.create({ data: { conversationId, direction: 'out', author: 'system', body } });
    emit(ws, { type: 'message:new', conversationId, message });
  }
  return result;
}

/* ------------- disparo após cada mensagem (com espera para juntar) ------------- */

const timers = new Map<string, NodeJS.Timeout>();

/** Chamado a cada mensagem nova (lead, IA ou advogado). */
export function onMessageForMeetings(ws: string, conversationId: string, text: string) {
  if (!looksLikeScheduling(text)) return;
  const prev = timers.get(conversationId);
  if (prev) clearTimeout(prev);
  timers.set(
    conversationId,
    setTimeout(() => {
      timers.delete(conversationId);
      void syncMeetingFromConversation(ws, conversationId).catch((e) => console.error('[agenda] falhou:', (e as Error).message));
    }, 45_000),
  );
}

/* --------------------------- conversas antigas --------------------------- */

let backfillRunning = false;
export function backfillStatus() {
  return { running: backfillRunning, ...lastBackfill };
}
let lastBackfill: { checked: number; created: number; moved: number; at?: string; scope?: string } = { checked: 0, created: 0, moved: 0 };

/**
 * Passa pelas conversas antigas e registra as reuniões combinadas.
 * scope "forms": só leads que vieram de formulário (padrão); "all": todas com indício.
 */
export async function backfillMeetings(scope: 'forms' | 'all' = 'forms', days = 120) {
  if (backfillRunning) return;
  backfillRunning = true;
  lastBackfill = { checked: 0, created: 0, moved: 0, scope };
  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60_000);
    const formContacts =
      scope === 'forms'
        ? new Set((await prisma.leadFormEntry.findMany({ where: { contactId: { not: null }, createdAt: { gte: since } }, select: { contactId: true } })).map((e) => e.contactId!))
        : null;
    const convs = await prisma.conversation.findMany({
      where: { lastMessageAt: { gte: since }, workspaceId: { not: null } },
      select: { id: true, workspaceId: true, contactId: true },
      orderBy: { lastMessageAt: 'desc' },
    });
    for (const c of convs) {
      if (formContacts && !formContacts.has(c.contactId)) continue;
      const hit = await prisma.message.findMany({ where: { conversationId: c.id, author: { not: 'system' } }, select: { body: true }, take: 200 });
      if (!hit.some((m) => looksLikeScheduling(m.body))) continue;
      lastBackfill.checked++;
      try {
        const r = await syncMeetingFromConversation(c.workspaceId!, c.id, { quiet: true });
        if (r === 'created') lastBackfill.created++;
        if (r === 'moved') lastBackfill.moved++;
      } catch (e) {
        console.error('[agenda] lote:', (e as Error).message);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  } finally {
    lastBackfill.at = new Date().toISOString();
    backfillRunning = false;
    console.log(`[agenda] lote concluído: ${JSON.stringify(lastBackfill)}`);
  }
}
