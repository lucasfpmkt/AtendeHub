/**
 * Entende mídia recebida no WhatsApp: transcreve áudio, lê imagem e resume PDF.
 *
 * Ordem de tentativa (cada provedor com até 3 tentativas em erro passageiro):
 *  1. Gemini (chave de mídia do admin, ou a chave Gemini dos agentes/CRM, ou GEMINI_API_KEY)
 *  2. Áudio: Whisper na OpenAI/Groq (chave reserva em Clientes › IA de mídia)
 *     Imagem/PDF: Anthropic (chave global dos agentes, se o provedor for Anthropic)
 *
 * Nunca lança: devolve `status` para o atendimento saber o que aconteceu
 * ("failed" vira "[🎧 Áudio não transcrito]" e a IA pede para o lead escrever).
 * Chave recusada ou cota esgotada avisa o administrador (com intervalo).
 */
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '../db.js';
import { dec } from '../crypto.js';
import { env } from '../env.js';
import { alertAdmin } from './alerts.js';

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_INLINE = 15 * 1024 * 1024; // acima disso nenhum provedor aceita inline

export type MediaUnderstanding = {
  /** Texto obtido (transcrição / descrição / resumo). Vazio quando não deu. */
  text: string;
  /** ok = entendeu; failed = tentou e não conseguiu; unconfigured = sem chave; unsupported = tipo não tratado */
  status: 'ok' | 'failed' | 'unconfigured' | 'unsupported';
  via?: string;
};

type Media = { kind: string; mimetype: string; buffer: Buffer };

/** Tipos que sabemos entender. */
export function canUnderstand(media: { kind: string; mimetype: string }): boolean {
  if (media.kind === 'audio' || media.kind === 'image') return true;
  return media.kind === 'document' && /^application\/pdf\b/i.test(media.mimetype);
}

/* --------------------------------- config --------------------------------- */

type MediaCfg = {
  gemini: { key: string; model: string } | null;
  whisper: { provider: 'openai' | 'groq'; key: string } | null;
  anthropic: { key: string; model: string } | null;
};

async function mediaConfig(): Promise<MediaCfg> {
  const p = await prisma.platformConfig.findUnique({ where: { id: 'global' } });
  let gkey = dec(p?.mediaApiKey).trim();
  if (!gkey && p?.provider?.trim() === 'gemini') gkey = dec(p?.apiKey).trim();
  if (!gkey && p?.crmProvider?.trim() === 'gemini') gkey = dec(p?.crmApiKey).trim();
  if (!gkey) gkey = (process.env.GEMINI_API_KEY ?? '').trim();

  const fbProvider = (p?.mediaFallbackProvider ?? '').trim() as 'openai' | 'groq' | '';
  let fbKey = dec(p?.mediaFallbackApiKey).trim();
  // Sem chave reserva própria: reaproveita a chave dos agentes/CRM se for OpenAI ou Groq.
  let whisper: MediaCfg['whisper'] = fbProvider && fbKey ? { provider: fbProvider, key: fbKey } : null;
  if (!whisper) {
    for (const [prov, key] of [[p?.provider, p?.apiKey], [p?.crmProvider, p?.crmApiKey]] as const) {
      const pr = (prov ?? '').trim();
      const k = dec(key).trim();
      if ((pr === 'openai' || pr === 'groq') && k) {
        whisper = { provider: pr, key: k };
        break;
      }
    }
  }

  let akey = '';
  let amodel = '';
  if (p?.provider?.trim() === 'anthropic') {
    akey = dec(p?.apiKey).trim();
    amodel = p?.model?.trim() || '';
  }
  if (!akey) akey = (env.anthropicKey ?? '').trim();
  const anthropic = akey ? { key: akey, model: amodel || 'claude-haiku-5-5' } : null;

  return { gemini: gkey ? { key: gkey, model: p?.mediaModel?.trim() || 'gemini-2.5-flash' } : null, whisper, anthropic };
}

/** Indica se há como entender mídia (para avisos na UI). */
export async function mediaUnderstandingReady(): Promise<boolean> {
  const c = await mediaConfig();
  return Boolean(c.gemini || c.whisper || c.anthropic);
}

/* ------------------------------ erros / retry ------------------------------ */

class ProviderError extends Error {
  constructor(public provider: string, public status: number, message: string) {
    super(message);
  }
}

function retryable(err: unknown): boolean {
  if (err instanceof ProviderError) {
    // Cota diária esgotada / sem faturamento não volta em segundos: vai direto para a reserva.
    if (err.status === 429 && /per day|limit: 0|billing|quota exceeded for quota metric/i.test(err.message)) return false;
    return err.status === 429 || err.status >= 500 || err.status === 0;
  }
  const m = String((err as Error)?.message ?? err).toLowerCase();
  return /timeout|timed out|aborted|econnreset|etimedout|fetch failed|socket hang up|network/.test(m);
}

/**
 * Até 3 tentativas em erro passageiro (429/5xx/rede), esperando 1,5 s e depois 4 s.
 * Respeita um prazo total: a mensagem do lead fica esperando enquanto isso.
 */
async function withRetry<T>(label: string, fn: () => Promise<T>, deadline: number): Promise<T> {
  const waits = [1500, 4000];
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= waits.length || !retryable(err) || Date.now() + waits[i] > deadline) throw err;
      console.warn(`[mediaAI] ${label}: ${(err as Error).message} — tentando de novo em ${waits[i] / 1000}s`);
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }
}

const ATTEMPT_TIMEOUT = 30_000; // cada chamada
const TOTAL_BUDGET = 90_000; // todas as tentativas de todos os provedores

/** Chave recusada / cota esgotada: o admin precisa agir, então avisa (1x por hora por tipo). */
function reportMediaFailure(err: unknown) {
  if (!(err instanceof ProviderError)) return;
  const low = err.message.toLowerCase();
  if (err.status === 401 || err.status === 403 || /api key not valid|invalid api key|permission denied|unauthorized/.test(low)) {
    void alertAdmin('media_auth', `A chave de IA de mídia (*${err.provider}*) foi recusada: áudios e imagens dos leads não estão sendo entendidos. Confira em Clientes › IA de mídia.\n\nErro: ${err.message.slice(0, 160)}`);
  } else if (err.status === 429 && /quota|resource_exhausted|exceeded|billing|limit: 0|per day/.test(low)) {
    void alertAdmin('media_quota', `A cota da IA de mídia (*${err.provider}*) esgotou: áudios dos leads estão chegando sem transcrição. Ative o faturamento do projeto no Google AI Studio ou cadastre uma chave reserva (OpenAI/Groq) em Clientes › IA de mídia.\n\nErro: ${err.message.slice(0, 160)}`);
  } else if (err.status === 404) {
    void alertAdmin('media_model', `O modelo de IA de mídia (*${err.provider}*) não existe ou não está disponível para a chave. Confira o nome em Clientes › IA de mídia.\n\nErro: ${err.message.slice(0, 160)}`);
  }
}

/* -------------------------------- provedores -------------------------------- */

function promptFor(kind: string): string {
  if (kind === 'audio') return 'Transcreva este áudio em português do Brasil, fiel ao que foi dito. Responda apenas com a transcrição, sem comentários. Se não houver fala, responda apenas: (sem fala)';
  if (kind === 'image') return 'Descreva de forma objetiva o que aparece nesta imagem e, se houver texto nela, transcreva-o integralmente (ex.: contrato, extrato, mensagem, documento). Responda em português do Brasil, sem comentários.';
  return 'Leia este documento e responda em português do Brasil: 1) que tipo de documento é; 2) os dados essenciais (nomes, empresa, datas, valores, números de processo/contrato); 3) um resumo de até 5 linhas do conteúdo. Sem comentários extras.';
}

async function viaGemini(cfg: NonNullable<MediaCfg['gemini']>, media: Media): Promise<string> {
  const mimeType = media.mimetype.split(';')[0].trim() || (media.kind === 'audio' ? 'audio/ogg' : media.kind === 'image' ? 'image/jpeg' : 'application/pdf');
  const body = {
    contents: [{ role: 'user', parts: [{ text: promptFor(media.kind) }, { inline_data: { mime_type: mimeType, data: media.buffer.toString('base64') } }] }],
    generationConfig: { temperature: 0.1 },
  };
  const url = `${GEMINI}/${cfg.model}:generateContent?key=${encodeURIComponent(cfg.key)}`;
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ATTEMPT_TIMEOUT) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new ProviderError('gemini', r.status, j?.error?.message || `HTTP ${r.status}`);
  const text: string = (j?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text).filter(Boolean).join(' ').trim();
  if (!text) {
    const reason = j?.candidates?.[0]?.finishReason || j?.promptFeedback?.blockReason || 'resposta vazia';
    throw new ProviderError('gemini', 0, `sem texto (${reason})`);
  }
  return text;
}

async function viaWhisper(cfg: NonNullable<MediaCfg['whisper']>, media: Media): Promise<string> {
  const base = cfg.provider === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1';
  const model = cfg.provider === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1';
  const mime = media.mimetype.split(';')[0].trim() || 'audio/ogg';
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('mpeg') || mime.includes('mp3') ? 'mp3' : mime.includes('wav') ? 'wav' : mime.includes('webm') ? 'webm' : 'ogg';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(media.buffer)], { type: mime }), `audio.${ext}`);
  form.append('model', model);
  form.append('language', 'pt');
  form.append('response_format', 'json');
  const r = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${cfg.key}` }, body: form, signal: AbortSignal.timeout(ATTEMPT_TIMEOUT) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new ProviderError(cfg.provider, r.status, j?.error?.message || `HTTP ${r.status}`);
  const text = String(j?.text ?? '').trim();
  if (!text) throw new ProviderError(cfg.provider, 0, 'transcrição vazia');
  return text;
}

async function viaAnthropic(cfg: NonNullable<MediaCfg['anthropic']>, media: Media): Promise<string> {
  const client = new Anthropic({ apiKey: cfg.key, timeout: ATTEMPT_TIMEOUT, maxRetries: 0 });
  const mime = media.mimetype.split(';')[0].trim();
  const data = media.buffer.toString('base64');
  const block: any =
    media.kind === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: /^(image\/(jpeg|png|gif|webp))$/.test(mime) ? mime : 'image/jpeg', data } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  try {
    const resp = await client.messages.create({
      model: cfg.model,
      max_tokens: 1200,
      messages: [{ role: 'user', content: [block, { type: 'text', text: promptFor(media.kind) }] }],
    });
    const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!text) throw new ProviderError('anthropic', 0, 'resposta vazia');
    return text;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    const e = err as { status?: number; message?: string };
    throw new ProviderError('anthropic', Number(e?.status ?? 0), String(e?.message ?? err));
  }
}

/* --------------------------------- público --------------------------------- */

/**
 * Transcreve áudio, descreve/lê imagem ou resume PDF. Nunca lança.
 */
export async function understandMedia(media: Media): Promise<MediaUnderstanding> {
  if (!canUnderstand(media)) return { text: '', status: 'unsupported' };
  if (media.buffer.length > MAX_INLINE) return { text: '', status: 'unsupported' };
  if (media.buffer.length === 0) return { text: '', status: 'failed' };

  const cfg = await mediaConfig();
  const chain: { name: string; run: () => Promise<string> }[] = [];
  if (cfg.gemini) chain.push({ name: `gemini:${cfg.gemini.model}`, run: () => viaGemini(cfg.gemini!, media) });
  if (media.kind === 'audio') {
    if (cfg.whisper) chain.push({ name: `${cfg.whisper.provider}:whisper`, run: () => viaWhisper(cfg.whisper!, media) });
  } else if (cfg.anthropic) {
    chain.push({ name: `anthropic:${cfg.anthropic.model}`, run: () => viaAnthropic(cfg.anthropic!, media) });
  }
  if (!chain.length) return { text: '', status: 'unconfigured' };

  let lastErr: unknown = null;
  const deadline = Date.now() + TOTAL_BUDGET;
  for (const step of chain) {
    if (Date.now() > deadline) break;
    try {
      const text = await withRetry(step.name, step.run, deadline);
      if (/^\(sem fala\)$/i.test(text)) return { text: '', status: 'failed', via: step.name };
      return { text, status: 'ok', via: step.name };
    } catch (err) {
      lastErr = err;
      console.error(`[mediaAI] ${step.name} falhou (${media.kind}):`, (err as Error).message);
      reportMediaFailure(err);
    }
  }
  return { text: '', status: 'failed', via: lastErr instanceof ProviderError ? lastErr.provider : undefined };
}

/** Compatibilidade: só o texto (vazio se falhou). */
export async function understandMediaText(media: Media): Promise<string> {
  return (await understandMedia(media)).text;
}
