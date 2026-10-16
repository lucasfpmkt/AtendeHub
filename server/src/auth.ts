import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from './env.js';

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 dias

function b64url(buf: Buffer | string) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function sign(payload: string) {
  return b64url(
    crypto.createHmac('sha256', env.appSecret).update(payload).digest(),
  );
}

/** Gera um token assinado (payload.assinatura). */
export function issueToken(): string {
  const payload = b64url(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

/** Valida o token: assinatura correta e não expirado. */
export function verifyToken(token?: string | null): boolean {
  if (!token) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = sign(payload);
  // Comparação em tempo constante.
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return false;
  }
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64').toString());
    return typeof exp === 'number' && exp > Date.now();
  } catch {
    return false;
  }
}

/** Confere a senha de acesso (tempo constante). */
export function checkPassword(password: string): boolean {
  const a = Buffer.from(String(password));
  const b = Buffer.from(env.appPassword);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Middleware Express: exige um Bearer token válido. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!verifyToken(token)) {
    return res.status(401).json({ error: 'não autenticado' });
  }
  next();
}
