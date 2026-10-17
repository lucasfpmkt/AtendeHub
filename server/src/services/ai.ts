import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../db.js';
import { env, aiEnabled } from '../env.js';
import { normalizeTurns } from './llm.js';

const client = aiEnabled ? new Anthropic({ apiKey: env.anthropicKey }) : null;

async function getConfig() {
  const cfg = await prisma.aiConfig.upsert({
    where: { id: 'default' },
    update: {},
    create: {
      id: 'default',
      systemPrompt: env.aiSystemPrompt,
      model: env.aiModel,
      autoReply: false,
    },
  });
  return cfg;
}

/**
 * Gera uma resposta sugerida para a conversa, usando o histórico recente
 * como contexto. Sem ANTHROPIC_API_KEY, devolve um rascunho-stub para que
 * o produto rode ponta a ponta mesmo sem provedor configurado.
 */
export async function generateReply(conversationId: string): Promise<string> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      contact: true,
      messages: { orderBy: { createdAt: 'asc' }, take: 20 },
    },
  });
  if (!conversation) throw new Error('Conversa não encontrada');

  const cfg = await getConfig();

  if (!client) {
    const last = conversation.messages.at(-1)?.body ?? '';
    return `[rascunho sem IA] Recebi sua mensagem: "${last.slice(0, 80)}". ` +
      `Configure ANTHROPIC_API_KEY no .env para respostas geradas de verdade.`;
  }

  const history = conversation.messages
    .filter((m: { author: string }) => m.author !== 'system')
    .map((m: { direction: string; body: string }) => ({
    role: (m.direction === 'in' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: m.body,
  }));

  // Garante que a conversa termine com uma fala do cliente.
  if (history.length === 0 || history.at(-1)?.role !== 'user') {
    history.push({ role: 'user', content: '(cliente aguardando resposta)' });
  }

  const resp = await client.messages.create({
    model: cfg.model || env.aiModel,
    max_tokens: 500,
    system:
      `${cfg.systemPrompt}\n\n` +
      `Cliente: ${conversation.contact.name ?? conversation.contact.phone}. ` +
      `Responda de forma breve e útil, pronta para enviar no WhatsApp.`,
    messages: normalizeTurns(history),
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return text || 'Desculpe, não consegui gerar uma resposta agora.';
}

export async function getAiConfig() {
  return getConfig();
}

export async function updateAiConfig(data: {
  systemPrompt?: string;
  autoReply?: boolean;
  model?: string;
}) {
  await getConfig();
  return prisma.aiConfig.update({ where: { id: 'default' }, data });
}
