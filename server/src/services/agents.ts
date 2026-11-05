import { prisma } from '../db.js';
import type { ChatTurn, Llm } from './llm.js';

export type Agent = {
  id: string;
  name: string;
  type: string;
  description: string;
  script: string;
  triggers: string;
  funnelId: string | null;
  regras: string;
  faq: string;
  signatureOn: boolean;
  signature: string;
  active: boolean;
  delaySeconds: number;
};

export type FaqItem = { q: string; a: string };

export function parseFaq(raw: string | null | undefined): FaqItem[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v)
      ? v.map((x) => ({ q: String(x?.q ?? ''), a: String(x?.a ?? '') })).filter((x) => x.q.trim())
      : [];
  } catch {
    return [];
  }
}

export async function getActiveTriage(ws: string): Promise<Agent | null> {
  return prisma.agent.findFirst({ where: { workspaceId: ws, type: 'triage', active: true }, orderBy: { order: 'asc' } });
}

/** Todos os agentes principais (triagem) ativos, na ordem do painel. */
export async function getActiveTriageAgents(ws: string): Promise<Agent[]> {
  return prisma.agent.findMany({ where: { workspaceId: ws, type: 'triage', active: true }, orderBy: { order: 'asc' } });
}

/**
 * Agente principal cujo GATILHO bate com a mensagem. Vários clientes usam um agente
 * principal por campanha (cada um com seus gatilhos): antes só o 1º era conferido e
 * os gatilhos dos outros nunca ligavam a IA. Se mais de um bater, vence o gatilho
 * mais longo (o mais específico).
 */
export async function triageByTrigger(ws: string, text: string): Promise<Agent | null> {
  const hay = normalize(text);
  let best: { agent: Agent; len: number } | null = null;
  for (const agent of await getActiveTriageAgents(ws)) {
    for (const t of splitTriggers(agent.triggers)) {
      const n = normalize(t);
      if (n && hay.includes(n) && (!best || n.length > best.len)) best = { agent, len: n.length };
    }
  }
  return best?.agent ?? null;
}

export async function getActiveThemeAgents(ws: string): Promise<Agent[]> {
  return prisma.agent.findMany({ where: { workspaceId: ws, type: 'theme', active: true }, orderBy: { order: 'asc' } });
}

export async function getAgent(ws: string, id: string | null | undefined): Promise<Agent | null> {
  if (!id) return null;
  return prisma.agent.findFirst({ where: { id, workspaceId: ws } });
}

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/["“”.,!?]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitTriggers(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Casa o texto do cliente contra as palavras-gatilho dos agentes. */
export function matchByTriggers(text: string, agents: Agent[]): Agent | null {
  const hay = normalize(text);
  for (const agent of agents) {
    if (splitTriggers(agent.triggers).some((t) => hay.includes(normalize(t)))) return agent;
  }
  return null;
}

/**
 * Porta de entrada (como na Guimoo): se a triagem tem gatilhos, ela só assume
 * conversas cuja mensagem bate com algum gatilho dela ou dos agentes de tema.
 * Triagem sem gatilhos atende todas as conversas novas (comportamento antigo).
 */
export async function shouldTriageStart(ws: string, triage: Agent, text: string): Promise<boolean> {
  if (splitTriggers(triage.triggers).length === 0) return true;
  if (matchByTriggers(text, [triage])) return true;
  return Boolean(matchByTriggers(text, await getActiveThemeAgents(ws)));
}

/**
 * Houve correspondência com um GATILHO EXPLÍCITO (palavra-chave da triagem ou
 * de um agente de tema)? Diferente de shouldTriageStart, NÃO considera o caso
 * "sem gatilho = sempre começa". Serve para reativar a IA sempre que um gatilho
 * cadastrado chegar, mesmo após atendimento manual.
 */
export async function matchesTrigger(ws: string, triage: Agent, text: string): Promise<boolean> {
  if (splitTriggers(triage.triggers).length > 0 && matchByTriggers(text, [triage])) return true;
  return Boolean(matchByTriggers(text, await getActiveThemeAgents(ws)));
}

export async function findAgentByName(ws: string, name: string): Promise<Agent | null> {
  const target = normalize(name);
  const agents = await prisma.agent.findMany({ where: { workspaceId: ws, active: true } });
  return (
    agents.find((a) => normalize(a.name) === target) ??
    agents.find((a) => normalize(a.name).includes(target) || target.includes(normalize(a.name))) ??
    null
  );
}

/** O roteiro usa as ações explícitas da Guimoo ("⚡ Ação: Transferir…")? */
export function scriptHasActions(agent: Agent): boolean {
  return /transferir\s+para\s+agente|desativar\s*:\s*agente/i.test(agent.script);
}

/** Usa a IA para escolher o agente de tema mais adequado (ou nenhum). */
export async function classifyByAI(themeAgents: Agent[], history: ChatTurn[], llm: Llm): Promise<Agent | null> {
  if (!llm.ready || themeAgents.length === 0) return null;
  const catalogo = themeAgents
    .map((a, i) => `${i + 1}. id=${a.id} | ${a.name}: ${a.description || '(sem descrição)'}`)
    .join('\n');
  const system =
    'Você é um roteador de atendimento. Com base na conversa, escolha qual agente ' +
    'especializado deve assumir. Responda APENAS com o id do agente escolhido, ou a ' +
    'palavra "none" se nenhum se encaixar ou se o cliente ainda não explicou o caso. ' +
    'Não explique.\n\nAgentes disponíveis:\n' +
    catalogo;
  try {
    const out = await llm.complete({ system, messages: history, maxTokens: 40 });
    const pick = out.trim().toLowerCase();
    if (pick.includes('none')) return null;
    return themeAgents.find((a) => pick.includes(a.id.toLowerCase())) ?? null;
  } catch {
    return null;
  }
}

/** Decide o agente de destino: primeiro gatilhos, depois IA. */
export async function decideTarget(text: string, themeAgents: Agent[], history: ChatTurn[], llm: Llm): Promise<Agent | null> {
  const byTrigger = matchByTriggers(text, themeAgents);
  if (byTrigger) return byTrigger;
  return classifyByAI(themeAgents, history, llm);
}

/* -------------------------------------------------------------------------- */
/* Resposta do agente                                                          */
/* -------------------------------------------------------------------------- */

export type AgentAction =
  | { type: 'transfer'; agentName: string }
  | { type: 'deactivate' }
  | { type: 'stage'; name: string }
  | { type: 'tag'; name: string }
  | { type: 'notify'; reason: string }
  | { type: 'media'; name: string };
export type AgentReply = { text: string; actions: AgentAction[]; raw?: string };

/** System prompt: roteiro + regras + FAQ + como sinalizar as ações. */
export function buildSystemPrompt(agent: Agent, mediaNames: string[] = []): string {
  const faq = parseFaq(agent.faq);
  // Data de hoje (Brasília): o roteiro pode usar {{data_atual_sistema}} / {{data_atual}}
  // (ex.: cálculo de prescrição) e o modelo não sabe a data sozinho.
  const now = new Date();
  const hoje = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }).format(now);
  const semana = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long' }).format(now);
  const script = (agent.script || '').replace(/\{\{\s*data_atual(?:_sistema)?\s*\}\}/gi, hoje);
  return [
    script || '(sem roteiro — atenda com cordialidade e pergunte o motivo do contato)',
    agent.regras ? `\n— Regras de comportamento —\n${agent.regras}` : '',
    faq.length ? `\n— Perguntas frequentes (use quando o cliente perguntar fora do roteiro) —\n${faq.map((f) => `P: ${f.q}\nR: ${f.a}`).join('\n')}` : '',
    '\n— Instruções de operação —',
    'Você está atendendo por WhatsApp. Responda em português do Brasil, de forma natural e humana, mensagens curtas.',
    'Siga o roteiro passo a passo, usando o histórico para saber em que etapa está.',
    'Envie apenas a próxima mensagem do atendimento, sem rótulos, sem marcações de etapa e sem comentários fora do personagem.',
    'Toda resposta precisa ter uma mensagem para o cliente. As linhas "⚡ Ação" do roteiro são instruções para você, nunca texto para copiar: execute-as com os marcadores abaixo.',
    'AÇÕES: quando o roteiro mandar executar uma ação, escreva a mensagem prevista e, em linhas separadas no FIM, só os marcadores aplicáveis:',
    '- "Transferir para agente: NOME" → [[TRANSFERIR: NOME]]',
    '- "Desativar: agente" → [[DESATIVAR]] (só quando o roteiro mandar desativar; se o lead pedir para falar com o advogado ou com uma pessoa, siga o que o roteiro diz para esse caso e continue o atendimento)',
    '- "Mudar etapa: ETAPA" → [[ETAPA: ETAPA]]',
    '- "Adicionar etiqueta: NOME" → [[ETIQUETA: NOME]]',
    '- "Notificar equipe: MOTIVO" → [[NOTIFICAR: MOTIVO]]',
    '- "Enviar mídia: NOME" → [[MIDIA: NOME]] (envia o arquivo dessa mídia ao cliente, depois do texto)',
    mediaNames.length
      ? `Mídias disponíveis para enviar (use o nome exato): ${mediaNames.map((n) => `"${n}"`).join(', ')}. Envie só quando o roteiro mandar.`
      : '',
    'Use só os marcadores que o roteiro pedir. Nunca escreva "⚡ Ação" nem os marcadores no meio da mensagem ao cliente. Todo marcador abre com [[ e fecha com ]] na mesma linha.',
    'Estilo: não comece as mensagens com o nome do cliente nem com "Obrigada", "Entendi" ou "Anotei". Use o nome do cliente com moderação (no máximo uma vez a cada várias mensagens). Não repita nem resuma de volta o que o cliente acabou de responder: siga direto para a próxima pergunta ou etapa.',
    'Nunca pergunte de novo algo que o cliente já respondeu nesta conversa ou no formulário.',
    'Se a conversa começar com "[CONTEXTO PARA A IA", são dados que o próprio lead preencheu num formulário de anúncio: use-os e não pergunte de novo o que já está ali.',
    `Data de hoje: ${hoje} (${semana}), horário de Brasília. Use sempre esta data para qualquer cálculo de prazo.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Separa o texto a enviar do marcador de ação e aplica a assinatura. */
export function parseReply(agent: Agent, raw: string): AgentReply {
  const actions: AgentAction[] = [];
  for (const m of raw.matchAll(/\[\[\s*TRANSFERIR\s*:\s*([^\]]+?)\s*\]\]/gi)) actions.push({ type: 'transfer', agentName: m[1] });
  if (/\[\[\s*DESATIVAR\s*\]\]/i.test(raw)) actions.push({ type: 'deactivate' });
  // Etapa/etiqueta/notificar/mídia valem mesmo se o marcador vier sem o "]]" final
  // (resposta cortada): o valor vai até o fim da linha. Transferir/Desativar exigem
  // o marcador completo, por segurança.
  const safe = (tag: string) => new RegExp(`\\[\\[\\s*${tag}\\s*:\\s*([^\\]\\n]+?)\\s*(?:\\]\\]|\\]?\\s*$)`, 'gim');
  for (const m of raw.matchAll(safe('ETAPA'))) if (!/[›»>|]\s*$/.test(m[1])) actions.push({ type: 'stage', name: m[1] }); // "Funil ›" cortado: ignora
  for (const m of raw.matchAll(safe('ETIQUETA'))) actions.push({ type: 'tag', name: m[1] });
  for (const m of raw.matchAll(safe('NOTIFICAR'))) actions.push({ type: 'notify', reason: m[1] });
  for (const m of raw.matchAll(safe('M[IÍ]DIA'))) actions.push({ type: 'media', name: m[1] });
  // O modelo às vezes copia a linha do roteiro ("⚡ Ação: Mudar etapa: X") em vez
  // do marcador [[...]]: entende essas linhas também, para a ação não se perder.
  if (!actions.length) {
    for (const m of raw.matchAll(/^\s*⚡\s*A[çc][ãa]o\s*:\s*(.+)$/gim)) {
      const line = m[1].trim();
      const val = (re: RegExp) => line.match(re)?.[1]?.replace(/\(.*\)\s*$/, '').trim();
      let v: string | undefined;
      // Transferir/Desativar NÃO são inferidos de linha copiada: o modelo às vezes
      // repete blocos inteiros do roteiro e isso encerrava a conversa no meio.
      // Essas duas só valem com o marcador explícito [[TRANSFERIR]] / [[DESATIVAR]].
      if ((v = val(/^mudar\s+(?:de\s+)?etapa\s*:\s*(.+)$/i))) actions.push({ type: 'stage', name: v });
      else if ((v = val(/^adicionar\s+etiqueta\s*:\s*(.+)$/i))) actions.push({ type: 'tag', name: v });
      else if ((v = val(/^notificar(?:\s+equipe)?\s*:\s*(.+)$/i))) actions.push({ type: 'notify', reason: v });
      else if ((v = val(/^enviar\s+m[ií]dia\s*:\s*(.+)$/i))) actions.push({ type: 'media', name: v });
    }
  }
  let text = raw
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/\[\[.*$/gm, '') // marcador sem fechamento (resposta cortada): nunca vai ao cliente
    .replace(/^\s*⚡.*$/gim, '') // por segurança, nunca envia a linha de ação crua
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (agent.signatureOn && agent.signature.trim() && text) text = `${text}\n\n${agent.signature.trim()}`;
  return { text, actions };
}

/** Gera a resposta de um agente seguindo seu roteiro. */
export async function runAgent(agent: Agent, history: ChatTurn[], llm: Llm, mediaNames: string[] = []): Promise<AgentReply> {
  const system = buildSystemPrompt(agent, mediaNames);
  const raw = await llm.complete({ system, messages: history, maxTokens: 2000 });
  const reply = parseReply(agent, raw);
  if (reply.text) return reply;
  // Veio sem mensagem ao cliente (só ação, linha do roteiro ou vazio): pede de novo,
  // deixando claro que precisa da mensagem. Mantém as ações da 1ª tentativa.
  console.warn(`[agentes] ${agent.name}: resposta sem mensagem ao cliente, tentando de novo. Bruto: ${JSON.stringify(raw.slice(0, 300))}`);
  const raw2 = await llm.complete({
    system:
      system +
      '\n\nIMPORTANTE: escreva agora a mensagem que vai para o cliente no WhatsApp (texto natural, sem "⚡ Ação" e sem rótulos). Se o roteiro pedir uma ação, coloque o marcador [[...]] numa linha separada no FIM, depois da mensagem.',
    messages: history,
    maxTokens: 2000,
  });
  const second = parseReply(agent, raw2);
  if (!second.text) console.warn(`[agentes] ${agent.name}: 2ª tentativa também sem mensagem. Bruto: ${JSON.stringify(raw2.slice(0, 300))}`);
  return { text: second.text, actions: second.actions.length ? second.actions : reply.actions, raw: second.text ? undefined : raw2 || raw };
}

/** Resposta sem provedor de IA: a primeira "Mensagem:" do roteiro (para testes). */
export function offlineReply(agent: Agent, history: ChatTurn[]): AgentReply {
  const first = !history.some((h) => h.role === 'assistant');
  const m = agent.script.match(/Mensagem:\s*[“"]([\s\S]+?)[”"]/);
  return {
    text: first && m ? m[1].trim() : '[modo offline] Defina ANTHROPIC_API_KEY para o agente seguir o roteiro de verdade.',
    actions: [],
  };
}

export async function logAgent(agentId: string, action: string) {
  await prisma.agentHistory.create({ data: { agentId, action } });
}
