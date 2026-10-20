import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

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
