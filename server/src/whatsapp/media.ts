import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Mídia fica junto do volume persistente (mesma base do WA_AUTH_DIR).
const BASE = process.env.WA_AUTH_DIR ?? path.resolve(__dirname, '../../auth_info');
export const MEDIA_DIR = `${BASE}-media`;

export function mediaDirOf(ws: string): string {
  return path.join(MEDIA_DIR, ws);
}

export function mediaFilePath(ws: string, mediaId: string): string {
  return path.join(mediaDirOf(ws), mediaId);
}

/** Salva um arquivo de mídia e devolve o id para referência. */
export async function saveMedia(ws: string, buffer: Buffer): Promise<string> {
  const dir = mediaDirOf(ws);
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  await writeFile(path.join(dir, id), buffer);
  return id;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

export function kindLabel(kind: MediaKind): string {
  return (
    {
      image: '📷 Imagem',
      video: '🎬 Vídeo',
      audio: '🎤 Áudio',
      document: '📎 Documento',
      sticker: 'Figurinha',
    }[kind] ?? 'Arquivo'
  );
}

/** Deduz o tipo a partir do mimetype (para o envio pelo atendente). */
export function kindFromMime(mime: string): MediaKind {
  if (mime.startsWith('image/')) return mime === 'image/webp' ? 'sticker' : 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Converte um áudio qualquer (gravação do navegador em WebM, MP3, M4A…) para
 * OGG/Opus mono — o único formato que o WhatsApp toca como "mensagem de voz".
 * Usa o ffmpeg do servidor; se ele não existir ou falhar, devolve null.
 */
export function toVoiceNote(input: Buffer, timeoutMs = 60_000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: Buffer | null) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let proc;
    try {
      proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1']);
    } catch {
      return finish(null);
    }
    const out: Buffer[] = [];
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    proc.stdout.on('data', (c: Buffer) => out.push(c));
    proc.on('error', () => {
      clearTimeout(timer);
      finish(null); // ffmpeg não instalado
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      finish(code === 0 && buf.length > 0 ? buf : null);
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(input);
  });
}

export type OutgoingMedia = { buffer: Buffer; mimetype: string; filename?: string; caption?: string; kind: MediaKind };

/** Prepara a mídia antes do envio: áudio vira mensagem de voz (OGG/Opus) quando possível. */
export async function prepareOutgoingMedia(m: OutgoingMedia): Promise<OutgoingMedia> {
  if (m.kind !== 'audio' || /ogg/i.test(m.mimetype)) return m;
  const ogg = await toVoiceNote(m.buffer);
  if (!ogg) {
    console.warn('[media] ffmpeg indisponível ou falhou: áudio enviado no formato original');
    return m;
  }
  return { ...m, buffer: ogg, mimetype: 'audio/ogg; codecs=opus', filename: m.filename ? `${m.filename.replace(/\.[^.]+$/, '')}.ogg` : 'audio.ogg' };
}

/* ---------------------- Servir mídia com segurança ---------------------- */
// Arquivos de conversa vêm de qualquer pessoa no WhatsApp, com o tipo que ELA
// informou. Servir "text/html" (ou SVG) aberto no domínio do LawHub executaria o
// código dela logado como o usuário (roubo de sessão). Só estes abrem no navegador:
const INLINE_SAFE = /^(image\/(png|jpe?g|gif|webp|bmp|heic|heif|avif)|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf)$/i;

/** Tipo informado pelo cliente/remetente, saneado (formato "tipo/subtipo"). */
export function sanitizeMime(mime: string | null | undefined): string {
  const m = String(mime ?? '').trim();
  return /^[\w.+-]+\/[\w.+-]+(\s*;\s*[\w.+-]+=[\w.+"-]+)*$/.test(m) ? m : 'application/octet-stream';
}

/** Cabeçalhos para entregar um arquivo de mídia sem risco de executar conteúdo. */
export function safeMediaHeaders(
  res: { setHeader(name: string, value: string): unknown },
  mime: string | null | undefined,
  filename?: string | null,
) {
  const clean = sanitizeMime(mime);
  const base = clean.split(';')[0].trim().toLowerCase();
  const inline = INLINE_SAFE.test(base);
  const name = (filename || 'arquivo').replace(/[\r\n"]/g, '').slice(0, 150);
  res.setHeader('Content-Type', inline ? clean : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Imagem/áudio/vídeo abertos sozinhos: nada de script. (PDF fica de fora: o leitor
  // de PDF do navegador não abre em "sandbox".)
  if (inline && base !== 'application/pdf') {
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  }
}
