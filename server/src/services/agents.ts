import { prisma } from '../db.js';
import type { ChatTurn, Llm } from './llm.js';

export type Agent = {
  id: string;
  name: string;
  type: string;
  description: string;
  script: string;
  triggers: string;
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
  | { type: 'notify'; reason: string };
export type AgentReply = { text: string; actions: AgentAction[] };

/** System prompt: roteiro + regras + FAQ + como sinalizar as ações. */
export function buildSystemPrompt(agent: Agent): string {
  const faq = parseFaq(agent.faq);
  return [
    agent.script || '(sem roteiro — atenda com cordialidade e pergunte o motivo do contato)',
    agent.regras ? `\n— Regras de comportamento —\n${agent.regras}` : '',
    faq.length ? `\n— Perguntas frequentes (use quando o cliente perguntar fora do roteiro) —\n${faq.map((f) => `P: ${f.q}\nR: ${f.a}`).join('\n')}` : '',
    '\n— Instruções de operação —',
    'Você está atendendo por WhatsApp. Responda em português do Brasil, de forma natural e humana, mensagens curtas.',
    'Siga o roteiro passo a passo, usando o histórico para saber em que etapa está.',
    'Envie apenas a próxima mensagem do atendimento, sem rótulos, sem marcações de etapa e sem comentários fora do personagem.',
    'AÇÕES: quando o roteiro mandar executar uma ação, escreva a mensagem prevista e, em linhas separadas no FIM, só os marcadores aplicáveis:',
    '- "Transferir para agente: NOME" → [[TRANSFERIR: NOME]]',
    '- "Desativar: agente" (ou quando o cliente pedir para falar com uma pessoa) → [[DESATIVAR]]',
    '- "Mudar etapa: ETAPA" → [[ETAPA: ETAPA]]',
    '- "Adicionar etiqueta: NOME" → [[ETIQUETA: NOME]]',
    '- "Notificar equipe: MOTIVO" → [[NOTIFICAR: MOTIVO]]',
    'Use só os marcadores que o roteiro pedir. Nunca escreva "⚡ Ação" nem os marcadores no meio da mensagem ao cliente.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Separa o texto a enviar do marcador de ação e aplica a assinatura. */
export function parseReply(agent: Agent, raw: string): AgentReply {
  const actions: AgentAction[] = [];
  for (const m of raw.matchAll(/\[\[\s*TRANSFERIR\s*:\s*([^\]]+?)\s*\]\]/gi)) actions.push({ type: 'transfer', agentName: m[1] });
  if (/\[\[\s*DESATIVAR\s*\]\]/i.test(raw)) actions.push({ type: 'deactivate' });
  for (const m of raw.matchAll(/\[\[\s*ETAPA\s*:\s*([^\]]+?)\s*\]\]/gi)) actions.push({ type: 'stage', name: m[1] });
  for (const m of raw.matchAll(/\[\[\s*ETIQUETA\s*:\s*([^\]]+?)\s*\]\]/gi)) actions.push({ type: 'tag', name: m[1] });
  for (const m of raw.matchAll(/\[\[\s*NOTIFICAR\s*:\s*([^\]]+?)\s*\]\]/gi)) actions.push({ type: 'notify', reason: m[1] });
  let text = raw
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/^\s*⚡.*$/gim, '') // por segurança, nunca envia a linha de ação crua
    .trim();
  if (agent.signatureOn && agent.signature.trim() && text) text = `${text}\n\n${agent.signature.trim()}`;
  return { text, actions };
}

/** Gera a resposta de um agente seguindo seu roteiro. */
export async function runAgent(agent: Agent, history: ChatTurn[], llm: Llm): Promise<AgentReply> {
  const raw = await llm.complete({ system: buildSystemPrompt(agent), messages: history, maxTokens: 700 });
  return parseReply(agent, raw);
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
