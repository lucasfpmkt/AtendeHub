import type { Request, Response, NextFunction, RequestHandler } from 'express';

/* --------------------------- Cabeçalhos de segurança --------------------------- */

// Única origem externa usada pelo front: Google Fonts. Sem scripts embutidos.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", // React usa style="" em vários pontos
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:", // fotos de perfil do WhatsApp vêm de https externo
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:", // API + socket.io no mesmo domínio
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'", // ninguém embute o LawHub em iframe (clickjacking)
].join('; ');

/** Cabeçalhos de segurança em todas as respostas. */
export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Microfone liberado só para o próprio LawHub (gravar áudio nas conversas).
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.removeHeader('X-Powered-By');
  // HSTS só quando a requisição chegou por HTTPS (atrás do proxy do Easypanel).
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

/**
 * Força HTTPS: se o proxy avisa que a requisição veio por HTTP, redireciona.
 * Requisições diretas ao container (healthcheck do Easypanel) não têm o
 * cabeçalho do proxy e passam normalmente. Só GET/HEAD são redirecionados.
 */
export function forceHttps(req: Request, res: Response, next: NextFunction) {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const host = req.headers.host ?? '';
  const local = /^(localhost|127\.|10\.|192\.168\.|\[?::1)/.test(host);
  if (proto === 'http' && !local && (req.method === 'GET' || req.method === 'HEAD')) {
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  }
  next();
}

/* --------------------------------- Rate limit --------------------------------- */

type Bucket = { count: number; resetAt: number };

/**
 * IP do visitante. Atrás do Cloudflare todos chegariam com o IP do Cloudflare; o
 * cabeçalho CF-Connecting-IP (sobrescrito pelo próprio Cloudflare) traz o real.
 * Sem Cloudflare, usa o IP que o proxy do Easypanel entregou (trust proxy = 1).
 */
export function clientIp(req: Request): string {
  const cf = String(req.headers['cf-connecting-ip'] ?? '').trim();
  if (cf && /^[0-9a-f:.]{3,45}$/i.test(cf)) return cf;
  return req.ip || req.socket.remoteAddress || 'desconhecido';
}

/**
 * Limite simples por IP em memória (janela fixa). Suficiente para uma instância;
 * se um dia rodar mais de uma réplica, trocar por um armazenamento compartilhado.
 */
export function rateLimit(opts: { name: string; windowMs: number; max: number; message?: string }): RequestHandler {
  const buckets = new Map<string, Bucket>();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, Math.min(opts.windowMs, 60_000));
  timer.unref();

  return (req, res, next) => {
    const key = clientIp(req);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    res.setHeader('RateLimit-Limit', String(opts.max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, opts.max - b.count)));
    if (b.count > opts.max) {
      const retry = Math.ceil((b.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retry));
      if (b.count === opts.max + 1) console.warn(`[rate-limit:${opts.name}] ${key} passou do limite (${opts.max}/${opts.windowMs / 1000}s)`);
      return res.status(429).json({ error: opts.message ?? 'Muitas requisições. Aguarde um pouco e tente de novo.' });
    }
    next();
  };
}
