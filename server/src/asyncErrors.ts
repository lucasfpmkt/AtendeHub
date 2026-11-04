// Express 4 não captura erros de rotas `async`: uma promise rejeitada virava
// "unhandledRejection" e o Node encerrava o processo — derrubando o WhatsApp e a
// IA de TODOS os clientes. Aqui a rejeição vai para o `next(err)` (como faz o
// pacote express-async-errors), e o middleware de erro responde 4xx/5xx.
import { createRequire } from 'node:module';
import type { NextFunction, Request, Response } from 'express';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Layer: any = require('express/lib/router/layer');

if (!Layer.prototype.__lawhubAsync) {
  Layer.prototype.__lawhubAsync = true;
  const original = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function handle_request(req: Request, res: Response, next: NextFunction) {
    const fn = this.handle;
    if (typeof fn !== 'function' || fn.length > 3) return original.call(this, req, res, next);
    try {
      const out = fn(req, res, next);
      if (out && typeof out.then === 'function') out.then(undefined, next);
    } catch (err) {
      next(err);
    }
  };
}

/** Middleware final: transforma qualquer erro em resposta, sem derrubar o servidor. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const e = err as { name?: string; message?: string; code?: string; status?: number; statusCode?: number; type?: string };
  // Corpo JSON inválido / grande demais (body-parser).
  const http = e.status ?? e.statusCode;
  const isValidation = e.name === 'PrismaClientValidationError' || e.type === 'entity.parse.failed';
  const status = http && http >= 400 && http < 600 ? http : isValidation ? 400 : e.code === 'P2025' ? 404 : 500;
  if (status >= 500) console.error(`[api] ${req.method} ${req.originalUrl} falhou:`, e.message ?? err);
  if (res.headersSent) return;
  res.status(status).json({ error: status === 400 ? 'Dados inválidos.' : status === 404 ? 'Não encontrado.' : 'Erro interno. Tente de novo.' });
}
