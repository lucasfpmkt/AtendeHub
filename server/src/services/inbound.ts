import { prisma } from '../db.js';
import { queueAvatar } from './avatars.js';
import { canonicalJid } from './leadForms.js';
import { emit } from '../realtime.js';
import { saveMedia, kindLabel, type MediaKind } from '../whatsapp/media.js';
import { maybeFireQualifiedLead } from './metaAds.js';
import { maybeFireGoogleConversion } from './googleAds.js';
import { understandMedia, canUnderstand } from './mediaAI.js';
import { notifyQualifiedLead, notifyTeamWhatsApp } from './leadNotify.js';

/** Mídia recebida/enviada já baixada em memória. */
export type InboundMedia = { kind: MediaKind; mimetype: string; filename?: string; buffer: Buffer };

/** Salva a mídia e devolve os campos para gravar na mensagem. */
async function mediaFields(ws: string, media?: InboundMedia) {
  if (!media) return {};
  try {
    const mediaId = await saveMedia(ws, media.buffer);
    return { mediaType: media.kind, mediaId, mediaName: media.filename ?? null, mimeType: media.mimetype };
  } catch (err) {
    // Disco cheio/permissão: grava a mensagem mesmo assim (sem o arquivo) em vez de perdê-la.
    console.error(`[media:${ws}] falha ao salvar arquivo:`, (err as Error).message);
    return { mediaType: media.kind, mediaName: media.filename ?? null, mimeType: media.mimetype };
  }
}
import type { ChatTurn } from './llm.js';
import { resolveLlm, resolveCrmLlm, platformAutoStage } from './llm.js';
import {
  decideTarget,
  findAgentByName,
  getActiveThemeAgents,
  getActiveTriage,
  triageByTrigger,
  getAgent,
  logAgent,
  normalize,
  offlineReply,
  runAgent,
  scriptHasActions,
  matchesTrigger,
  matchByTriggers,
  type Agent,
} from './agents.js';

/** Contato que veio de formulário já tem o nome informado pelo próprio lead. */
async function hasFormName(ws: string, waJid: string) {
  const c = await prisma.contact.findUnique({ where: { workspaceId_waJid: { workspaceId: ws, waJid } }, select: { name: true, tags: true } });
  return Boolean(c?.name && /formul[aá]rio/i.test(c.tags ?? ''));
}

/**
 * Mensagem de formulário do Meta que abre direto no WhatsApp ("Olá! Preenchi seu
 * formulário…" + linhas "Pergunta?: resposta"). É lead de anúncio: a IA assume.
 */
async function formAgentOf(ws: string): Promise<Agent | null> {
  const cfg = await prisma.leadFormConfig.findUnique({ where: { id: ws }, select: { aiAgentId: true } });
  const a = cfg?.aiAgentId ? await getAgent(ws, cfg.aiAgentId) : null;
  return a && a.active ? a : null;
}

export function looksLikeFormMessage(text: string): boolean {
  if (/preenchi\s+(o\s+|seu\s+|o\s+seu\s+|um\s+)?formul[aá]rio/i.test(text)) return true;
  const qa = text.split('\n').filter((l) => /\?\s*:\s*\S/.test(l)).length;
  return qa >= 2;
}

function phoneFromJid(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

type SendText = (jid: string, text: string) => Promise<string | undefined>;

// Debounce por conversa: espera o cliente parar de digitar (delay do agente)
// antes de a IA responder. Uma nova mensagem reinicia o contador.
const pending = new Map<string, NodeJS.Timeout>();

/** Cancela uma resposta agendada (ex.: um humano assumiu a conversa). */
export function cancelPendingReply(conversationId: string) {
  const t = pending.get(conversationId);
  if (t) clearTimeout(t);
  pending.delete(conversationId);
}

async function historyOf(conversationId: string, answeredUntil?: Date | null): Promise<ChatTurn[]> {
  const msgs = await prisma.message.findMany({
    where: { conversationId, author: { not: 'system' } },
    orderBy: { createdAt: 'desc' },
    take: 60,
  });
  msgs.reverse();
  // Mensagens do lead que chegaram enquanto a IA enviava a resposta anterior ficam
  // ANTES dessa resposta na ordem do banco: move para o fim, como "ainda sem resposta".
  if (answeredUntil) {
    const pendingIn = msgs.filter((m) => m.direction === 'in' && m.createdAt > answeredUntil);
    const lastOut = msgs.reduce((t, m) => (m.direction === 'out' && m.createdAt > t ? m.createdAt : t), new Date(0));
    if (pendingIn.length && pendingIn.some((m) => m.createdAt < lastOut)) {
      const rest = msgs.filter((m) => !pendingIn.includes(m));
      msgs.length = 0;
      msgs.push(...rest, ...pendingIn);
    }
  }
  // Orçamento: no máximo ~24 mil caracteres (as mais antigas saem primeiro). Roteiro +
  // 60 mensagens longas estouravam o contexto e encareciam cada resposta.
  let budget = 24_000;
  const kept: typeof msgs = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    budget -= (msgs[i].body ?? '').length + 20;
    if (budget < 0 && kept.length >= 6) break;
    kept.unshift(msgs[i]);
  }
  return kept.map((m: { direction: string; author: string; body: string }) => ({
    role: (m.direction === 'in' ? 'user' : 'assistant') as 'user' | 'assistant',
    // O que o advogado/equipe escreveu também entra como "assistant" (é o escritório
    // falando), mas marcado: a IA sabe que não foi ela e não contradiz nem repete.
    content: m.direction === 'out' && m.author === 'agent' ? `[Mensagem enviada pelo advogado/equipe] ${m.body}` : m.body,
  }));
}

/** Alguém da equipe (não a IA) já escreveu nesta conversa? */
function historyHasHuman(history: ChatTurn[]): boolean {
  return history.some((h) => h.role === 'assistant' && h.content.startsWith('[Mensagem enviada pelo advogado/equipe]'));
}

/**
 * Texto que o lead mandou não pode "falar com a IA": neutraliza marcadores de ação e o
 * cabeçalho de contexto de formulário, que só o LawHub gera.
 */
export function sanitizeInboundText(text: string): string {
  return text.replace(/\[\[/g, '[ [').replace(/\[\s*CONTEXTO PARA A IA/gi, '[contexto');
}

/** {nome} / {Primeiro_Nome} / {{nome}} que o modelo copia do roteiro → primeiro nome real (ou some). */
export function fillNamePlaceholders(text: string, name?: string | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  return text
    .replace(/\s*\{\{?\s*(primeiro[_ ]?nome|nome(?:[_ ]do[_ ]cliente|[_ ]do[_ ]lead)?|first[_ ]?name|name)\s*\}?\}/gi, (m) => (first ? m.replace(/\{\{?[^}]*\}\}?/, first) : ''))
    .replace(/\s+([,.!?])/g, '$1');
}

/**
 * Garante que o lead esteja no CRM: cria um negócio na 1ª etapa do funil padrão
 * (o primeiro funil do cliente) se ainda não houver um para este contato.
 * Idempotente — pode ser chamado a cada mensagem recebida.
 */
const dealLocks = new Set<string>(); // evita criar 2 negócios para o mesmo contato em paralelo

export async function ensureDealForContact(ws: string, contactId: string) {
  const key = `${ws}:${contactId}`;
  if (dealLocks.has(key)) return; // já tem uma criação em andamento
  dealLocks.add(key);
  try {
  const exists = await prisma.deal.findFirst({ where: { workspaceId: ws, contactId } });
  if (exists) return;

  const funnel = await prisma.funnel.findFirst({ where: { workspaceId: ws }, orderBy: { order: 'asc' } });
  if (!funnel) return; // cliente ainda não tem funil configurado
  const stage = await prisma.pipelineStage.findFirst({ where: { funnelId: funnel.id }, orderBy: { order: 'asc' } });

  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  await prisma.deal.create({
    data: {
      workspaceId: ws,
      title: contact?.name || contact?.phone || 'Lead',
      contactId,
      funnelId: funnel.id,
      stageId: stage?.id ?? null,
      source: 'WhatsApp',
      stageSince: new Date(),
    },
  });
  if (stage) {
    await prisma.contact.update({ where: { id: contactId }, data: { stageId: stage.id } }).catch(() => {});
    await syncStageTag(ws, contactId, stage.id).catch(() => {});
  }
  emit(ws, { type: 'crm:update' });
  } finally {
    dealLocks.delete(key);
  }
}

/** Nota interna na conversa: aparece para a equipe, não vai para o WhatsApp nem para a IA. */
export async function systemNote(ws: string, conversationId: string, body: string) {
  const message = await prisma.message.create({
    data: { conversationId, direction: 'out', author: 'system', body },
  });
  emit(ws, { type: 'message:new', conversationId, message });
}

/**
 * Grava uma mensagem ENVIADA pelo próprio número (fromMe) — tipicamente quando
 * o operador responde o cliente direto pelo WhatsApp do celular. Dedup pelo id
 * da mensagem: se o próprio LawHub já a enviou, ignora o eco. Quando é mesmo do
 * celular, pausa a IA desta conversa (o operador assumiu).
 */
export async function recordOutgoingMessage(params: {
  workspaceId: string;
  waJid: string;
  body: string;
  waMessageId?: string;
  media?: InboundMedia;
}) {
  const { workspaceId: ws, waJid, body, waMessageId, media } = params;
  if (!body?.trim() && !media) return;

  if (waMessageId) {
    const already = await prisma.message.findFirst({
      where: { waMessageId, conversation: { workspaceId: ws } },
    });
    if (already) return; // eco de uma mensagem que o LawHub mesmo enviou
  }

  const jid = await canonicalJid(ws, waJid); // mesmo contato com/sem 9º dígito
  const contact = await prisma.contact.upsert({
    where: { workspaceId_waJid: { workspaceId: ws, waJid: jid } },
    update: {},
    create: { workspaceId: ws, waJid: jid, phone: phoneFromJid(jid) },
  });

  let conversation = await prisma.conversation.findFirst({
    where: { workspaceId: ws, contactId: contact.id, status: { not: 'closed' } },
    orderBy: { lastMessageAt: 'desc' },
  });
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: { workspaceId: ws, contactId: contact.id },
    });
  }

  // Áudio do advogado em conversa com IA: transcreve, para a IA (e a análise de
  // atendimento) saberem o que foi combinado quando retomarem.
  let outBody = body;
  if (media?.kind === 'audio' && conversation.aiEnabled) {
    const u = await understandMedia(media);
    if (u.status === 'ok' && u.text) outBody = body.trim() && body.trim() !== kindLabel('audio') ? `${body}\n\n[🎧 Áudio: ${u.text}]` : `[🎧 Áudio] ${u.text}`;
  }

  const message = await prisma.message.create({
    data: { conversationId: conversation.id, direction: 'out', author: 'agent', body: outBody, waMessageId, ...(await mediaFields(ws, media)) },
  });

  // Resposta automática do WhatsApp Business (saudação/ausência) ou de outro sistema
  // no mesmo número: sai segundos depois da mensagem do lead, no começo da conversa
  // ou com o mesmo texto para vários contatos. Essa NÃO pausa a IA.
  if (conversation.aiEnabled) {
    const lastIn = await prisma.message.findFirst({
      where: { conversationId: conversation.id, direction: 'in' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const sinceIn = lastIn ? Date.now() - lastIn.createdAt.getTime() : Infinity;
    if (body.trim()) {
      // Ninguém digita uma resposta em menos de 4 s: no começo da conversa isso é a
      // saudação automática. (Antes eram 8 s, e advogado rápido era confundido com robô.)
      const inCount = sinceIn < 4000 ? await prisma.message.count({ where: { conversationId: conversation.id, direction: 'in' } }) : 99;
      // Mesmo texto (15+ caracteres) já enviado a OUTROS contatos nos últimos 7 dias:
      // 2+ contatos é mensagem automática em qualquer horário; 1 contato só conta se
      // saiu em até 8 s (um advogado pode colar o mesmo texto para dois leads).
      const repeatedIn =
        body.trim().length >= 15
          ? await prisma.message.count({
              where: {
                body,
                direction: 'out',
                author: 'agent',
                createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60_000) },
                conversation: { workspaceId: ws, NOT: { id: conversation.id } },
              },
            })
          : 0;
      const repeated = repeatedIn >= 2 || (repeatedIn >= 1 && sinceIn < 8000);
      if (inCount <= 2 || repeated) {
        const updatedAuto = await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } });
        emit(ws, { type: 'message:new', conversationId: conversation.id, message });
        emit(ws, { type: 'conversation:update', conversation: updatedAuto });
        console.log(`[agentes:${ws}] mensagem automática do WhatsApp detectada na conversa ${conversation.id}; IA continua.`);
        return;
      }
    }
  }

  // Operador respondeu pelo celular: pausa a IA e cancela resposta agendada.
  const wasAi = conversation.aiEnabled;
  cancelPendingReply(conversation.id);
  const updated = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date(), aiEnabled: false, ...(wasAi || conversation.aiPausedBy === 'humano' ? { aiPausedBy: 'humano' } : {}) },
  });

  emit(ws, { type: 'message:new', conversationId: conversation.id, message });
  emit(ws, { type: 'conversation:update', conversation: updated });
  // Deixa claro na conversa POR QUE a IA parou (antes parava sem aviso).
  if (wasAi) {
    await systemNote(
      ws,
      conversation.id,
      `O advogado respondeu pelo celular/WhatsApp Web, então a IA pausou. Se o lead escrever e ninguém da equipe responder em ${AI_RESUME_MIN} minutos, a IA retoma sozinha.`,
    ).catch(() => {});
  }
}

/**
 * Importa UMA mensagem do histórico do WhatsApp (sincronização inicial do Baileys).
 * Diferente de uma mensagem ao vivo: NÃO dispara IA, automações, follow-up nem
 * notificação de não-lida. Só registra a conversa com o horário original, para a
 * equipe ver a conversa inteira no LawHub. Idempotente (dedup pelo id da mensagem).
 */
export async function importHistoryMessage(params: {
  workspaceId: string;
  waJid: string;
  pushName?: string;
  body: string;
  fromMe: boolean;
  waMessageId?: string;
  timestampMs: number;
}) {
  const { workspaceId: ws, waJid, pushName, body, fromMe, waMessageId, timestampMs } = params;
  if (!body?.trim()) return;

  if (waMessageId) {
    const already = await prisma.message.findFirst({ where: { waMessageId, conversation: { workspaceId: ws } } });
    if (already) return; // já temos esta mensagem
  }

  const jid = await canonicalJid(ws, waJid); // mesmo contato com/sem 9º dígito
  const phone = phoneFromJid(jid);
  const contact = await prisma.contact.upsert({
    where: { workspaceId_waJid: { workspaceId: ws, waJid: jid } },
    update: pushName ? { name: pushName } : {},
    create: { workspaceId: ws, waJid: jid, phone, name: pushName || null },
  });

  const createdAt = new Date(timestampMs || Date.now());

  let conversation = await prisma.conversation.findFirst({
    where: { workspaceId: ws, contactId: contact.id },
    orderBy: { lastMessageAt: 'desc' },
  });
  if (!conversation) {
    // Conversa criada a partir do histórico: reflete a data real da última mensagem.
    conversation = await prisma.conversation.create({
      data: { workspaceId: ws, contactId: contact.id, createdAt, lastMessageAt: createdAt },
    });
  }
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: fromMe ? 'out' : 'in',
      author: fromMe ? 'agent' : 'contact',
      body,
      waMessageId,
      createdAt, // preserva o horário original para a ordem da conversa
    },
  });
  if (createdAt > conversation.lastMessageAt) {
    await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: createdAt } });
  }
}

/**
 * A IA lê a conversa e move o lead para a etapa certa do funil automaticamente.
 * Roda em segundo plano a cada mensagem recebida (quando ligado em Ajustes).
 */
const lastAutoStage = new Map<string, number>(); // throttle por conversa (reduz custo da IA)

export async function autoMoveStage(ws: string, conversationId: string, force = false) {
  if (!force && !(await platformAutoStage())) return; // desligado pelo admin (botão manual ignora)
  if (!force) {
    const last = lastAutoStage.get(conversationId) ?? 0;
    if (Date.now() - last < 90_000) return; // no máximo 1 reavaliação por conversa a cada 90s
    lastAutoStage.set(conversationId, Date.now());
  }

  const llm = await resolveCrmLlm(); // IA global do CRM (ou a dos agentes, se não houver)
  if (!llm.ready) return;

  // Regra: a IA de etapa atua SÓ em funis novos — NUNCA no Funil Padrão.
  const defaultFunnel = await prisma.funnel.findFirst({ where: { workspaceId: ws }, orderBy: { order: 'asc' } });
  if (!defaultFunnel) return;

  const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { contactId: true, aiEnabled: true, assignedAgentId: true } });
  if (!conv) return;
  // Roteiro com "Mudar etapa" no comando da conversa: a etapa é dele. A IA do CRM
  // reclassificando por cima desfazia o que o roteiro acabou de fazer.
  if (!force && conv.aiEnabled && conv.assignedAgentId) {
    const a = await getAgent(ws, conv.assignedAgentId);
    if (a && /mudar\s+(?:de\s+)?etapa|\[\[\s*ETAPA/i.test(a.script)) return;
  }
  const deal = await prisma.deal.findFirst({ where: { workspaceId: ws, contactId: conv.contactId }, orderBy: { createdAt: 'desc' } });
  // Sem negócio, ou negócio no Funil Padrão → a IA não mexe na etapa.
  if (!deal?.funnelId || deal.funnelId === defaultFunnel.id) return;
  // Etapa mudada há pouco (pelo roteiro, pelo advogado no quadro ou por esta IA): espera.
  if (!force && deal.stageSince && Date.now() - deal.stageSince.getTime() < 10 * 60_000) return;

  const funnel = await prisma.funnel.findUnique({ where: { id: deal.funnelId } });
  if (!funnel || funnel.workspaceId !== ws) return;
  const stages = await prisma.pipelineStage.findMany({ where: { funnelId: funnel.id }, orderBy: { order: 'asc' } });
  if (stages.length < 2) return;

  const currentStage = deal.stageId ? stages.find((s) => s.id === deal.stageId)?.name : undefined;

  const history = await historyOf(conversationId);
  if (history.length < 2) return; // pouca conversa para classificar

  const lista = stages.map((s, i) => `${i + 1}. ${s.name}`).join('\n');
  // A IA do CRM só escolhe entre as etapas que o escritório criou: etapa nova é decisão
  // humana (antes ela criava "NOVA: …" e o funil virava uma bagunça).
  const system =
    'Você classifica em qual ETAPA do funil de vendas um lead está, com base na conversa de atendimento.\n' +
    `Etapas disponíveis (em ordem):\n${lista}\n` +
    (currentStage ? `Etapa atual do lead: "${currentStage}".\n` : '') +
    'Responda em UMA linha, APENAS com um destes:\n' +
    '- o nome EXATO de uma etapa da lista; ou\n' +
    '- a palavra "manter" (se nada mudou ou se tiver dúvida).\n' +
    'Seja conservador com etapas finais (ex.: "Fechado", "Perdido"): só use se o cliente deixou explícito. Não explique.';
  try {
    const out = (await llm.complete({ system, messages: history, maxTokens: 24 })).trim();
    if (/^manter/i.test(out) || /^NOVA\s*:/i.test(out)) return;

    const target = matchStageName(stages, out) as (typeof stages)[number] | undefined;
    if (!target || target.name === currentStage) return;
    await applyStage(ws, conversationId, target.name, funnel.id);
  } catch (err) {
    console.error('[auto-stage] falhou:', (err as Error).message);
  }
}

/**
 * Reavalia TODAS as conversas abertas agora: roda a IA do CRM em cada uma e
 * ajusta a etapa. Em segundo plano, com throttle (respeita cota do provedor).
 * Retorna quantas conversas entraram na fila.
 */
export async function reclassifyAllStages(ws: string): Promise<number> {
  const convs = await prisma.conversation.findMany({
    where: { workspaceId: ws, status: { not: 'closed' } },
    select: { id: true, contactId: true },
    orderBy: { lastMessageAt: 'desc' },
    take: 300,
  });
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const c of convs) {
    if (seen.has(c.contactId)) continue;
    seen.add(c.contactId);
    ids.push(c.id);
  }
  void (async () => {
    for (const id of ids) {
      try {
        await autoMoveStage(ws, id, true);
      } catch {
        /* segue para a próxima */
      }
      await new Promise((r) => setTimeout(r, 4500)); // ~13/min: cabe na cota grátis do Gemini
    }
  })();
  return ids.length;
}

/**
 * Texto que representa uma mídia recebida: legenda + transcrição/leitura, ou um rótulo
 * claro de falha. "[🎧 Áudio não transcrito]" é lido pela IA como pedido para o lead
 * escrever; "📎 Documento"/"🎬 Vídeo" como anexo que o advogado vai abrir.
 */
export async function describeInboundMedia(body: string, media: InboundMedia): Promise<string> {
  const caption = body.trim() === kindLabel(media.kind) ? '' : body.trim();
  const tag = media.kind === 'audio' ? '🎧 Áudio' : media.kind === 'image' ? '🖼️ Imagem' : '📄 Documento';
  if (!canUnderstand(media)) return caption ? `${caption}\n${kindLabel(media.kind)}` : kindLabel(media.kind);
  const u = await understandMedia(media);
  if (u.status === 'ok' && u.text) return caption ? `${caption}\n\n[${tag}: ${u.text}]` : `[${tag}] ${u.text}`;
  const why = u.status === 'unconfigured' ? 'sem IA de mídia configurada' : 'não foi possível ouvir/ler o arquivo';
  const label = `[${tag} não transcrito — ${why}]`;
  return caption ? `${caption}\n${label}` : label;
}

/** Processa uma mensagem recebida do WhatsApp. */
type InboundParams = {
  workspaceId: string;
  waJid: string;
  pushName?: string;
  body: string;
  waMessageId?: string;
  media?: InboundMedia;
  sendText: SendText;
};

// Mensagens do MESMO contato são processadas uma de cada vez, na ordem: duas
// mensagens quase juntas criavam duas conversas (uma sem IA) ou se perdiam.
const inboundChains = new Map<string, Promise<void>>();
export function handleInboundMessage(params: InboundParams): Promise<void> {
  const key = `${params.workspaceId}:${params.waJid}`;
  const prev = inboundChains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => handleInboundMessageNow(params));
  inboundChains.set(key, next);
  void next.finally(() => {
    if (inboundChains.get(key) === next) inboundChains.delete(key);
  }).catch(() => {});
  return next;
}

async function handleInboundMessageNow(params: InboundParams) {
  const { workspaceId: ws, waJid, pushName, body, waMessageId, media, sendText } = params;
  if (!body?.trim() && !media) return;

  // Mesma mensagem entregue duas vezes (reenvio do webhook / reconexão): ignora.
  if (waMessageId) {
    const already = await prisma.message.findFirst({ where: { waMessageId, conversation: { workspaceId: ws } }, select: { id: true } });
    if (already) return;
  }

  // Entende áudio/imagem/PDF e usa o texto resultante em tudo (triagem, resposta da
  // IA, CRM). Quando não dá, o rótulo diz isso explicitamente, para a IA pedir ao lead
  // que escreva em vez de responder a um "🎤 Áudio" como se fosse texto.
  let text = sanitizeInboundText(media ? await describeInboundMedia(body ?? '', media) : (body ?? ''));

  const jid = await canonicalJid(ws, waJid); // mesmo contato com/sem 9º dígito
  const phone = phoneFromJid(jid);

  const contact = await prisma.contact.upsert({
    where: { workspaceId_waJid: { workspaceId: ws, waJid: jid } },
    // Não troca o nome que veio do formulário pelo nome do perfil do WhatsApp.
    update: pushName && !(await hasFormName(ws, jid)) ? { name: pushName } : {},
    create: { workspaceId: ws, waJid: jid, phone, name: pushName || null },
  });
  queueAvatar(ws, contact.id, contact.avatarUrl); // foto de perfil (em segundo plano)

  let conversation = await prisma.conversation.findFirst({
    where: { workspaceId: ws, contactId: contact.id, status: { not: 'closed' } },
    orderBy: { lastMessageAt: 'desc' },
  });

  let startedBy: Agent | null = null;
  if (!conversation) {
    // Conversa nova: a IA só assume quando a mensagem traz uma frase-gatilho
    // cadastrada (triagem ou agente de tema). Sem gatilho (amigos, família,
    // contatos pessoais) a IA não entra. Começa pela triagem, que segue o roteiro.
    const triage = await getActiveTriage(ws);
    // Gatilho de QUALQUER agente principal: assume esse agente (um principal por campanha).
    const byTrigger = await triageByTrigger(ws, text);
    const themeHit = matchByTriggers(text, await getActiveThemeAgents(ws));
    const hit = Boolean(byTrigger) || (triage ? await matchesTrigger(ws, triage, text) : Boolean(themeHit));
    // Formulário do Meta no WhatsApp: assume com o agente escolhido em Formulários (ou a triagem).
    const formMsg = !hit && looksLikeFormMessage(text);
    const formAgent = formMsg ? await formAgentOf(ws) : null;
    const first = hit ? (byTrigger ?? triage ?? themeHit) : formMsg ? (formAgent ?? triage ?? null) : null;
    const start = Boolean(first);
    conversation = await prisma.conversation.create({
      data: {
        workspaceId: ws,
        contactId: contact.id,
        aiEnabled: start,
        assignedAgentId: start ? first!.id : null,
      },
    });
    if (start) startedBy = first;
  }

  const message = await prisma.message.create({
    data: { conversationId: conversation.id, direction: 'in', author: 'contact', body: text, waMessageId, ...(await mediaFields(ws, media)) },
  });

  // Resposta a um follow-up dizendo que não tem interesse / já fechou com outro: Perdido no CRM.
  void lostAfterFollowup(ws, conversation.id, text, message.createdAt).catch((e) =>
    console.error('[follow-up] classificação da resposta falhou:', (e as Error).message),
  );

  // Lead de campanha: chegou com uma frase-gatilho cadastrada em QUALQUER roteiro de IA
  // (gatilhos = mensagens prontas dos anúncios). Marca a conversa e o momento.
  if (!conversation.campaignSource && looksLikeFormMessage(text)) {
    conversation = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { campaignSource: 'formulario', campaignAd: 'Formulário no WhatsApp', campaignAt: new Date() },
    });
    // Telefone digitado errado no formulário: o lead escreve do número certo. Junta com o
    // cadastro do formulário e encerra a conversa órfã do número errado.
    await adoptFormEntry(ws, contact.id, conversation.id, text).catch((e) => console.error('[leadforms] juntar duplicado falhou:', (e as Error).message));
  }
  if (!conversation.campaignSource) {
    const hit = await campaignTriggerHit(ws, text);
    if (hit) {
      conversation = await prisma.conversation.update({
        where: { id: conversation.id },
        data: { campaignSource: 'gatilho', campaignAd: hit, campaignAt: new Date() },
      });
    } else {
      // Lead de formulário (últimos 7 dias) que escreveu no WhatsApp: também é lead de campanha.
      const form = await prisma.leadFormEntry.findFirst({
        where: { workspaceId: ws, contactId: contact.id, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60_000) } },
        orderBy: { createdAt: 'desc' },
      });
      if (form) {
        conversation = await prisma.conversation.update({
          where: { id: conversation.id },
          data: { campaignSource: 'formulario', campaignAd: form.formName || 'Formulário', campaignAt: new Date() },
        });
      }
    }
  }

  conversation = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date(), status: 'open', unread: { increment: 1 } },
  });

  emit(ws, { type: 'message:new', conversationId: conversation.id, message });
  emit(ws, { type: 'conversation:update', conversation });
  // Todo lead que escreve entra no CRM (1ª etapa do funil), se ainda não estiver.
  await ensureDealForContact(ws, contact.id).catch((e) => console.error('[crm] falha ao criar negócio:', e));
  // A IA lê a conversa e reavalia a etapa do lead (em segundo plano).
  void autoMoveStage(ws, conversation.id).catch(() => {});
  if (startedBy) await systemNote(ws, conversation.id, `${startedBy.name} assumiu o atendimento.`);

  // Reativação da IA quando ela está desligada nesta conversa:
  // - GATILHO EXPLÍCITO (palavra-chave cadastrada) → reativa SEMPRE, mesmo que
  //   a equipe tenha respondido há pouco (regra: gatilho sempre liga a IA).
  // - Sem gatilho (triagem de porta aberta) → só reativa se ninguém da equipe
  //   está atendendo (contato recorrente), pra não atropelar atendimento humano.
  if (!conversation.aiEnabled && !startedBy) {
    const byTrigger = await triageByTrigger(ws, text);
    const triage = byTrigger ?? (await getActiveTriage(ws));
    if (triage) {
      const triggerHit = Boolean(byTrigger) || (await matchesTrigger(ws, triage, text)) || looksLikeFormMessage(text);
      // Só com gatilho (ou mensagem de formulário): contato que volta sem gatilho fica com a equipe.
      const start = triggerHit;
      if (start) {
        conversation = await prisma.conversation.update({
          where: { id: conversation.id },
          data: { aiEnabled: true, aiPausedBy: null, assignedAgentId: byTrigger?.id ?? conversation.assignedAgentId ?? triage.id },
        });
        emit(ws, { type: 'conversation:update', conversation });
        await systemNote(ws, conversation.id, `${triage.name} assumiu pelo gatilho.`);
      }
    }
  }

  if (!conversation.aiEnabled) {
    // Sem IA: respostas automáticas por palavra-chave.
    const rules = await prisma.keywordRule.findMany({ where: { workspaceId: ws, active: true } });
    const lower = text.toLowerCase();
    const rule = rules.find((r) => r.keyword.trim() && lower.includes(r.keyword.trim().toLowerCase()));
    if (rule) {
      try {
        await deliver(ws, conversation.id, rule.reply, sendText);
      } catch (err) {
        console.error('[automação] falha ao responder palavra-chave:', err);
      }
    }
    return;
  }

  // A IA responde na hora. Só 2s de margem para juntar mensagens enviadas em
  // sequência (ex.: "oi" + "preciso de ajuda") numa resposta só.
  schedule(ws, conversation.id, sendText, 2000, 0);
}

function schedule(ws: string, conversationId: string, sendText: SendText, delayMs: number, hop: number) {
  cancelPendingReply(conversationId);
  pending.set(
    conversationId,
    setTimeout(() => {
      pending.delete(conversationId);
      void respondWithAI(ws, conversationId, sendText, hop);
    }, delayMs),
  );
}

// Conversas com uma resposta da IA sendo gerada agora (evita duas respostas em paralelo).
const inFlight = new Set<string>();
// Novas tentativas em erro passageiro do provedor de IA: 20 s, 1 min, 3 min, 10 min.
const TRANSIENT_DELAYS = [20_000, 60_000, 180_000, 600_000];
const transientTries = new Map<string, number>();
// Teto de segurança: se a IA mandar mais que isso numa hora, provavelmente está
// conversando com outro robô (chatbot de empresa) — desliga e avisa a equipe.
const AI_MAX_PER_HOUR = 30;
// Respostas vazias seguidas por conversa (1ª: tenta de novo em silêncio; 2ª: avisa).
const emptyTries = new Map<string, number>();

/** Ficha do lead + etapas válidas do funil do agente, para o prompt. */
async function agentContextFor(ws: string, contactId: string, agent: Agent, campaign: string | null | undefined, humanInConversation: boolean) {
  const contact = await prisma.contact.findUnique({ where: { id: contactId }, select: { name: true, phone: true, tags: true, stageId: true } });
  const funnelId = agent.funnelId ?? (await prisma.deal.findFirst({ where: { workspaceId: ws, contactId }, orderBy: { createdAt: 'desc' }, select: { funnelId: true } }))?.funnelId ?? null;
  const stages = funnelId ? await prisma.pipelineStage.findMany({ where: { funnelId }, orderBy: { order: 'asc' }, select: { id: true, name: true } }) : [];
  const deal = await prisma.deal.findFirst({ where: { workspaceId: ws, contactId }, orderBy: { createdAt: 'desc' }, select: { stageId: true } });
  const stageId = deal?.stageId ?? contact?.stageId ?? null;
  const stageName = stageId ? (stages.find((st) => st.id === stageId)?.name ?? (await prisma.pipelineStage.findUnique({ where: { id: stageId }, select: { name: true } }))?.name) : null;
  return {
    contact: { name: contact?.name, phone: contact?.phone },
    stageName,
    stages: stages.map((st) => st.name),
    tags: (contact?.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    campaign: campaign ?? null,
    humanInConversation,
  };
}

async function respondWithAI(ws: string, conversationId: string, sendText: SendText, hop: number, seed?: ChatTurn[]) {
  if (inFlight.has(conversationId)) {
    // Já tem resposta em andamento: tenta de novo daqui a pouco (ela verá a mensagem nova).
    schedule(ws, conversationId, sendText, 3000, hop);
    return;
  }
  inFlight.add(conversationId);
  const startedAt = new Date();
  try {
    const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation || !conversation.aiEnabled) return; // humano pode ter assumido

    // Nada para responder: a última fala é do escritório (advogado ou a própria IA) e o
    // lead não escreveu depois. Acontecia ao "Devolver para IA" logo após o advogado
    // mandar mensagem: a IA respondia por cima dele. Primeira mensagem de formulário
    // (seed) e passagem entre agentes (hop) continuam podendo falar.
    if (!seed && hop === 0) {
      const lastIn = await prisma.message.findFirst({
        where: { conversationId, direction: 'in' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      // Resposta automática do WhatsApp Business sai em segundos: não conta como fala da equipe.
      const after = new Date((lastIn?.createdAt.getTime() ?? 0) + 10_000);
      const outAfter = await prisma.message.findFirst({
        where: { conversationId, direction: 'out', author: { in: ['agent', 'ai'] }, createdAt: { gt: after } },
        select: { id: true },
      });
      if (!lastIn || outAfter) return;
    }

    // Teto por hora conta só depois da última vez que a IA foi devolvida/ligada.
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    const since = conversation.aiResumedAt && conversation.aiResumedAt > hourAgo ? conversation.aiResumedAt : hourAgo;
    const recentAi = await prisma.message.count({
      where: { conversationId, author: 'ai', mediaId: null, createdAt: { gte: since } },
    });
    if (recentAi >= AI_MAX_PER_HOUR) {
      const updated = await prisma.conversation.update({ where: { id: conversationId }, data: { aiEnabled: false, aiPausedBy: 'limite' } });
      emit(ws, { type: 'conversation:update', conversation: updated });
      await systemNote(
        ws,
        conversationId,
        `A IA mandou ${recentAi} mensagens na última hora e foi pausada por segurança (pode ser outro robô respondendo). Confira a conversa e devolva para a IA se estiver tudo certo.`,
      );
      return;
    }

    let agent = await getAgent(ws, conversation.assignedAgentId);
    if (!agent || !agent.active) {
      // Agente da conversa foi desativado/apagado: tenta o principal cujo gatilho abriu a
      // conversa (cliente com um roteiro por campanha); senão, o primeiro principal ativo.
      const firstIn = await prisma.message.findFirst({ where: { conversationId, direction: 'in' }, orderBy: { createdAt: 'asc' }, select: { body: true } });
      agent = (firstIn ? await triageByTrigger(ws, firstIn.body) : null) ?? (await getActiveTriage(ws));
    }
    if (!agent) {
      // Agente desativado/apagado e sem triagem ativa: avisa e devolve para a equipe
      // (antes descartava as respostas em silêncio).
      const updated = await prisma.conversation.update({ where: { id: conversationId }, data: { aiEnabled: false } });
      emit(ws, { type: 'conversation:update', conversation: updated });
      await systemNote(ws, conversationId, 'Nenhum agente de IA ativo para esta conversa (o agente foi desativado). A conversa ficou com a equipe.');
      return;
    }

    // Última mensagem do lead até agora: depois de responder, fica marcada como
    // "respondida" — assim uma mensagem que chegou DURANTE o envio não fica sem resposta.
    const lastIn = await prisma.message.findFirst({
      where: { conversationId, direction: 'in' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const answered = conversation.aiAnsweredUntil;

    // Contexto guardado na conversa (ex.: respostas do formulário) vai sempre no início,
    // para a IA não esquecer o que o lead preencheu depois da 1ª mensagem.
    // `seed`: contexto da 1ª resposta quando a IA começa a conversa.
    const ctx: ChatTurn[] = !seed?.length && conversation.aiContext ? [{ role: 'user', content: conversation.aiContext }] : [];
    const past = await historyOf(conversationId, answered);
    const history = seed?.length ? [...past, ...seed] : [...ctx, ...past];
    if (history.length === 0) return;
    // Na 1ª resposta após transferência, o novo agente fala mesmo sem nova mensagem do cliente.
    if (hop === 0 && !seed?.length) {
      const pendingIn = answered ? !!lastIn && lastIn.createdAt > answered : history[history.length - 1].role === 'user';
      if (!pendingIn) return;
    }
    const markAnswered = async () => {
      if (lastIn) await prisma.conversation.update({ where: { id: conversationId }, data: { aiAnsweredUntil: lastIn.createdAt } }).catch(() => {});
    };

    const llm = await resolveLlm(ws);
    // Biblioteca de mídias do agente: a IA recebe os nomes e pede com [[MIDIA: NOME]].
    const agentMedia = await prisma.agentMedia.findMany({ where: { agentId: agent.id }, orderBy: { createdAt: 'asc' } });
    // Ficha do lead para o prompt: nome, etapa, etiquetas, origem e etapas válidas do funil.
    const ctxCard = await agentContextFor(ws, conversation.contactId, agent, conversation.campaignAd, historyHasHuman(history));
    const reply = llm.ready ? await runAgent(agent, history, llm, agentMedia.map((m) => m.name), ctxCard) : offlineReply(agent, history);
    const { actions, raw } = reply;
    const text = fillNamePlaceholders(reply.text, ctxCard.contact?.name);

    // A resposta da IA leva alguns segundos: se nesse meio-tempo um humano assumiu
    // (ou a IA foi desligada), descarta a resposta em vez de falar por cima.
    const fresh = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { aiEnabled: true } });
    if (!fresh?.aiEnabled) return;
    // O lead mandou outra mensagem enquanto a IA escrevia: descarta esta resposta e
    // gera uma nova já considerando tudo (evita duas respostas seguidas).
    if (!seed?.length) {
      const newer = await prisma.message.findFirst({
        where: { conversationId, direction: 'in', createdAt: { gt: startedAt } },
        select: { id: true },
      });
      if (newer) {
        schedule(ws, conversationId, sendText, 1500, hop);
        return;
      }
    }

    if (text) {
      // Mensagens do lead que esta resposta cobre: ficam como lidas (✓✓) antes do "digitando…".
      const toRead = answered
        ? await prisma.message.findMany({ where: { conversationId, direction: 'in', createdAt: { gt: answered }, waMessageId: { not: null } }, select: { waMessageId: true }, take: 20 })
        : await prisma.message.findMany({ where: { conversationId, direction: 'in', waMessageId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { waMessageId: true }, take: 5 });
      await deliver(ws, conversationId, text, sendText, toRead.map((m) => m.waMessageId!).filter(Boolean));
      await markAnswered();
      transientTries.delete(conversationId);
      emptyTries.delete(conversationId);
    } else if (actions.length) {
      await markAnswered(); // só ações: não reaplica na recuperação
    } else if (actions.length === 0) {
      // Resposta vazia (modelo devolveu só rótulo/ação): tenta de novo em 20 s, sem nota.
      // Só na 2ª falha seguida avisa a equipe.
      const tries = (emptyTries.get(conversationId) ?? 0) + 1;
      emptyTries.set(conversationId, tries);
      if (tries <= 1) {
        schedule(ws, conversationId, sendText, 20_000, hop);
        return;
      }
      emptyTries.delete(conversationId);
      const peek = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
      await systemNote(
        ws,
        conversationId,
        `${agent.name} não gerou mensagem para o lead${peek ? ` (a IA devolveu só: "${peek}")` : ' (resposta vazia)'} duas vezes seguidas. Revise o roteiro ou responda manualmente.`,
      );
      return;
    }

    // Mídias pedidas pelo roteiro (imagem, áudio, vídeo, documento), na ordem pedida.
    for (const act of actions) {
      if (act.type !== 'media') continue;
      const media =
        agentMedia.find((m) => normalize(m.name) === normalize(act.name)) ??
        agentMedia.find((m) => normalize(m.name).includes(normalize(act.name)) || normalize(act.name).includes(normalize(m.name))) ??
        (await prisma.agentMedia.findFirst({ where: { workspaceId: ws, name: act.name } }));
      if (!media) {
        await systemNote(ws, conversationId, `O roteiro pediu a mídia "${act.name}", mas ela não existe na biblioteca do agente.`);
        continue;
      }
      await deliverMedia(ws, conversationId, media).catch((err) =>
        systemNote(ws, conversationId, `Não consegui enviar a mídia "${media.name}" (${(err as Error).message}).`),
      );
    }

    // Ações de CRM pedidas pelo roteiro (podem vir junto com a mensagem).
    for (const act of actions) {
      if (act.type === 'stage') await applyStage(ws, conversationId, act.name, agent.funnelId);
      else if (act.type === 'tag') await applyTag(ws, conversationId, act.name);
      else if (act.type === 'notify') await applyNotify(ws, conversationId, act.reason);
    }

    if (actions.some((a) => a.type === 'deactivate')) {
      const updated = await prisma.conversation.update({
        where: { id: conversationId },
        data: { aiEnabled: false, aiPausedBy: 'roteiro' },
      });
      emit(ws, { type: 'conversation:update', conversation: updated });
      await systemNote(ws, conversationId, `${agent.name} encerrou a parte automática. A conversa está com a equipe.`);
      return;
    }

    let target: Agent | null = null;
    const transfer = actions.find((a): a is { type: 'transfer'; agentName: string } => a.type === 'transfer');
    if (transfer) {
      target = await findAgentByName(ws, transfer.agentName);
      if (!target) {
        await systemNote(ws, conversationId, `O roteiro pediu transferência para “${transfer.agentName}”, mas esse agente não existe ou está inativo.`);
        return;
      }
    } else if (agent.type === 'triage' && !scriptHasActions(agent)) {
      // Roteiro sem ações explícitas: mantém o roteamento automático por gatilho/IA.
      const themeAgents = await getActiveThemeAgents(ws);
      const lastUser = [...history].reverse().find((h) => h.role === 'user');
      target = await decideTarget(lastUser?.content ?? '', themeAgents, history, llm);
    }

    if (target && target.id !== agent.id) {
      const updated = await prisma.conversation.update({
        where: { id: conversationId },
        data: { assignedAgentId: target.id, aiEnabled: true },
      });
      emit(ws, { type: 'conversation:update', conversation: updated });
      await systemNote(ws, conversationId, `Transferido de ${agent.name} para ${target.name}.`);
      await logAgent(target.id, 'Recebeu uma conversa transferida');
      // O agente de tema continua o atendimento logo em seguida (no máximo 2 saltos).
      if (hop < 2) schedule(ws, conversationId, sendText, 3000, hop + 1);
    }
  } catch (err) {
    console.error('[agentes] falha ao responder:', err);
    // Erro passageiro do provedor (sobrecarga 529, limite 429, 5xx, tempo esgotado):
    // tenta de novo com espera crescente, sem nota, antes de desistir.
    const e = err as { status?: number; message?: string };
    const status = e.status ?? Number(/respondeu (\d{3})/.exec(e.message ?? '')?.[1] ?? 0);
    const transient = [408, 409, 425, 429, 500, 502, 503, 504, 529].includes(status) || /overload|timeout|timed out|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(e.message ?? '');
    const tries = transientTries.get(conversationId) ?? 0;
    if (transient && tries < TRANSIENT_DELAYS.length) {
      transientTries.set(conversationId, tries + 1);
      schedule(ws, conversationId, sendText, TRANSIENT_DELAYS[tries], hop);
      return;
    }
    transientTries.delete(conversationId);
    await systemNote(
      ws,
      conversationId,
      `A IA não conseguiu responder (${(err as Error).message}). Verifique a chave e o modelo em Ajustes ou responda manualmente.`,
    ).catch(() => {});
  } finally {
    inFlight.delete(conversationId);
  }
}

async function deliver(ws: string, conversationId: string, text: string, sendText: SendText, readIds: string[] = []) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { contact: true },
  });
  if (!conversation) return;
  // Lê as mensagens do lead e mostra "digitando…" por alguns segundos (humaniza).
  try {
    const { humanizeBeforeSend } = await import('../whatsapp/session.js');
    await humanizeBeforeSend(ws, conversation.contact.waJid, text, readIds);
  } catch {
    /* cosmético */
  }
  const waMessageId = await sendText(conversation.contact.waJid, text);
  const outMsg = await prisma.message.create({
    data: { conversationId, direction: 'out', author: 'ai', body: text, waMessageId },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: new Date() },
  });
  emit(ws, { type: 'message:new', conversationId, message: outMsg });
}

/** Nome do agente cujo gatilho aparece no texto (qualquer agente do cliente, ativo ou não). */
async function campaignTriggerHit(ws: string, text: string): Promise<string | null> {
  if (!text.trim()) return null;
  const agents = await prisma.agent.findMany({ where: { workspaceId: ws, NOT: { triggers: '' } } });
  return matchByTriggers(text, agents)?.name ?? null;
}

/** Envia um arquivo da biblioteca do agente e registra na conversa. */
async function deliverMedia(
  ws: string,
  conversationId: string,
  media: { name: string; kind: string; mimeType: string; fileName: string | null; fileId: string },
) {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { contact: true } });
  if (!conversation) return;
  const { readFile } = await import('node:fs/promises');
  const { mediaFilePath } = await import('../whatsapp/media.js');
  const { sendMedia } = await import('../whatsapp/session.js');
  const buffer = await readFile(mediaFilePath(ws, media.fileId));
  const waMessageId = await sendMedia(ws, conversation.contact.waJid, {
    buffer,
    mimetype: media.mimeType,
    filename: media.fileName ?? undefined,
    kind: media.kind as MediaKind,
  });
  const msg = await prisma.message.create({
    data: {
      conversationId,
      direction: 'out',
      author: 'ai',
      body: '',
      waMessageId,
      mediaType: media.kind,
      mediaId: media.fileId, // o mesmo arquivo da biblioteca (aparece no chat)
      mediaName: media.fileName,
      mimeType: media.mimeType,
    },
  });
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
  emit(ws, { type: 'message:new', conversationId, message: msg });
}

/* -------------------------------------------------------------------------- */
/* Ações de CRM executadas pelo agente                                         */
/* -------------------------------------------------------------------------- */

/**
 * Acha a etapa pelo nome: igual (normalizado) → o nome da etapa contém o pedido como
 * palavra(s) inteira(s) ("Lead Qualificado" ⊃ "qualificado") → o pedido contém o nome da
 * etapa inteiro. "Desqualificado" NÃO casa mais com "Qualificado" (era por substring).
 */
export function matchStageName<T extends { name: string }>(stages: T[], ref: string): T | undefined {
  const want = normalize(ref);
  if (!want) return undefined;
  const words = (s: string) => ` ${s} `;
  return (
    stages.find((s) => normalize(s.name) === want) ??
    stages.find((s) => words(normalize(s.name)).includes(words(want))) ??
    stages.find((s) => words(want).includes(words(normalize(s.name))))
  );
}

/** Move o lead para uma etapa do funil (move o negócio existente ou cria um).
 *  Aceita "Funil › Etapa" (desambigua o funil) ou apenas "Etapa". Se vier só a
 *  etapa, usa o funil do agente (preferFunnelId) para resolver a ambiguidade. */
async function applyStage(ws: string, conversationId: string, stageRef: string, preferFunnelId?: string | null) {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { contactId: true },
  });
  if (!conv) return;

  // "Funil › Etapa" → separa funil e etapa; só "Etapa" → funil fica vazio.
  const parts = stageRef.split(/›|»|>|\|/).map((p) => p.trim()).filter(Boolean);
  const stageName = parts.length > 1 ? parts[parts.length - 1] : parts[0] ?? stageRef.trim();
  const funnelName = parts.length > 1 ? parts[0] : '';

  const all = await prisma.pipelineStage.findMany({ where: { workspaceId: ws }, include: { funnel: true } });
  // Prioridade do funil: o explícito no texto → o funil do agente → todos.
  let scoped = funnelName ? all.filter((s) => s.funnel && normalize(s.funnel.name) === normalize(funnelName)) : [];
  if (!scoped.length && preferFunnelId) scoped = all.filter((s) => s.funnelId === preferFunnelId);
  const pool = scoped.length ? scoped : all;
  const target = matchStageName(pool, stageName) as (typeof pool)[number] | undefined;
  if (!target) {
    await systemNote(ws, conversationId, `Não encontrei a etapa "${stageRef}" para mover o lead.`);
    return;
  }

  const contact = await prisma.contact.findUnique({ where: { id: conv.contactId } });
  await prisma.contact.update({ where: { id: conv.contactId }, data: { stageId: target.id } }).catch(() => {});

  // Prefere o negócio do contato que já está no funil de destino; se não houver,
  // MOVE o negócio mais recente dele (ex.: do Funil Padrão para o funil certo)
  // em vez de criar um segundo — evita o mesmo lead duplicado no CRM.
  const deal =
    (await prisma.deal.findFirst({
      where: { workspaceId: ws, contactId: conv.contactId, funnelId: target.funnelId ?? undefined },
      orderBy: { createdAt: 'desc' },
    })) ??
    (await prisma.deal.findFirst({
      where: { workspaceId: ws, contactId: conv.contactId },
      orderBy: { createdAt: 'desc' },
    }));
  if (deal) {
    await prisma.deal.update({
      where: { id: deal.id },
      data: { funnelId: target.funnelId ?? deal.funnelId, stageId: target.id, stageSince: new Date(), followupStageId: null, followupStep: 0, followupAt: null },
    });
  } else {
    await prisma.deal.create({
      data: {
        workspaceId: ws,
        title: contact?.name || contact?.phone || 'Lead',
        contactId: conv.contactId,
        funnelId: target.funnelId ?? null,
        stageId: target.id,
        source: 'WhatsApp',
        stageSince: new Date(),
      },
    });
  }
  // Etiqueta de etapa SEMPRE sincronizada: remove a da etapa anterior e aplica a atual.
  await syncStageTag(ws, conv.contactId, target.id);
  emit(ws, { type: 'crm:update' });
  // Lead qualificado → devolve o evento ao Meta Ads e ao Google Ads (se configurados).
  void maybeFireQualifiedLead(ws, conv.contactId, target.id).catch(() => {});
  void maybeFireGoogleConversion(ws, conv.contactId, target.id).catch(() => {});
  // Lead qualificado pela IA → avisa o escritório no WhatsApp com dados + resumo.
  void notifyQualifiedLead(ws, conversationId, conv.contactId, target.id).catch((e) =>
    console.error('[notify] falha na notificação de lead qualificado:', (e as Error).message),
  );
  await systemNote(ws, conversationId, `Etapa movida para "${target.name}".`);
}

/**
 * Mantém a etiqueta de etapa do contato SEMPRE igual à etapa atual: remove
 * qualquer etiqueta que seja a "etiqueta automática" de alguma etapa e aplica
 * a da etapa de destino. Etiquetas manuais (que não são de nenhuma etapa) são
 * preservadas. Chamado por todos os caminhos que mudam a etapa (IA, CRM, etc.).
 */
export async function syncStageTag(ws: string, contactId: string, stageId: string | null | undefined) {
  const stages = await prisma.pipelineStage.findMany({ where: { workspaceId: ws }, select: { id: true, autoTag: true } });
  const stageTagNorms = new Set(stages.map((s) => s.autoTag?.trim()).filter(Boolean).map((t) => normalize(t!)));
  const newTag = (stageId ? stages.find((s) => s.id === stageId)?.autoTag : '')?.trim() || '';

  const contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (!contact) return;
  const current = (contact.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  // Mantém só as etiquetas que NÃO são de etapa; depois junta a da etapa atual.
  const kept = current.filter((t) => !stageTagNorms.has(normalize(t)));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...kept, ...(newTag ? [newTag] : [])]) {
    const k = normalize(t);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  const joined = out.join(', ');
  if (joined !== (contact.tags ?? '')) {
    await prisma.contact.update({ where: { id: contactId }, data: { tags: joined } });
  }
  if (newTag) {
    const exists = await prisma.tag.findFirst({ where: { workspaceId: ws, name: newTag } });
    if (!exists) await prisma.tag.create({ data: { workspaceId: ws, name: newTag, color: '#b71312' } }).catch(() => {});
  }
  // Atualiza a lista do CRM e as conversas abertas desse contato na caixa de entrada.
  emit(ws, { type: 'crm:update' });
  const convs = await prisma.conversation.findMany({ where: { workspaceId: ws, contactId }, select: { id: true } });
  for (const c of convs) {
    const updated = await prisma.conversation.findUnique({ where: { id: c.id }, include: { contact: true } });
    if (updated) emit(ws, { type: 'conversation:update', conversation: updated });
  }
}

/**
 * Backfill (startup): toda etapa sem etiqueta automática ganha uma = nome da
 * etapa, na cor dela, e garante a etiqueta no catálogo. Se algo mudou, re-
 * sincroniza os contatos para a etapa atual, deixando tudo consistente já.
 */
export async function backfillStageTags() {
  const stages = await prisma.pipelineStage.findMany();
  let filledAutoTag = false;
  for (const s of stages) {
    const tag = (s.autoTag?.trim() || s.name).trim();
    if (!s.autoTag?.trim()) {
      await prisma.pipelineStage.update({ where: { id: s.id }, data: { autoTag: s.name } }).catch(() => {});
      filledAutoTag = true;
    }
    const existing = await prisma.tag.findFirst({ where: { workspaceId: s.workspaceId, name: tag } });
    if (!existing) await prisma.tag.create({ data: { workspaceId: s.workspaceId, name: tag, color: s.color } }).catch(() => {});
  }

  // Alinha a etapa do CONTATO ao estágio do NEGÓCIO mais recente (o quadro do
  // CRM usa o negócio; antes, arrastar o card não mexia no contato). Assim a
  // conversa passa a mostrar a mesma etapa que aparece no CRM.
  const deals = await prisma.deal.findMany({
    where: { contactId: { not: null }, stageId: { not: null } },
    orderBy: [{ stageSince: 'desc' }, { createdAt: 'desc' }],
    select: { contactId: true, stageId: true },
  });
  const latest = new Map<string, string>();
  for (const d of deals) if (d.contactId && d.stageId && !latest.has(d.contactId)) latest.set(d.contactId, d.stageId);

  const touched = new Set<string>();
  for (const [cid, sid] of latest) {
    const c = await prisma.contact.findUnique({ where: { id: cid }, select: { stageId: true } });
    if (c && c.stageId !== sid) {
      await prisma.contact.update({ where: { id: cid }, data: { stageId: sid } }).catch(() => {});
      touched.add(cid);
    }
  }

  // Re-sincroniza a etiqueta de etapa: tudo, se preencheu autoTag agora; senão
  // só os contatos cuja etapa foi corrigida (barato nos próximos boots).
  let toSync: { id: string; workspaceId: string; stageId: string | null }[];
  if (filledAutoTag) {
    toSync = await prisma.contact.findMany({ where: { stageId: { not: null } }, select: { id: true, workspaceId: true, stageId: true } });
  } else if (touched.size) {
    toSync = await prisma.contact.findMany({ where: { id: { in: [...touched] } }, select: { id: true, workspaceId: true, stageId: true } });
  } else {
    return;
  }
  for (const c of toSync) await syncStageTag(c.workspaceId, c.id, c.stageId).catch(() => {});
  console.log(`[crm] etapas alinhadas ao negócio (${touched.size}) e ${toSync.length} contatos re-sincronizados.`);
}

/** Adiciona uma etiqueta ao contato (e ao catálogo de etiquetas, se for nova). */
async function applyTag(ws: string, conversationId: string, tagName: string) {
  const name = tagName.trim();
  if (!name) return;
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { contactId: true },
  });
  if (!conv) return;

  const contact = await prisma.contact.findUnique({ where: { id: conv.contactId } });
  const tags = (contact?.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  if (!tags.some((t) => normalize(t) === normalize(name))) {
    tags.push(name);
    await prisma.contact.update({ where: { id: conv.contactId }, data: { tags: tags.join(', ') } });
  }

  const exists = await prisma.tag.findFirst({ where: { workspaceId: ws, name } });
  if (!exists) await prisma.tag.create({ data: { workspaceId: ws, name, color: '#b71312' } }).catch(() => {});

  await systemNote(ws, conversationId, `Etiqueta "${name}" adicionada ao contato.`);
}

/**
 * O lead mandou a mensagem do formulário de um número DIFERENTE do que digitou nele
 * (dígito trocado, DDI errado). Acha o cadastro do formulário pelo e-mail ou nome dos
 * últimos 7 dias e, se o contato do número errado nunca respondeu, encerra a conversa
 * dele, apaga o negócio duplicado e liga o cadastro ao contato certo.
 */
async function adoptFormEntry(ws: string, contactId: string, conversationId: string, text: string) {
  const email = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0]?.toLowerCase() ?? '';
  const name = (text.match(/full\s*name\s*:\s*([^\n]+?)(?=\s+(?:whatsapp|email|e-mail|qual|com quais|phone|telefone)\b|\n|$)/i)?.[1] ?? '').trim();
  if (!email && !name) return;
  const recent = await prisma.leadFormEntry.findMany({
    where: { workspaceId: ws, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60_000) }, NOT: { contactId } },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const entry = recent.find((e) => (email && e.email.toLowerCase() === email) || (name && normalize(e.name) === normalize(name)));
  if (!entry?.contactId) return;
  const orphanId = entry.contactId;
  // Só junta se o número errado nunca falou (senão pode ser outra pessoa de verdade).
  const spoke = await prisma.message.count({ where: { direction: 'in', conversation: { workspaceId: ws, contactId: orphanId } } });
  if (spoke > 0) return;
  const orphan = await prisma.contact.findUnique({ where: { id: orphanId }, select: { phone: true, waJid: true } });
  const me = await prisma.contact.findUnique({ where: { id: contactId }, select: { phone: true } });

  await prisma.leadFormEntry.update({ where: { id: entry.id }, data: { contactId } });
  for (const c of await prisma.conversation.findMany({ where: { workspaceId: ws, contactId: orphanId, status: { not: 'closed' } } })) {
    cancelPendingReply(c.id);
    await prisma.conversation.update({ where: { id: c.id }, data: { status: 'closed', aiEnabled: false, aiPausedBy: 'roteiro' } });
    await systemNote(ws, c.id, `O número do formulário estava errado. O lead escreveu de +${me?.phone ?? '?'} e o atendimento segue lá. Esta conversa foi encerrada.`);
  }
  // Negócio do número errado some do funil; o do número certo é criado pelo fluxo normal.
  await prisma.deal.deleteMany({ where: { workspaceId: ws, contactId: orphanId } });
  await prisma.contact.update({ where: { id: orphanId }, data: { tags: 'Número errado no formulário' } }).catch(() => {});
  await systemNote(ws, conversationId, `Formulário encontrado pelo ${email ? 'e-mail' : 'nome'}: o número digitado (${orphan?.phone ? `+${orphan.phone}` : orphan?.waJid ?? '?'}) estava errado. Cadastro ligado a este contato.`);
  emit(ws, { type: 'crm:update' });
}

/**
 * O lead respondeu a um FOLLOW-UP automático (última fala do escritório antes desta
 * mensagem foi o follow-up). Se a resposta é de desistência — "não tenho interesse",
 * "já resolvi", "fechei com outro advogado" —, move o negócio para a etapa "Perdido"
 * do funil dele, etiqueta e deixa nota. Só age em funis que têm etapa "Perdido".
 */
async function lostAfterFollowup(ws: string, conversationId: string, text: string, at: Date) {
  if (!text.trim()) return;
  const prevIn = await prisma.message.findFirst({
    where: { conversationId, direction: 'in', createdAt: { lt: at } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  // Follow-up enviado depois da fala anterior do lead (e nos últimos 7 dias).
  const fu = await prisma.message.findFirst({
    where: {
      conversationId,
      author: 'system',
      body: { startsWith: '⏰ Follow-up automático' },
      createdAt: { gt: prevIn?.createdAt ?? new Date(0), gte: new Date(Date.now() - 7 * 24 * 60 * 60_000) },
    },
    select: { id: true },
  });
  if (!fu) return;

  const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { contactId: true } });
  if (!conv) return;
  const deal = await prisma.deal.findFirst({ where: { workspaceId: ws, contactId: conv.contactId }, orderBy: { updatedAt: 'desc' } });
  if (!deal?.funnelId) return;
  const lost = await prisma.pipelineStage.findFirst({ where: { workspaceId: ws, funnelId: deal.funnelId, name: { contains: 'Perdid' } } });
  if (!lost || deal.stageId === lost.id) return;

  const llm = await resolveLlm(ws);
  if (!llm.ready) return;
  const out = await llm.complete({
    system:
      'Um escritório de advocacia mandou uma mensagem de acompanhamento (follow-up) para um lead que tinha parado de responder. ' +
      'Classifique a RESPOSTA do lead. Responda só com uma palavra:\n' +
      'PERDIDO — se ele deixa claro que não quer seguir: não tem interesse, desistiu, já resolveu, já contratou/fechou com outro advogado ou escritório, pediu para não mandar mais mensagens.\n' +
      'SEGUE — qualquer outra coisa (quer continuar, tem dúvida, pede para falar depois, está ocupado, cumprimento, resposta vaga).',
    messages: [{ role: 'user', content: text.slice(0, 1000) }],
    maxTokens: 5,
  });
  if (!/perdid/i.test(out)) return;

  await applyStage(ws, conversationId, lost.name, deal.funnelId);
  await applyTag(ws, conversationId, 'Sem Interesse');
  await systemNote(ws, conversationId, `Lead respondeu ao follow-up que não tem interesse ou já fechou com outro: movido para "${lost.name}".`);
}

/** Avisa a equipe: nota de sistema + marca a conversa como não lida. */
async function applyNotify(ws: string, conversationId: string, reason: string) {
  await systemNote(ws, conversationId, `🔔 Equipe notificada: ${reason.trim() || 'atenção neste atendimento'}`);
  const updated = await prisma.conversation.update({
    where: { id: conversationId },
    data: { unread: { increment: 1 } },
  });
  emit(ws, { type: 'conversation:update', conversation: updated });
  // E no WhatsApp do advogado (sem travar a resposta ao lead).
  void notifyTeamWhatsApp(ws, conversationId, reason).catch((e) => console.error('[notify] aviso da equipe falhou:', (e as Error).message));
}


/* ----------------------- Recuperação de respostas ----------------------- */
// A resposta da IA é agendada em memória (delay do agente). Se o servidor
// reinicia nesse intervalo (deploy, queda), a resposta se perdia e o lead
// ficava sem retorno. A cada minuto, procura conversas com a IA ligada cuja
// última mensagem é do lead e ainda sem resposta, e responde (até 2 tentativas
// por mensagem, para não insistir num erro).
const recoveryTries = new Map<string, number>();
// A IA pausou porque o advogado respondeu: se o lead escrever e a equipe ficar
// esse tempo sem responder, a IA retoma sozinha.
export const AI_RESUME_MIN = 15;
let recovering = false;

async function recoverPendingReplies() {
  if (recovering) return;
  recovering = true;
  try {
    const now = Date.now();
    const convs = await prisma.conversation.findMany({
      where: {
        aiEnabled: true,
        status: { not: 'closed' },
        lastMessageAt: { gte: new Date(now - 6 * 60 * 60_000), lte: new Date(now - 90_000) },
      },
      select: { id: true, workspaceId: true, aiAnsweredUntil: true },
      orderBy: { lastMessageAt: 'desc' },
      take: 80,
    });
    const { sendText: sessionSend, getStatus: getWaStatus } = await import('../whatsapp/session.js');
    for (const c of convs) {
      if (!c.workspaceId || pending.has(c.id) || inFlight.has(c.id)) continue;
      // WhatsApp fora do ar: não gasta tentativa (nem IA) agora; tenta quando voltar.
      if (getWaStatus(c.workspaceId).status !== 'connected') continue;
      // Mensagem do lead ainda sem resposta: depois da última já respondida pela IA
      // (ou, em conversas antigas, a última mensagem ser do lead).
      const lastIn = await prisma.message.findFirst({
        where: { conversationId: c.id, direction: 'in' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, createdAt: true },
      });
      if (!lastIn || now - lastIn.createdAt.getTime() < 90_000) continue;
      let unanswered: boolean;
      if (c.aiAnsweredUntil) unanswered = lastIn.createdAt > c.aiAnsweredUntil;
      else {
        const last = await prisma.message.findFirst({
          where: { conversationId: c.id, author: { not: 'system' } },
          orderBy: { createdAt: 'desc' },
          select: { direction: true },
        });
        unanswered = last?.direction === 'in';
      }
      if (!unanswered) continue;
      const last = lastIn;
      const key = `${c.id}:${last.id}`;
      const tries = recoveryTries.get(key) ?? 0;
      if (tries >= 2) continue;
      recoveryTries.set(key, tries + 1);
      const ws = c.workspaceId;
      console.log(`[agentes:${ws}] recuperando resposta pendente da conversa ${c.id} (tentativa ${tries + 1})`);
      schedule(ws, c.id, (jid, text) => sessionSend(ws, jid, text), 500, 0);
    }
    if (recoveryTries.size > 5000) recoveryTries.clear();

    // Retomada: pausada pelo advogado (15 min), pelo roteiro (60 min) ou pelo teto por hora
    // (60 min): lead esperando e equipe sem responder nesse tempo → a IA volta.
    const paused = await prisma.conversation.findMany({
      where: {
        aiEnabled: false,
        aiPausedBy: { in: ['humano', 'roteiro', 'limite'] },
        status: { not: 'closed' },
        lastMessageAt: { gte: new Date(now - 24 * 60 * 60_000) },
      },
      select: { id: true, workspaceId: true, assignedAgentId: true, aiPausedBy: true, aiResumedAt: true },
      orderBy: { lastMessageAt: 'desc' },
      take: 80,
    });
    for (const c of paused) {
      if (!c.workspaceId) continue;
      if (getWaStatus(c.workspaceId).status !== 'connected') continue;
      const minutes = c.aiPausedBy === 'humano' ? AI_RESUME_MIN : 60;
      const limit = minutes * 60_000;
      // Teto por hora: só retoma uma vez a cada 24 h (se for outro robô, não fica em loop).
      if (c.aiPausedBy === 'limite' && c.aiResumedAt && now - c.aiResumedAt.getTime() < 24 * 60 * 60_000) continue;
      const lastIn = await prisma.message.findFirst({
        where: { conversationId: c.id, direction: 'in' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      // Só fala da equipe/IA conta: nota de sistema ("Etapa movida…") depois da mensagem
      // do lead fazia parecer que ele já tinha sido respondido, e a IA nunca retomava.
      const lastOut = await prisma.message.findFirst({
        where: { conversationId: c.id, direction: 'out', author: { in: ['agent', 'ai'] } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (!lastIn || (lastOut && lastOut.createdAt > lastIn.createdAt)) continue; // lead não está esperando
      if (now - lastIn.createdAt.getTime() < limit) continue;
      if (lastOut && now - lastOut.createdAt.getTime() < limit) continue;
      const agent = (c.assignedAgentId && (await getAgent(c.workspaceId, c.assignedAgentId))) || (await getActiveTriage(c.workspaceId));
      if (!agent || !agent.active) continue;
      const updated = await prisma.conversation.update({
        where: { id: c.id },
        data: { aiEnabled: true, aiPausedBy: null, aiResumedAt: new Date(), assignedAgentId: c.assignedAgentId ?? agent.id },
      });
      emit(c.workspaceId, { type: 'conversation:update', conversation: updated });
      const why = c.aiPausedBy === 'humano' ? 'sem resposta da equipe' : c.aiPausedBy === 'roteiro' ? 'depois que o roteiro encerrou, sem resposta da equipe' : 'após a pausa de segurança, sem resposta da equipe';
      await systemNote(c.workspaceId, c.id, `${minutes} minutos ${why}: ${agent.name} retomou o atendimento.`).catch(() => {});
      console.log(`[agentes:${c.workspaceId}] IA retomou a conversa ${c.id} após ${minutes} min (pausa: ${c.aiPausedBy})`);
      const ws = c.workspaceId;
      schedule(ws, c.id, (jid, text) => sessionSend(ws, jid, text), 500, 0);
    }
  } catch (err) {
    console.error('[agentes] recuperação de respostas falhou:', (err as Error).message);
  } finally {
    recovering = false;
  }
}

export function startAiRecoveryLoop() {
  const t = setInterval(() => void recoverPendingReplies(), 60_000);
  t.unref?.();
  // Primeira passada depois que as sessões do WhatsApp tiveram tempo de reconectar.
  const first = setTimeout(() => void recoverPendingReplies(), 45_000);
  first.unref?.();
}


/**
 * Lead de formulário: a IA inicia a conversa no WhatsApp seguindo o roteiro do
 * agente (o lead ainda não escreveu). Não faz nada se já houver conversa com
 * mensagens para este contato.
 */
export async function startAiOutreach(
  ws: string,
  contactId: string,
  agentId: string,
  context: string,
  formName = '',
): Promise<'sent' | 'skipped'> {
  // Lead de formulário conta como lead de campanha (Análise de atendimento).
  const campaign = { campaignSource: 'formulario', campaignAd: formName || 'Formulário', campaignAt: new Date() };
  let agent = agentId ? await getAgent(ws, agentId) : null;
  if (!agent || !agent.active) agent = await getActiveTriage(ws);
  if (!agent) return 'skipped';

  let conversation = await prisma.conversation.findFirst({
    where: { workspaceId: ws, contactId, status: { not: 'closed' } },
    orderBy: { lastMessageAt: 'desc' },
  });
  if (conversation) {
    const hasMsgs = await prisma.message.count({ where: { conversationId: conversation.id, author: { not: 'system' } } });
    if (hasMsgs) return 'skipped'; // lead já está conversando
    conversation = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { aiEnabled: true, assignedAgentId: agent.id, aiContext: context, ...campaign },
    });
  } else {
    conversation = await prisma.conversation.create({
      data: { workspaceId: ws, contactId, aiEnabled: true, assignedAgentId: agent.id, lastMessageAt: new Date(), aiContext: context, ...campaign },
    });
  }
  emit(ws, { type: 'conversation:update', conversation });
  await systemNote(ws, conversation.id, `📋 Lead de formulário: ${agent.name} iniciou a conversa.`);

  const { sendText: sessionSend } = await import('../whatsapp/session.js');
  await respondWithAI(ws, conversation.id, (jid, text) => sessionSend(ws, jid, text), 0, [{ role: 'user', content: context }]);
  return 'sent';
}


/**
 * IA devolvida/ligada ou agente trocado na conversa: responde já o que estiver
 * pendente (antes esperava a recuperação, de 1,5 a 2,5 min, ou o lead escrever de novo).
 */
export async function kickAI(ws: string, conversationId: string) {
  for (const k of recoveryTries.keys()) if (k.startsWith(`${conversationId}:`)) recoveryTries.delete(k);
  transientTries.delete(conversationId);
  const { sendText: sessionSend } = await import('../whatsapp/session.js');
  schedule(ws, conversationId, (jid, text) => sessionSend(ws, jid, text), 800, 0);
}
