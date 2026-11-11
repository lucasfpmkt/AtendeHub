/**
 * Reativação de leads antigos (follow-up personalizado para quem esfriou).
 *
 * 1. "Gerar": escolhe os leads parados (etapas, dias sem conversa, limite) e, para
 *    cada um, a IA lê a conversa e escreve UMA mensagem só para ele — cita o que ele
 *    contou (banco, tipo de dívida, situação) e usa técnicas de venda dentro dos
 *    limites da OAB (sem promessa, sem urgência falsa). Também diz quando NÃO vale
 *    mandar (robô de empresa, já disse que não quer, já é cliente).
 * 2. A equipe revisa: edita o texto, tira quem não deve receber.
 * 3. "Iniciar": envia aos poucos (padrão 20/hora), seg–sáb 8h–20h, só com o WhatsApp
 *    conectado. Quem responder volta para a IA; quem disser que não quer vai para
 *    Perdido (mesma regra do follow-up automático).
 */
import { prisma } from '../db.js';
import { emit } from '../realtime.js';
import { getStatus, sendText } from '../whatsapp/session.js';
import { resolveLlm } from './llm.js';
import { extractJson } from './llmJson.js';
import { getActiveTriage, getAgent, parseFaq } from './agents.js';

export type ReactivationFilters = { stageIds?: string[]; minDays?: number; maxDays?: number; limit?: number };

const NOTE_PREFIX = '⏰ Follow-up automático (reativação)';

const fmtBr = (d: Date) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);

function businessHoursNow(): boolean {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: '2-digit', hour12: false })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  const hour = Number(p.hour) % 24;
  return p.weekday !== 'Sun' && hour >= 8 && hour < 20;
}

/* ------------------------------- candidatos ------------------------------- */

async function candidates(ws: string, f: ReactivationFilters) {
  const minDays = Math.max(1, f.minDays ?? 3);
  const maxDays = Math.min(365, Math.max(minDays + 1, f.maxDays ?? 90));
  const limit = Math.min(200, Math.max(1, f.limit ?? 50));
  const now = Date.now();
  const stages = await prisma.pipelineStage.findMany({ where: { workspaceId: ws }, select: { id: true, name: true } });
  // Etapas finais nunca entram, mesmo se escolhidas sem querer.
  const finais = new Set(stages.filter((s) => /perdid|fechad|ganh|desqualific|assinad|j[aá] [eé] cliente|sem interesse|n[aã]o tem interesse/i.test(s.name)).map((s) => s.id));
  const wanted = (f.stageIds ?? []).filter((id) => !finais.has(id));

  const convs = await prisma.conversation.findMany({
    where: {
      workspaceId: ws,
      lastMessageAt: { gte: new Date(now - maxDays * 86_400_000), lte: new Date(now - minDays * 86_400_000) },
      contact: { waJid: { not: { endsWith: '@g.us' } } },
    },
    include: { contact: true },
    orderBy: { lastMessageAt: 'desc' },
    take: 2000,
  });
  const out: typeof convs = [];
  const seen = new Set<string>();
  for (const c of convs) {
    if (out.length >= limit) break;
    if (seen.has(c.contactId)) continue;
    seen.add(c.contactId);
    const tags = (c.contact.tags ?? '').toLowerCase();
    if (/sem interesse|n[uú]mero errado|n[aã]o quis seguir|perdido|cliente/.test(tags)) continue;
    const deal = await prisma.deal.findFirst({ where: { workspaceId: ws, contactId: c.contactId }, orderBy: { createdAt: 'desc' }, select: { stageId: true } });
    if (!deal) continue; // só quem está no funil (lead de verdade)
    if (finais.has(deal.stageId)) continue;
    if (wanted.length && !wanted.includes(deal.stageId)) continue;
    // Já recebeu reativação nos últimos 30 dias: não repete.
    const recent = await prisma.message.findFirst({ where: { conversationId: c.id, author: 'system', body: { startsWith: NOTE_PREFIX }, createdAt: { gte: new Date(now - 30 * 86_400_000) } }, select: { id: true } });
    if (recent) continue;
    out.push(c);
  }
  return out;
}

/* ------------------------------- redação ------------------------------- */

const SYSTEM = (office: string) =>
  [
    'Você escreve mensagens de WhatsApp para RETOMAR o contato com leads que conversaram com um escritório de advocacia e pararam de responder.',
    'Seu objetivo é fazer o lead responder e seguir para a conversa com o advogado, com uma mensagem que pareça escrita por uma pessoa para ELE, não um disparo em massa.',
    '',
    'Técnicas (use com naturalidade, sem citar nomes de técnicas):',
    '• Personalização: chame pelo primeiro nome (se souber) e cite o que ELE contou — banco, tipo de dívida, valor, situação. Nunca invente detalhe que não está na conversa.',
    '• Lembrança + empatia: lembre em poucas palavras por que ele procurou o escritório e mostre que entende a situação.',
    '• Valor concreto: diga o que o escritório pode fazer por ele agora (ex.: analisar o caso e explicar as possibilidades), usando só o que está nos dados do escritório.',
    '• Facilidade: termine com UMA pergunta fácil de responder (sim/não, ou manhã/tarde para conversar com o advogado).',
    '• Leveza: dê uma saída educada ("se já resolveu, me avisa que eu encerro por aqui") — isso aumenta a resposta e respeita o lead.',
    '',
    'Limites obrigatórios (ética da OAB): não prometa resultado, valor, desconto ou prazo; não diga que ele "tem direito" ou "vai ganhar"; sem urgência falsa ("última chance", "só hoje"); não fale de honorários ou gratuidade que não estejam nos dados do escritório; não peça documentos nem dados pessoais.',
    'Forma: português do Brasil, 2 a 4 frases curtas, no máximo ~400 caracteres, no máximo 1 emoji, sem markdown, sem assinatura (o WhatsApp já é do escritório). Não comece com "Olá, tudo bem?" genérico: comece pelo nome e pelo assunto dele.',
    '',
    'NÃO mande (pular=true) quando a conversa mostrar: robô/resposta automática de empresa (horário de atendimento, "agradece seu contato", cardápio etc.); o lead já disse que não tem interesse, que já resolveu ou que contratou outro; já é cliente do escritório; o assunto não tem nada a ver com o escritório; pessoa pediu para não ser contatada.',
    '',
    `Dados do escritório (use só isto como fato):\n${office || '(sem dados extras)'}`,
    '',
    'Responda APENAS um JSON: {"pular": true|false, "motivo": "se pular, por quê (curto)", "resumo": "uma linha: quem é e o que queria", "mensagem": "o texto a enviar"}',
  ].join('\n');

async function officeFacts(ws: string, agentId: string | null): Promise<string> {
  const agent = (agentId && (await getAgent(ws, agentId))) || (await getActiveTriage(ws));
  if (!agent) return '';
  const faq = parseFaq(agent.faq).slice(0, 15).map((f) => `P: ${f.q} R: ${f.a}`).join('\n');
  // Começo do roteiro: costuma trazer quem é a assistente, o advogado e a oferta (ex.: análise sem custo).
  return [agent.script.slice(0, 1800), faq].filter(Boolean).join('\n\n');
}

async function draftFor(ws: string, conv: { id: string; contactId: string; assignedAgentId: string | null; contact: { name: string | null; phone: string } }) {
  const msgs = await prisma.message.findMany({
    where: { conversationId: conv.id, author: { not: 'system' } },
    orderBy: { createdAt: 'desc' },
    take: 40,
    select: { direction: true, author: true, body: true, createdAt: true },
  });
  msgs.reverse();
  const form = await prisma.leadFormEntry.findFirst({ where: { workspaceId: ws, contactId: conv.contactId }, orderBy: { createdAt: 'desc' }, select: { answers: true } }).catch(() => null);
  const transcript = msgs
    .filter((m) => m.body?.trim())
    .map((m) => `[${fmtBr(m.createdAt)}] ${m.direction === 'in' ? 'Lead' : m.author === 'ai' ? 'Escritório (IA)' : 'Escritório'}: ${m.body.trim().slice(0, 500)}`)
    .join('\n');
  const llm = await resolveLlm(ws);
  if (!llm.ready) throw new Error('IA não configurada');
  const user = [
    `Nome do lead no WhatsApp/formulário: ${conv.contact.name?.trim() || '(sem nome)'}`,
    form?.answers && form.answers !== '[]' ? `Respostas do formulário do anúncio: ${String(form.answers).slice(0, 800)}` : '',
    `Hoje: ${fmtBr(new Date())}`,
    '',
    `Conversa:\n${transcript || '(o lead preencheu o formulário e nunca respondeu)'}`,
  ]
    .filter(Boolean)
    .join('\n');
  const raw = await llm.complete({ system: SYSTEM(await officeFacts(ws, conv.assignedAgentId)), messages: [{ role: 'user', content: user }], maxTokens: 500 });
  const j = extractJson(raw) as { pular?: boolean; motivo?: string; resumo?: string; mensagem?: string };
  return {
    skip: Boolean(j.pular) || !String(j.mensagem ?? '').trim(),
    reason: String(j.motivo ?? '').slice(0, 200),
    summary: String(j.resumo ?? '').slice(0, 300),
    text: String(j.mensagem ?? '').replace(/\*\*(.+?)\*\*/g, '*$1*').trim().slice(0, 900),
  };
}

/* ------------------------------- jobs ------------------------------- */

export async function createReactivation(ws: string, filters: ReactivationFilters) {
  const running = await prisma.reactivationJob.findFirst({ where: { workspaceId: ws, status: { in: ['generating', 'running'] } } });
  if (running) throw new Error(running.status === 'generating' ? 'Já há uma reativação sendo preparada.' : 'Já há uma reativação enviando. Pause ou cancele antes de criar outra.');
  const job = await prisma.reactivationJob.create({ data: { workspaceId: ws, filters: JSON.stringify(filters) } });
  void generate(ws, job.id, filters).catch(async (err) => {
    console.error('[reativação] geração falhou:', (err as Error).message);
    await prisma.reactivationJob.update({ where: { id: job.id }, data: { status: 'draft' } }).catch(() => {});
  });
  return job;
}

async function generate(ws: string, jobId: string, filters: ReactivationFilters) {
  const list = await candidates(ws, filters);
  for (const c of list) {
    const job = await prisma.reactivationJob.findUnique({ where: { id: jobId }, select: { status: true } });
    if (!job || job.status !== 'generating') return; // cancelada no meio
    try {
      const d = await draftFor(ws, c);
      await prisma.reactivationItem.create({
        data: {
          jobId,
          workspaceId: ws,
          conversationId: c.id,
          contactId: c.contactId,
          name: c.contact.name?.trim() || c.contact.phone,
          lastActivity: c.lastMessageAt,
          context: d.summary,
          text: d.text,
          status: d.skip ? 'excluded' : 'pending',
          note: d.skip ? `IA sugeriu não enviar: ${d.reason || 'sem motivo'}` : '',
        },
      });
    } catch (err) {
      await prisma.reactivationItem.create({
        data: { jobId, workspaceId: ws, conversationId: c.id, contactId: c.contactId, name: c.contact.name?.trim() || c.contact.phone, lastActivity: c.lastMessageAt, status: 'excluded', note: `Falha ao gerar: ${(err as Error).message.slice(0, 120)}` },
      });
    }
    emit(ws, { type: 'crm:update' });
  }
  await prisma.reactivationJob.update({ where: { id: jobId }, data: { status: 'draft' } });
  emit(ws, { type: 'crm:update' });
}

/* ------------------------------- envio ------------------------------- */

async function sendOne(ws: string, jobCreatedAt: Date, item: { id: string; conversationId: string; text: string }) {
  const conv = await prisma.conversation.findUnique({ where: { id: item.conversationId }, include: { contact: true } });
  if (!conv) return prisma.reactivationItem.update({ where: { id: item.id }, data: { status: 'skipped', note: 'Conversa não existe mais' } });
  // O lead escreveu depois que a lista foi gerada: já voltou sozinho, não manda.
  const replied = await prisma.message.findFirst({ where: { conversationId: conv.id, direction: 'in', createdAt: { gt: jobCreatedAt } }, select: { id: true } });
  if (replied) return prisma.reactivationItem.update({ where: { id: item.id }, data: { status: 'skipped', note: 'O lead respondeu antes do envio' } });
  try {
    const waMessageId = await sendText(ws, conv.contact.waJid, item.text);
    const message = await prisma.message.create({ data: { conversationId: conv.id, direction: 'out', author: 'ai', body: item.text, waMessageId } });
    // Reabre a conversa e deixa a IA pronta para a resposta do lead.
    const agentId = conv.assignedAgentId ?? (await getActiveTriage(ws))?.id ?? null;
    const updated = await prisma.conversation.update({
      where: { id: conv.id },
      data: { lastMessageAt: new Date(), status: 'open', ...(agentId ? { aiEnabled: true, aiPausedBy: null, assignedAgentId: agentId } : {}) },
    });
    // Mesmo prefixo do follow-up: "não tenho interesse" em resposta vai para Perdido sozinho.
    const note = await prisma.message.create({ data: { conversationId: conv.id, direction: 'out', author: 'system', body: `${NOTE_PREFIX} enviado.` } });
    emit(ws, { type: 'message:new', conversationId: conv.id, message });
    emit(ws, { type: 'message:new', conversationId: conv.id, message: note });
    emit(ws, { type: 'conversation:update', conversation: updated });
    await prisma.reactivationItem.update({ where: { id: item.id }, data: { status: 'sent', sentAt: new Date() } });
  } catch (err) {
    await prisma.reactivationItem.update({ where: { id: item.id }, data: { status: 'failed', note: (err as Error).message.slice(0, 200) } });
  }
}

let ticking = false;
async function tick() {
  if (ticking || !businessHoursNow()) return;
  ticking = true;
  try {
    const jobs = await prisma.reactivationJob.findMany({ where: { status: 'running' } });
    for (const job of jobs) {
      if (getStatus(job.workspaceId).status !== 'connected') continue;
      const last = await prisma.reactivationItem.findFirst({ where: { jobId: job.id, status: 'sent' }, orderBy: { sentAt: 'desc' }, select: { sentAt: true } });
      const gap = Math.round(3600_000 / Math.max(1, Math.min(60, job.perHour)));
      // Intervalo com variação (±25%) para não parecer robô.
      const jitter = gap * (0.75 + Math.random() * 0.5);
      if (last?.sentAt && Date.now() - last.sentAt.getTime() < jitter) continue;
      const next = await prisma.reactivationItem.findFirst({ where: { jobId: job.id, status: 'pending' }, orderBy: { createdAt: 'asc' } });
      if (!next) {
        await prisma.reactivationJob.update({ where: { id: job.id }, data: { status: 'done' } });
        emit(job.workspaceId, { type: 'crm:update' });
        continue;
      }
      await sendOne(job.workspaceId, job.createdAt, next);
      emit(job.workspaceId, { type: 'crm:update' });
    }
  } finally {
    ticking = false;
  }
}

let started = false;
export function startReactivationLoop() {
  if (started) return;
  started = true;
  // Geração interrompida por reinício do servidor: libera para revisão.
  void prisma.reactivationJob.updateMany({ where: { status: 'generating' }, data: { status: 'draft' } }).catch(() => {});
  setInterval(() => void tick().catch((e) => console.error('[reativação] ciclo:', (e as Error).message)), 60_000);
}
