// Integração com a API Oficial do WhatsApp (Meta Cloud API) via Graph API.
import type { MediaKind } from './media.js';

const GRAPH = `https://graph.facebook.com/${process.env.GRAPH_VERSION ?? 'v21.0'}`;

/** Só os dígitos do telefone (a Cloud API usa o número puro no campo "to"). */
export function digits(s: string): string {
  return s.replace(/\D/g, '');
}

/** Envia texto pela Cloud API. Devolve o id da mensagem. */
export async function sendTextCloud(phoneId: string, token: string, to: string, text: string): Promise<string | undefined> {
  const resp = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: digits(to), type: 'text', text: { body: text } }),
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `WhatsApp API respondeu ${resp.status}`);
  return data?.messages?.[0]?.id;
}

/** Faz upload da mídia e envia pela Cloud API. */
export async function sendMediaCloud(
  phoneId: string,
  token: string,
  to: string,
  opts: { buffer: Buffer; mimetype: string; filename?: string; caption?: string; kind: MediaKind },
): Promise<string | undefined> {
  // 1) upload do arquivo → media id
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', opts.mimetype);
  form.append('file', new Blob([new Uint8Array(opts.buffer)], { type: opts.mimetype }), opts.filename || 'arquivo');
  const up = await fetch(`${GRAPH}/${phoneId}/media`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
  const upData: any = await up.json().catch(() => ({}));
  if (!up.ok) throw new Error(upData?.error?.message || `Falha ao enviar o arquivo (${up.status})`);
  const mediaId = upData.id;

  // 2) envia a mensagem referenciando o media id
  const type = opts.kind; // image | video | audio | document | sticker
  const media: Record<string, unknown> = { id: mediaId };
  const caption = opts.caption?.trim();
  if (caption && (type === 'image' || type === 'video' || type === 'document')) media.caption = caption;
  if (type === 'document' && opts.filename) media.filename = opts.filename;

  const resp = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: digits(to), type, [type]: media }),
  });
  const data: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data?.error?.message || `WhatsApp API respondeu ${resp.status}`);
  return data?.messages?.[0]?.id;
}

/** Baixa uma mídia recebida (dois passos: pega a URL e depois os bytes). */
export async function downloadCloudMedia(token: string, mediaId: string): Promise<{ buffer: Buffer; mimetype: string }> {
  const metaResp = await fetch(`${GRAPH}/${mediaId}`, { headers: { authorization: `Bearer ${token}` } });
  const meta: any = await metaResp.json().catch(() => ({}));
  if (!metaResp.ok || !meta?.url) throw new Error('não foi possível obter a mídia');
  const bin = await fetch(meta.url, { headers: { authorization: `Bearer ${token}` } });
  const buffer = Buffer.from(await bin.arrayBuffer());
  return { buffer, mimetype: meta.mime_type || 'application/octet-stream' };
}

/** Marca uma mensagem recebida como lida (opcional, melhora os "vistos"). */
export async function markReadCloud(phoneId: string, token: string, messageId: string) {
  await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
  }).catch(() => {});
}
