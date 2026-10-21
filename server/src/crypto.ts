import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { env } from './env.js';

// Chave derivada do APP_SECRET (persistente). Criptografia transparente:
// valores novos viram "enc:<iv>:<tag>:<dados>"; valores antigos em texto puro
// continuam sendo lidos como estão (migração sem downtime).
const KEY = scryptSync(env.appSecret, 'lawhub-token-enc', 32);
const PREFIX = 'enc:';

/** Criptografa um segredo para guardar no banco. */
export function enc(value: string): string {
  if (!value) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

/** Lê um segredo do banco (descriptografa se estiver cifrado; senão devolve como está). */
export function dec(value: string | null | undefined): string {
  if (!value) return '';
  if (!value.startsWith(PREFIX)) return value; // legado em texto puro
  try {
    const [ivB, tagB, dataB] = value.slice(PREFIX.length).split(':');
    const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
