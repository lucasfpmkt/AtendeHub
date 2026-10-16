import { prisma } from '../db.js';
import { complete, llmReady, type ChatTurn } from './llm.js';

export type Agent = {
  id: string;
  name: string;
  type: string;
  description: string;
  script: string;
  triggers: string;
  active: boolean;
  delaySeconds: number;
};

export async function getActiveTriage(): Promise<Agent | null> {
  return prisma.agent.findFirst({ where: { type: 'triage', active: true } });
}

export async function getActiveThemeAgents(): Promise<Agent[]> {
  return prisma.agent.findMany({ where: { type: 'theme', active: true }, orderBy: { order: 'asc' } });
}

export async function getAgent(id: string | null | undefined): Promise<Agent | null> {
  if (!id) return null;
  return prisma.agent.findUnique({ where: { id } });
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Casa o texto do cliente contra as palavras-gatilho dos agentes. */
export function matchByTriggers(text: string, agents: Agent[]): Agent | null {
  const hay = normalize(text);
  for (const agent of agents) {
    const triggers = agent.triggers
      .split(/[,;\n]/)
      .map((t) => normalize(t.trim()))
      .filter(Boolean);
    if (triggers.some((t) => hay.includes(t))) return agent;
  }
  return null;
}

/** Usa a IA para escolher o agente de tema mais adequado (ou nenhum). */
export async function classifyByAI(
  themeAgents: Agent[],
  history: ChatTurn[],
): Promise<Agent | null> {
  if (!llmReady || themeAgents.length === 0) return null;
  const catalogo = themeAgents
    .map((a, i) => `${i + 1}. id=${a.id} | ${a.name}: ${a.description || '(sem descrição)'}`)
    .join('\n');
  const system =
    'Você é um roteador de atendimento. Com base na conversa, escolha qual agente ' +
    'especializado deve assumir. Responda APENAS com o id do agente escolhido, ou a ' +
    'palavra "none" se nenhum se encaixar. Não explique.\n\nAgentes disponíveis:\n' +
    catalogo;
  try {
    const out = await complete({ system, messages: history, maxTokens: 40 });
    const pick = out.trim().toLowerCase();
    if (pick.includes('none')) return null;
    return themeAgents.find((a) => pick.includes(a.id.toLowerCase())) ?? null;
  } catch {
    return null;
  }
}

/** Decide o agente de destino: primeiro gatilhos, depois IA. */
export async function decideTarget(
  text: string,
  themeAgents: Agent[],
  history: ChatTurn[],
): Promise<Agent | null> {
  const byTrigger = matchByTriggers(text, themeAgents);
  if (byTrigger) return byTrigger;
  return classifyByAI(themeAgents, history);
}

/** Gera a resposta de um agente seguindo seu diretório. */
export async function runAgent(agent: Agent, history: ChatTurn[]): Promise<string> {
  const system =
    `${agent.script}\n\n` +
    '— Instruções de operação —\n' +
    'Você está atendendo por WhatsApp. Responda em português do Brasil, de forma ' +
    'natural e humana, mensagens curtas. Siga o roteiro acima passo a passo, usando ' +
    'o histórico da conversa para saber em que etapa está. Envie apenas a próxima ' +
    'mensagem do atendimento, sem rótulos, sem marcações de etapa e sem comentários ' +
    'fora do personagem.';
  return complete({ system, messages: history, maxTokens: 700 });
}
