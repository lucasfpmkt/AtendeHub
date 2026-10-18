import { prisma } from '../db.js';
import { env } from '../env.js';
import { resolveLlm } from './llm.js';

/** Configuração de IA do cliente (id = workspaceId). */
async function getConfig(ws: string) {
  return prisma.aiConfig.upsert({
    where: { id: ws },
    update: {},
    create: { id: ws, systemPrompt: env.aiSystemPrompt, model: env.aiModel, autoReply: false },
  });
}

/**
 * Rascunho de resposta para a conversa (botão de IA no chat), usando o
 * histórico recente. Sem ANTHROPIC_API_KEY devolve um texto de exemplo.
 */
export async function generateReply(ws: string, conversationId: string): Promise<string> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId: ws },
    include: {
      contact: true,
      messages: { where: { author: { not: 'system' } }, orderBy: { createdAt: 'desc' }, take: 20 },
    },
  });
  if (!conversation) throw new Error('Conversa não encontrada');

  const cfg = await getConfig(ws);
  const history = conversation.messages.reverse().map((m) => ({
    role: (m.direction === 'in' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: m.body,
  }));

  const llm = await resolveLlm(ws);
  if (!llm.ready) {
    const last = history.filter((h) => h.role === 'user').at(-1)?.content ?? '';
    return (
      `[rascunho sem IA] Recebi sua mensagem: "${last.slice(0, 80)}". ` +
      'Conecte um provedor de IA em Ajustes para respostas geradas de verdade.'
    );
  }

  const text = await llm.complete({
    system:
      `${cfg.systemPrompt}\n\n` +
      `Cliente: ${conversation.contact.name ?? conversation.contact.phone}. ` +
      'Responda de forma breve e útil, pronta para enviar no WhatsApp.',
    messages: history,
    maxTokens: 500,
  });
  return text || 'Desculpe, não consegui gerar uma resposta agora.';
}

export async function getAiConfig(ws: string) {
  return getConfig(ws);
}

export type AiConfigPatch = {
  systemPrompt?: string;
  autoReply?: boolean;
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string; // só grava quando vier string não-vazia (ou clearKey)
  clearKey?: boolean;
};

export async function updateAiConfig(ws: string, data: AiConfigPatch) {
  await getConfig(ws);
  const patch: Record<string, unknown> = {};
  if (typeof data.systemPrompt === 'string') patch.systemPrompt = data.systemPrompt;
  if (typeof data.autoReply === 'boolean') patch.autoReply = data.autoReply;
  if (typeof data.provider === 'string') patch.provider = data.provider;
  if (typeof data.model === 'string') patch.model = data.model;
  if (typeof data.baseUrl === 'string') patch.baseUrl = data.baseUrl.trim();
  if (data.clearKey) patch.apiKey = '';
  else if (typeof data.apiKey === 'string' && data.apiKey.trim()) patch.apiKey = data.apiKey.trim();
  return prisma.aiConfig.update({ where: { id: ws }, data: patch });
}
