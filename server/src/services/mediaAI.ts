import { prisma } from '../db.js';
import { dec } from '../crypto.js';

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Descobre a chave do Gemini para entender mídia (áudio/imagem). Prioridade:
 * 1) chave dedicada de mídia (admin); 2) a chave global, se o provedor for
 * Gemini; 3) a do CRM, se for Gemini; 4) variável de ambiente GEMINI_API_KEY.
 */
async function geminiMediaKey(): Promise<{ key: string; model: string } | null> {
  const p = await prisma.platformConfig.findUnique({ where: { id: 'global' } });
  let key = dec(p?.mediaApiKey).trim();
  if (!key && p?.provider?.trim() === 'gemini') key = dec(p?.apiKey).trim();
  if (!key && p?.crmProvider?.trim() === 'gemini') key = dec(p?.crmApiKey).trim();
  if (!key) key = (process.env.GEMINI_API_KEY ?? '').trim();
  if (!key) return null;
  return { key, model: p?.mediaModel?.trim() || 'gemini-2.5-flash' };
}

/** Indica se há como entender mídia (para avisos na UI). */
export async function mediaUnderstandingReady(): Promise<boolean> {
  return Boolean(await geminiMediaKey());
}

/**
 * Transcreve áudio ou descreve/lê imagem com o Gemini. Devolve texto em
 * português (vazio se não configurado ou se falhar — nunca lança).
 */
export async function understandMedia(media: { kind: string; mimetype: string; buffer: Buffer }): Promise<string> {
  if (media.kind !== 'audio' && media.kind !== 'image') return '';
  const cfg = await geminiMediaKey();
  if (!cfg) return '';
  const prompt =
    media.kind === 'audio'
      ? 'Transcreva este áudio em português do Brasil. Responda apenas com a transcrição, sem comentários.'
      : 'Descreva de forma objetiva o que aparece nesta imagem e, se houver texto nela, transcreva-o. Responda em português do Brasil.';
  const mimeType = media.mimetype.split(';')[0].trim() || (media.kind === 'audio' ? 'audio/ogg' : 'image/jpeg');
  const body = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: media.buffer.toString('base64') } }],
      },
    ],
  };
  try {
    const url = `${GEMINI}/${cfg.model}:generateContent?key=${encodeURIComponent(cfg.key)}`;
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error('[mediaAI] Gemini respondeu', r.status, j?.error?.message || '');
      return '';
    }
    const text: string = (j?.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p.text)
      .filter(Boolean)
      .join(' ')
      .trim();
    return text;
  } catch (err) {
    console.error('[mediaAI] falha:', (err as Error).message);
    return '';
  }
}
