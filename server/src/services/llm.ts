import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../db.js';
import { env } from '../env.js';

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

export type ProviderKind = 'anthropic' | 'openai';

/** Catálogo de provedores: endpoint, modelos sugeridos e dica da chave. */
export type ProviderPreset = {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string; // '' = Anthropic nativo; 'custom' exige o usuário informar
  defaultModel: string;
  models: string[];
  keyHint: string;
  keyUrl: string; // onde pegar a chave
};

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic · Claude',
    kind: 'anthropic',
    baseUrl: '',
    defaultModel: 'claude-haiku-5-5',
    models: ['claude-haiku-5-5', 'claude-sonnet-4-5', 'claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest'],
    keyHint: 'sk-ant-...',
    keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI · GPT',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini'],
    keyHint: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'gemini',
    label: 'Google · Gemini',
    kind: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.8-flash',
    models: ['gemini-3.8-flash', 'gemini-3.8-pro', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    keyHint: 'AIza...',
    keyUrl: 'https://aistudio.google.com/app/apikey',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyHint: 'sk-...',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'groq',
    label: 'Groq · Llama/Mixtral',
    kind: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    keyHint: 'gsk_...',
    keyUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    kind: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    models: ['mistral-small-latest', 'mistral-large-latest', 'open-mistral-nemo'],
    keyHint: '...',
    keyUrl: 'https://console.mistral.ai/api-keys',
  },
  {
    id: 'xai',
    label: 'xAI · Grok',
    kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-2-latest',
    models: ['grok-2-latest', 'grok-beta'],
    keyHint: 'xai-...',
    keyUrl: 'https://console.x.ai',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter · vários modelos',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    models: [
      'openai/gpt-4o-mini',
      'anthropic/claude-3.5-sonnet',
      'google/gemini-2.0-flash-001',
      'meta-llama/llama-3.3-70b-instruct',
      'deepseek/deepseek-chat',
    ],
    keyHint: 'sk-or-...',
    keyUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'custom',
    label: 'Outro · endpoint compatível com OpenAI',
    kind: 'openai',
    baseUrl: '',
    defaultModel: '',
    models: [],
    keyHint: 'chave da API',
    keyUrl: '',
  },
];

export function providerPreset(id: string | null | undefined): ProviderPreset {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

/** Versão “pública” do catálogo (sem nada sensível) para o seletor do frontend. */
export function providersPublic() {
  return PROVIDERS.map(({ id, label, kind, baseUrl, defaultModel, models, keyHint, keyUrl }) => ({
    id,
    label,
    kind,
    baseUrl,
    defaultModel,
    models,
    keyHint,
    keyUrl,
  }));
}

export type Llm = {
  ready: boolean;
  provider: string;
  model: string;
  complete(opts: { system: string; messages: ChatTurn[]; maxTokens?: number }): Promise<string>;
};

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

async function completeAnthropic(apiKey: string, model: string, opts: { system: string; messages: ChatTurn[]; maxTokens?: number }) {
  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model,
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

/** Qualquer provedor com API no formato da OpenAI (Chat Completions). */
async function completeOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  opts: { system: string; messages: ChatTurn[]; maxTokens?: number },
) {
  const messages = [
    { role: 'system' as const, content: opts.system },
    ...normalizeTurns(opts.messages),
  ];
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: opts.maxTokens ?? 600, messages }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Provedor respondeu ${resp.status}. ${body.slice(0, 300)}`.trim());
  }
  const data: any = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text === 'string') return text.trim();
  // alguns provedores devolvem content em partes
  if (Array.isArray(text)) return text.map((p: any) => p?.text ?? '').join('').trim();
  return '';
}

/** Monta o cliente de IA do workspace a partir da config salva (ou do .env, p/ Anthropic). */
export async function resolveLlm(ws: string): Promise<Llm> {
  const cfg = await prisma.aiConfig.findUnique({ where: { id: ws } });

  // Fallback por variável de ambiente (vale p/ todos os clientes sem chave própria):
  //   AI_PROVIDER (ex.: gemini), AI_API_KEY, AI_BASE_URL (opcional), AI_MODEL (opcional).
  const envProvider = process.env.AI_PROVIDER?.trim();
  const envKey = process.env.AI_API_KEY?.trim();
  const envBase = process.env.AI_BASE_URL?.trim();
  const envModel = process.env.AI_MODEL?.trim();

  // A config salva no painel tem prioridade; depois o ambiente; por fim o preset.
  const provider = cfg?.provider?.trim() || envProvider || 'anthropic';
  const preset = providerPreset(provider);
  const apiKey = cfg?.apiKey?.trim() || envKey || (provider === 'anthropic' ? env.anthropicKey : '') || '';
  const baseUrl = cfg?.baseUrl?.trim() || envBase || preset.baseUrl || '';
  const model = cfg?.model?.trim() || envModel || preset.defaultModel || env.aiModel;
  const ready = Boolean(apiKey) && (preset.kind === 'anthropic' || Boolean(baseUrl));

  return {
    ready,
    provider,
    model,
    async complete(opts) {
      if (!ready) {
        throw new Error(
          apiKey ? 'Falta o endpoint do provedor (baseUrl).' : 'IA não conectada. Escolha um provedor e informe a chave em Ajustes.',
        );
      }
      if (preset.kind === 'anthropic') return completeAnthropic(apiKey, model, opts);
      return completeOpenAICompatible(baseUrl, apiKey, model, opts);
    },
  };
}
