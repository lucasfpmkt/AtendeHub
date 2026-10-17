import { prisma } from '../db.js';
import { env } from '../env.js';
import { hashPassword } from '../auth.js';
import { createFunnelWithDefaults } from './crmSeed.js';

/** Cria um cliente novo, já com um funil padrão e a configuração de IA. */
export async function createWorkspace(data: { name: string; plan?: string; expiresAt?: string | null }) {
  const count = await prisma.workspace.count();
  const ws = await prisma.workspace.create({
    data: {
      name: data.name.trim(),
      plan: data.plan || 'MENSAL',
      expiresAt: data.expiresAt || null,
      code: 1000 + count + 1,
    },
  });
  await createFunnelWithDefaults(ws.id, 'Funil Padrão');
  return ws;
}

/**
 * Roda a cada subida do servidor (idempotente):
 *  1. Instalação antiga (um cliente só): cria o primeiro workspace e move para
 *     ele todos os dados sem dono — contatos, conversas, agentes, funis…
 *     Ele continua usando a mesma sessão do WhatsApp (sem novo QR code).
 *  2. Garante que exista uma conta de administrador.
 */
export async function ensureTenancy() {
  let first = await prisma.workspace.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!first) {
    first = await prisma.workspace.create({
      data: { name: env.defaultWorkspaceName, plan: 'CLIENTE', code: 1001, legacyAuth: true },
    });
    console.log(`  Cliente inicial criado: ${first.name}`);
  }
  const ws = first.id;
  const orphan = { where: { workspaceId: null }, data: { workspaceId: ws } };
  const moved = await Promise.all([
    prisma.contact.updateMany(orphan),
    prisma.conversation.updateMany(orphan),
    prisma.agent.updateMany(orphan),
    prisma.task.updateMany(orphan),
    prisma.event.updateMany(orphan),
    prisma.quickReply.updateMany(orphan),
    prisma.keywordRule.updateMany(orphan),
    prisma.funnel.updateMany(orphan),
    prisma.pipelineStage.updateMany(orphan),
    prisma.deal.updateMany(orphan),
    prisma.tag.updateMany(orphan),
  ]);
  const total = moved.reduce((s, r) => s + r.count, 0);
  if (total > 0) console.log(`  ${total} registros antigos vinculados a "${first.name}".`);

  // Configuração de IA antiga (id "default") passa a ser a do primeiro cliente.
  const legacyCfg = await prisma.aiConfig.findUnique({ where: { id: 'default' } });
  if (legacyCfg && !(await prisma.aiConfig.findUnique({ where: { id: ws } }))) {
    await prisma.aiConfig.create({
      data: { id: ws, systemPrompt: legacyCfg.systemPrompt, autoReply: legacyCfg.autoReply, model: legacyCfg.model },
    });
  }

  if ((await prisma.user.count({ where: { role: 'admin' } })) === 0) {
    await prisma.user.create({
      data: {
        email: env.adminEmail,
        name: 'Administrador',
        role: 'admin',
        passwordHash: hashPassword(env.adminPassword),
        workspaceId: ws,
      },
    });
    console.log(`  Administrador criado: login "${env.adminEmail}" (senha = ADMIN_PASSWORD ou APP_PASSWORD).`);
  }

  // Todo cliente precisa de ao menos um funil.
  const all = await prisma.workspace.findMany({ select: { id: true } });
  for (const w of all) {
    if ((await prisma.funnel.count({ where: { workspaceId: w.id } })) === 0) {
      await createFunnelWithDefaults(w.id, 'Funil Padrão');
    }
  }
}
