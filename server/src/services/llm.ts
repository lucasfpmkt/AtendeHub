import Anthropic from '@anthropic-ai/sdk';
import { env, aiEnabled } from '../env.js';

export const anthropic = aiEnabled ? new Anthropic({ apiKey: env.anthropicKey }) : null;
export const llmReady = aiEnabled;

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

/**
 * A API exige que a conversa comece pelo cliente (user). Mensagens seguidas do
 * mesmo lado (ex.: o lead manda 3 mensagens) são unidas numa só.
 */
export function normalizeTurns(turns: ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const t of turns) {
    if (!t.content?.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content += `\n${t.content}`;
    else out.push({ ...t });
  }
  if (out.length === 0 || out[0].role !== 'user') out.unshift({ role: 'user', content: '(início da conversa)' });
  if (out[out.length - 1].role !== 'user') out.push({ role: 'user', content: '(cliente aguardando resposta)' });
  return out;
}

/** Chamada de texto simples. Lança se não houver provedor configurado. */
export async function complete(opts: {
  system: string;
  messages: ChatTurn[];
  maxTokens?: number;
  model?: string;
}): Promise<string> {
  if (!anthropic) throw new Error('IA não configurada (defina ANTHROPIC_API_KEY)');
  const resp = await anthropic.messages.create({
    model: opts.model || env.aiModel,
    max_tokens: opts.maxTokens ?? 600,
    system: opts.system,
    messages: normalizeTurns(opts.messages),
  });
  return resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
