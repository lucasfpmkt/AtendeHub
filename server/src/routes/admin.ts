import { Router } from 'express';
import { prisma } from '../db.js';
import { clearAccessCache, hashPassword } from '../auth.js';
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

// Reavalia as conversas de TODOS os clientes e ajusta as etapas.
adminRouter.post('/ai/reclassify-all', async (_req, res) => {
  const crmLlm = await resolveCrmLlm();
  if (!crmLlm.ready) return res.status(400).json({ error: 'Conecte a IA da plataforma antes de reavaliar.' });
  const workspaces = await prisma.workspace.findMany({ where: { active: true }, select: { id: true } });
  let total = 0;
  for (const w of workspaces) total += await reclassifyAllStages(w.id);
  res.json({ total, workspaces: workspaces.length });
});

const PLANS = ['MENSAL', 'CLIENTE', 'TESTE'];
const cleanEmail = (v: unknown) => String(v ?? '').trim().toLowerCase();

adminRouter.get('/workspaces', async (_req, res) => {
  const list = await prisma.workspace.findMany({
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
