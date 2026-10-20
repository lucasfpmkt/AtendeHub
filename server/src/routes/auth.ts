import { Router } from 'express';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { checkPasswordHash, hashPassword, issueToken, requireAuth, requireAdmin, allowedWorkspaceIds, type Role } from '../auth.js';
import { createWorkspace } from '../services/tenancy.js';

export const authRouter = Router();

const today = () => new Date().toISOString().slice(0, 10);
const cleanEmail = (v: unknown) => String(v ?? '').trim().toLowerCase();

/* Proteção simples contra força bruta: 8 tentativas erradas por login a cada 15 min. */
const failures = new Map<string, { n: number; until: number }>();
function blocked(key: string) {
  const f = failures.get(key);
  return Boolean(f && f.n >= 8 && f.until > Date.now());
}
function fail(key: string) {
  const f = failures.get(key);
  const fresh = !f || f.until < Date.now();
  failures.set(key, { n: fresh ? 1 : f!.n + 1, until: Date.now() + 15 * 60 * 1000 });
}

type WsLite = { id: string; code: number; name: string; plan: string; expiresAt: string | null; active: boolean };
const publicWs = (w: WsLite) => ({ id: w.id, code: w.code, name: w.name, plan: w.plan, expiresAt: w.expiresAt, active: w.active });

/** Motivo para um cliente não poder entrar (inativo ou vencido), ou null. */
function wsBlockedReason(w: WsLite) {
  if (!w.active) return 'Esta conta está desativada. Fale com o administrador.';
  if (w.expiresAt && w.expiresAt < today()) return 'O plano desta conta venceu. Fale com o administrador.';
  return null;
}

authRouter.get('/options', (_req, res) => {
  res.json({ allowSignup: env.allowSignup });
});

authRouter.post('/login', async (req, res) => {
  const email = cleanEmail(req.body?.email);
  const password = String(req.body?.password ?? '');
  if (blocked(email)) return res.status(429).json({ error: 'Muitas tentativas. Tente de novo em alguns minutos.' });

  const user = await prisma.user.findUnique({ where: { email }, include: { workspace: true } });
  if (!user || !checkPasswordHash(password, user.passwordHash)) {
    fail(email);
    return res.status(401).json({ error: 'E-mail ou senha incorretos.' });
  }
  failures.delete(email);
  if (user.role !== 'admin') {
    const reason = wsBlockedReason(user.workspace);
    if (reason) return res.status(403).json({ error: reason });
  }
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  const role = user.role as Role;
  res.json({
    token: issueToken({ uid: user.id, role, ws: user.workspaceId }),
    user: { id: user.id, name: user.name, email: user.email, role, isMaster: role === 'admin' && user.isMaster },
    workspace: publicWs(user.workspace),
  });
});

/** Criar conta: cria o escritório (cliente) e o primeiro usuário dele. */
authRouter.post('/signup', async (req, res) => {
  if (!env.allowSignup) return res.status(403).json({ error: 'O cadastro está fechado. Fale com o administrador.' });
  const name = String(req.body?.name ?? '').trim();
  const company = String(req.body?.company ?? '').trim();
  const email = cleanEmail(req.body?.email);
  const password = String(req.body?.password ?? '');
  if (!name || !company || !email) return res.status(400).json({ error: 'Preencha nome, escritório e e-mail.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail inválido.' });
  if (password.length < 8) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
  if (await prisma.user.findUnique({ where: { email } })) {
    return res.status(409).json({ error: 'Já existe uma conta com este e-mail.' });
  }
  // Conta nova começa em teste de 7 dias; o admin ajusta plano e vencimento.
  const trial = new Date();
  trial.setDate(trial.getDate() + 7);
  const ws = await createWorkspace({ name: company, plan: 'TESTE', expiresAt: trial.toISOString().slice(0, 10) });
  const user = await prisma.user.create({
    data: { email, name, passwordHash: hashPassword(password), role: 'user', workspaceId: ws.id, lastLoginAt: new Date() },
  });
  res.json({
    token: issueToken({ uid: user.id, role: 'user', ws: ws.id }),
    user: { id: user.id, name: user.name, email: user.email, role: 'user' },
    workspace: publicWs(ws),
  });
});

/** Quem sou eu e qual cliente está aberto. */
authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.uid } });
  const ws = await prisma.workspace.findUnique({ where: { id: req.auth!.ws } });
  if (!user || !ws) return res.status(401).json({ error: 'não autenticado' });
  if (user.role !== 'admin') {
    const reason = wsBlockedReason(ws);
    if (reason) return res.status(403).json({ error: reason });
  }
  res.json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role, isMaster: user.role === 'admin' && user.isMaster },
    workspace: publicWs(ws),
  });
});

/** Trocar a própria senha. */
authRouter.post('/password', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.auth!.uid } });
  const current = String(req.body?.current ?? '');
  const next = String(req.body?.next ?? '');
  if (!user || !checkPasswordHash(current, user.passwordHash)) return res.status(400).json({ error: 'Senha atual incorreta.' });
  if (next.length < 8) return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 8 caracteres.' });
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: hashPassword(next) } });
  res.json({ ok: true });
});

/** Admin: abrir outro cliente (gera um token para aquele workspace). */
authRouter.post('/switch', requireAuth, requireAdmin, async (req, res) => {
  const ws = await prisma.workspace.findUnique({ where: { id: String(req.body?.workspaceId ?? '') } });
  if (!ws) return res.status(404).json({ error: 'cliente não encontrado' });
  const allowed = await allowedWorkspaceIds(req.auth!.uid);
  if (allowed !== 'all' && !allowed.includes(ws.id)) return res.status(403).json({ error: 'sem acesso a este cliente' });
  res.json({ token: issueToken({ uid: req.auth!.uid, role: 'admin', ws: ws.id }), workspace: publicWs(ws) });
});
