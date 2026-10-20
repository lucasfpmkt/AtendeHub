import { Router } from 'express';
import { prisma } from '../db.js';
import { clearAccessCache, hashPassword, allowedWorkspaceIds, requireMaster } from '../auth.js';
import { createWorkspace } from '../services/tenancy.js';
import { dropSession, getStatus } from '../whatsapp/session.js';
import { getPlatformConfig, updatePlatformConfig } from '../services/platform.js';
import { providersPublic, resolveLlm, resolveCrmLlm } from '../services/llm.js';
import { reclassifyAllStages } from '../services/inbound.js';

/** Painel do administrador: todos os clientes (workspaces) e seus acessos. */
export const adminRouter = Router();

/* ------------------------ IA global da plataforma ------------------------ */
adminRouter.get('/ai', async (_req, res) => {
  const cfg = await getPlatformConfig();
  const [llm, crmLlm] = await Promise.all([resolveLlm(), resolveCrmLlm()]);
  const { apiKey, crmApiKey, ...safe } = cfg;
  res.json({
    ...safe,
    hasKey: Boolean(apiKey && apiKey.trim()),
    crmHasKey: Boolean(crmApiKey && crmApiKey.trim()),
    providerConnected: llm.ready,
    crmConnected: crmLlm.ready,
    providers: providersPublic(),
  });
});

adminRouter.patch('/ai', async (req, res) => {
  const cfg = await updatePlatformConfig(req.body ?? {});
  const [llm, crmLlm] = await Promise.all([resolveLlm(), resolveCrmLlm()]);
  const { apiKey, crmApiKey, ...safe } = cfg;
  res.json({
    ...safe,
    hasKey: Boolean(apiKey && apiKey.trim()),
    crmHasKey: Boolean(crmApiKey && crmApiKey.trim()),
    providerConnected: llm.ready,
    crmConnected: crmLlm.ready,
  });
});

adminRouter.post('/ai/test', async (req, res) => {
  try {
    const llm = req.query.which === 'crm' ? await resolveCrmLlm() : await resolveLlm();
    if (!llm.ready) return res.status(400).json({ ok: false, error: 'Nenhum provedor conectado. Salve a chave primeiro.' });
    const out = await llm.complete({ system: 'Responda apenas com a palavra OK.', messages: [{ role: 'user', content: 'teste' }], maxTokens: 5 });
    res.json({ ok: true, provider: llm.provider, model: llm.model, sample: out.slice(0, 40) });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

/* --------------------- Administradores (só master) ---------------------- */
adminRouter.get('/admins', requireMaster, async (_req, res) => {
  const admins = await prisma.user.findMany({
    where: { role: 'admin' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, email: true, isMaster: true, lastLoginAt: true, adminAccess: { select: { workspaceId: true } } },
  });
  res.json(admins.map((a) => ({ ...a, workspaceIds: a.adminAccess.map((x) => x.workspaceId), adminAccess: undefined })));
});

adminRouter.post('/admins', requireMaster, async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const email = cleanEmail(req.body?.email);
  const password = String(req.body?.password ?? '');
  const isMaster = Boolean(req.body?.isMaster);
  const workspaceIds: string[] = Array.isArray(req.body?.workspaceIds) ? req.body.workspaceIds.map(String) : [];
  if (!name || !email) return res.status(400).json({ error: 'nome e e-mail são obrigatórios' });
  if (password.length < 8) return res.status(400).json({ error: 'a senha precisa ter ao menos 8 caracteres' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'e-mail inválido' });
  if (await prisma.user.findUnique({ where: { email } })) return res.status(409).json({ error: 'já existe uma conta com este e-mail' });
  if (!isMaster && workspaceIds.length === 0) return res.status(400).json({ error: 'selecione ao menos um cliente para o admin' });

  // Admin precisa de um workspace "casa"; usa o 1º selecionado (ou o do criador, se master).
  const home = isMaster ? req.auth!.ws : workspaceIds[0];
  const user = await prisma.user.create({
    data: { name, email, passwordHash: hashPassword(password), role: 'admin', isMaster, workspaceId: home },
  });
  if (!isMaster) {
    await prisma.adminAccess.createMany({ data: workspaceIds.map((wid) => ({ userId: user.id, workspaceId: wid })) });
  }
  res.json({ id: user.id });
});

adminRouter.patch('/admins/:id', requireMaster, async (req, res) => {
  const user = await prisma.user.findFirst({ where: { id: req.params.id, role: 'admin' } });
  if (!user) return res.status(404).json({ error: 'admin não encontrado' });
  const data: Record<string, unknown> = {};
  if (typeof req.body?.isMaster === 'boolean') data.isMaster = req.body.isMaster;
  if (typeof req.body?.name === 'string') data.name = req.body.name.trim();
  await prisma.user.update({ where: { id: user.id }, data });
  // Atualiza a lista de clientes permitidos (quando enviada e não for master).
  if (Array.isArray(req.body?.workspaceIds)) {
    await prisma.adminAccess.deleteMany({ where: { userId: user.id } });
    const makeMaster = req.body?.isMaster === true;
    if (!makeMaster) {
      const ids: string[] = req.body.workspaceIds.map(String);
      await prisma.adminAccess.createMany({ data: ids.map((wid) => ({ userId: user.id, workspaceId: wid })) });
    }
  }
  clearAccessCache();
  res.json({ ok: true });
});

adminRouter.delete('/admins/:id', requireMaster, async (req, res) => {
  if (req.params.id === req.auth!.uid) return res.status(400).json({ error: 'você não pode excluir a si mesmo' });
  const masters = await prisma.user.count({ where: { role: 'admin', isMaster: true } });
  const target = await prisma.user.findFirst({ where: { id: req.params.id, role: 'admin' } });
  if (!target) return res.status(404).json({ error: 'admin não encontrado' });
  if (target.isMaster && masters <= 1) return res.status(400).json({ error: 'não dá para excluir o último admin master' });
  await prisma.user.delete({ where: { id: target.id } });
  res.json({ ok: true });
});

// Reavalia manualmente as conversas de UM cliente e ajusta as etapas.
adminRouter.post('/ai/reclassify/:workspaceId', async (req, res) => {
  const crmLlm = await resolveCrmLlm();
  if (!crmLlm.ready) return res.status(400).json({ error: 'Conecte a IA da plataforma antes de reavaliar.' });
  const wid = req.params.workspaceId;
  const allowed = await allowedWorkspaceIds(req.auth!.uid);
  if (allowed !== 'all' && !allowed.includes(wid)) return res.status(403).json({ error: 'sem acesso a este cliente' });
  const total = await reclassifyAllStages(wid);
  res.json({ total });
});

const PLANS = ['MENSAL', 'CLIENTE', 'TESTE'];
const cleanEmail = (v: unknown) => String(v ?? '').trim().toLowerCase();

adminRouter.get('/workspaces', async (req, res) => {
  const allowed = await allowedWorkspaceIds(req.auth!.uid);
  const list = await prisma.workspace.findMany({
    where: allowed === 'all' ? {} : { id: { in: allowed } },
    orderBy: { createdAt: 'asc' },
    include: { users: { select: { id: true, name: true, email: true, role: true, lastLoginAt: true } } },
  });
  const counts = await Promise.all(
    list.map(async (w) => ({
      contacts: await prisma.contact.count({ where: { workspaceId: w.id } }),
      openConversations: await prisma.conversation.count({ where: { workspaceId: w.id, status: { not: 'closed' } } }),
      agents: await prisma.agent.count({ where: { workspaceId: w.id, active: true } }),
    })),
  );
  res.json(
    list.map((w, i) => ({
      id: w.id,
      code: w.code,
      name: w.name,
      plan: w.plan,
      expiresAt: w.expiresAt,
      active: w.active,
      createdAt: w.createdAt,
      users: w.users,
      whatsapp: getStatus(w.id).status,
      ...counts[i],
    })),
  );
});

/** Cria um cliente já com o login dele. */
adminRouter.post('/workspaces', async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  const userName = String(req.body?.userName ?? '').trim() || name;
  const email = cleanEmail(req.body?.email);
  const password = String(req.body?.password ?? '');
  const plan = PLANS.includes(req.body?.plan) ? req.body.plan : 'MENSAL';
  const expiresAt = req.body?.expiresAt ? String(req.body.expiresAt) : null;
  if (!name || !email) return res.status(400).json({ error: 'Informe o nome do cliente e o e-mail de acesso.' });
  if (password.length < 8) return res.status(400).json({ error: 'A senha inicial precisa ter pelo menos 8 caracteres.' });
  if (await prisma.user.findUnique({ where: { email } })) {
    return res.status(409).json({ error: 'Já existe uma conta com este e-mail.' });
  }
  const ws = await createWorkspace({ name, plan, expiresAt });
  await prisma.user.create({
    data: { email, name: userName, passwordHash: hashPassword(password), role: 'user', workspaceId: ws.id },
  });
  res.json(ws);
});

adminRouter.patch('/workspaces/:id', async (req, res) => {
  const { name, plan, expiresAt, active } = req.body ?? {};
  const ws = await prisma.workspace.update({
    where: { id: req.params.id },
    data: {
      name: typeof name === 'string' && name.trim() ? name.trim() : undefined,
      plan: PLANS.includes(plan) ? plan : undefined,
      expiresAt: expiresAt === undefined ? undefined : expiresAt || null,
      active: typeof active === 'boolean' ? active : undefined,
    },
  });
  clearAccessCache();
  res.json(ws);
});

/** Define uma nova senha para um usuário (ex.: cliente esqueceu). */
adminRouter.post('/users/:id/password', async (req, res) => {
  const password = String(req.body?.password ?? '');
  if (password.length < 8) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
  await prisma.user.update({ where: { id: req.params.id }, data: { passwordHash: hashPassword(password) } });
  res.json({ ok: true });
});

/**
 * Exclui um cliente de vez: WhatsApp, logins e todos os dados dele.
 * Exige o nome digitado; não deixa apagar o cliente aberto nem o que
 * contém uma conta de administrador.
 */
adminRouter.delete('/workspaces/:id', async (req, res) => {
  const ws = await prisma.workspace.findUnique({ where: { id: req.params.id }, include: { users: true } });
  if (!ws) return res.status(404).json({ error: 'cliente não encontrado' });
  if (String(req.body?.confirmName ?? '').trim() !== ws.name) {
    return res.status(400).json({ error: 'Digite o nome do cliente exatamente como aparece para confirmar.' });
  }
  if (ws.id === req.auth!.ws) {
    return res.status(400).json({ error: 'Você está dentro deste cliente. Abra outro cliente antes de excluí-lo.' });
  }
  if (ws.users.some((u) => u.role === 'admin')) {
    return res.status(400).json({ error: 'Este cliente tem uma conta de administrador e não pode ser excluído.' });
  }

  await dropSession(ws.id);
  const where = { workspaceId: ws.id };
  await prisma.$transaction([
    prisma.deal.deleteMany({ where }),
    prisma.conversation.deleteMany({ where }), // mensagens vão junto (cascade)
    prisma.contact.deleteMany({ where }),
    prisma.pipelineStage.deleteMany({ where }),
    prisma.funnel.deleteMany({ where }),
    prisma.agent.deleteMany({ where }), // histórico vai junto (cascade)
    prisma.task.deleteMany({ where }),
    prisma.event.deleteMany({ where }),
    prisma.quickReply.deleteMany({ where }),
    prisma.keywordRule.deleteMany({ where }),
    prisma.tag.deleteMany({ where }),
    prisma.aiConfig.deleteMany({ where: { id: ws.id } }),
    prisma.workspace.delete({ where: { id: ws.id } }), // logins vão junto (cascade)
  ]);
  clearAccessCache();
  res.json({ ok: true });
});
