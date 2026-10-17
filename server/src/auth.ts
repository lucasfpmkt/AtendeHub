import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env } from './env.js';

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 dias

export type Role = 'admin' | 'user';
/** Quem está logado e qual cliente (workspace) está aberto. */
export type AuthInfo = { uid: string; role: Role; ws: string };

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthInfo;
  }
}

function b64url(buf: Buffer | string) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sign(payload: string) {
  return b64url(crypto.createHmac('sha256', env.appSecret).update(payload).digest());
}

/** Gera um token assinado (payload.assinatura). */
export function issueToken(info: AuthInfo): string {
  const payload = b64url(JSON.stringify({ ...info, exp: Date.now() + TOKEN_TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

/** Valida o token e devolve quem é; null se inválido ou expirado. */
export function verifyToken(token?: string | null): AuthInfo | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (typeof data.exp !== 'number' || data.exp <= Date.now()) return null;
    if (!data.uid || !data.ws || (data.role !== 'admin' && data.role !== 'user')) return null;
    return { uid: data.uid, role: data.role, ws: data.ws };
  } catch {
    return null;
  }
}

/* ------------------------------- senhas ------------------------------- */

/** scrypt com sal aleatório: "scrypt$<sal>$<hash>". */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function checkPasswordHash(password: string, stored: string): boolean {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const got = crypto.scryptSync(password, salt, 64);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/* ----------------------------- middlewares ---------------------------- */

/** Exige um Bearer token válido e preenche req.auth. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const info = verifyToken(header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!info) return res.status(401).json({ error: 'não autenticado' });
  req.auth = info;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.auth?.role !== 'admin') return res.status(403).json({ error: 'apenas administradores' });
  next();
}

/** Workspace do pedido (sempre definido depois de requireAuth). */
export const wsOf = (req: Request) => req.auth!.ws;
