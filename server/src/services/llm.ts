import Anthropic from '@anthropic-ai/sdk';
import { env, aiEnabled } from '../env.js';

export const anthropic = aiEnabled ? new Anthropic({ apiKey: env.anthropicKey }) : null;
export const llmReady = aiEnabled;

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

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
    messages: opts.messages.length ? opts.messages : [{ role: 'user', content: '(início)' }],
  });
  return resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
