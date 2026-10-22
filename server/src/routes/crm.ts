import { unlink } from 'node:fs/promises';
import { Router, type Response } from 'express';
import { prisma } from '../db.js';
import { emit } from '../realtime.js';
import { wsOf } from '../auth.js';
import { sendFromConversation } from '../whatsapp/session.js';
import { mediaFilePath } from '../whatsapp/media.js';
import { createFunnelWithDefaults } from '../services/crmSeed.js';
import { cancelPendingReply, systemNote, syncStageTag } from '../services/inbound.js';

/**
 * CRM do cliente aberto. Toda consulta filtra por workspaceId; antes de
 * alterar um registro pelo id, conferimos que ele pertence ao cliente.
 */
export const crmRouter = Router();

const notFound = (res: Response) => res.status(404).json({ error: 'não encontrado' });

/* ----------------------------- Contatos ----------------------------- */

crmRouter.get('/contacts', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const contacts = await prisma.contact.findMany({
    where: { workspaceId: wsOf(req), ...(q ? { OR: [{ name: { contains: q } }, { phone: { contains: q } }] } : {}) },
    orderBy: { updatedAt: 'desc' },
    include: { stage: true },
  });
  res.json(contacts);
});

crmRouter.patch('/contacts/:id', async (req, res) => {
  const ws = wsOf(req);
  if (!(await prisma.contact.findFirst({ where: { id: req.params.id, workspaceId: ws } }))) return notFound(res);
  const { name, notes, tags, stageId } = req.body ?? {};
  if (stageId && !(await prisma.pipelineStage.findFirst({ where: { id: stageId, workspaceId: ws } }))) return notFound(res);
  const contact = await prisma.contact.update({ where: { id: req.params.id }, data: { name, notes, tags, stageId } });
  // Mudou de etapa manualmente: sincroniza a etiqueta de etapa (mantém as manuais).
  if (stageId !== undefined) await syncStageTag(ws, req.params.id, stageId).catch(() => {});
  res.json(await prisma.contact.findUnique({ where: { id: req.params.id } }) ?? contact);
});

// LGPD: exporta todos os dados de um contato (direito de acesso/portabilidade).
crmRouter.get('/contacts/:id/export', async (req, res) => {
  const ws = wsOf(req);
  const contact = await prisma.contact.findFirst({ where: { id: req.params.id, workspaceId: ws } });
  if (!contact) return notFound(res);
  const [conversations, deals] = await Promise.all([
    prisma.conversation.findMany({ where: { workspaceId: ws, contactId: contact.id }, include: { messages: { orderBy: { createdAt: 'asc' } } } }),
    prisma.deal.findMany({ where: { workspaceId: ws, contactId: contact.id } }),
  ]);
  res.setHeader('Content-Disposition', `attachment; filename="dados-${contact.phone || contact.id}.json"`);
  res.json({ exportedAt: new Date().toISOString(), contact, conversations, deals });
});

// LGPD: apaga todos os dados de um contato (direito ao esquecimento).
crmRouter.delete('/contacts/:id/erase', async (req, res) => {
  const ws = wsOf(req);
  const contact = await prisma.contact.findFirst({ where: { id: req.params.id, workspaceId: ws } });
  if (!contact) return notFound(res);

  const convs = await prisma.conversation.findMany({ where: { workspaceId: ws, contactId: contact.id }, select: { id: true } });
  const convIds = convs.map((c) => c.id);
  // Apaga os arquivos de mídia das conversas do contato.
  if (convIds.length) {
    const medias = await prisma.message.findMany({
      where: { conversationId: { in: convIds }, mediaId: { not: null } },
      select: { mediaId: true },
    });
    for (const m of medias) {
      if (m.mediaId) await unlink(mediaFilePath(ws, m.mediaId)).catch(() => {});
    }
    await prisma.scheduledMessage.deleteMany({ where: { conversationId: { in: convIds } } });
  }
  await prisma.deal.deleteMany({ where: { workspaceId: ws, contactId: contact.id } });
  await prisma.contact.delete({ where: { id: contact.id } }); // cascata: conversas + mensagens
  res.json({ ok: true });
});

/* --------------------------- Conversas ------------------------------ */

crmRouter.get('/conversations', async (req, res) => {
  const ws = wsOf(req);
  // Sem `include: { messages: { where: { author: { not: 'system' } } } }`: com muitas
  // conversas (>~1000) o SQLite estoura o limite de parâmetros e o filtro negativo
  // impede o Prisma de dividir a consulta (erro P2029 → lista vazia na tela).
  const conversations = await prisma.conversation.findMany({
    where: { workspaceId: ws },
    orderBy: { lastMessageAt: 'desc' },
    include: { contact: true },
  });

  // Última mensagem (não-sistema) de cada conversa numa única consulta (1 parâmetro).
  const lastIds = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM (
      SELECT m.id AS id,
             ROW_NUMBER() OVER (PARTITION BY m.conversationId ORDER BY m.createdAt DESC) AS rn
      FROM "Message" m
      JOIN "Conversation" c ON c.id = m.conversationId
      WHERE c.workspaceId = ${ws} AND m.author <> 'system'
    ) t
    WHERE rn = 1`;

  // Busca as mensagens em lotes (cada lote bem abaixo do limite do SQLite).
  const ids = lastIds.map((r) => r.id);
  const lastByConv = new Map<string, unknown>();
  for (let i = 0; i < ids.length; i += 500) {
    const batch = await prisma.message.findMany({ where: { id: { in: ids.slice(i, i + 500) } } });
    for (const m of batch) lastByConv.set(m.conversationId, m);
  }

  res.json(
    conversations.map((c) => {
      const last = lastByConv.get(c.id);
      return { ...c, messages: last ? [last] : [] };
    }),
  );
});

/* -------------------- Mensagens agendadas (lembretes) -------------------- */
crmRouter.get('/conversations/:id/schedules', async (req, res) => {
  const ws = wsOf(req);
  if (!(await prisma.conversation.findFirst({ where: { id: req.params.id, workspaceId: ws } }))) return notFound(res);
  res.json(
    await prisma.scheduledMessage.findMany({
      where: { conversationId: req.params.id, sent: false },
      orderBy: { sendAt: 'asc' },
    }),
  );
});

crmRouter.post('/conversations/:id/schedules', async (req, res) => {
  const ws = wsOf(req);
  if (!(await prisma.conversation.findFirst({ where: { id: req.params.id, workspaceId: ws } }))) return notFound(res);
  const body = String(req.body?.body ?? '').trim();
  const sendAt = new Date(req.body?.sendAt);
  if (!body) return res.status(400).json({ error: 'mensagem obrigatória' });
  if (isNaN(sendAt.getTime()) || sendAt.getTime() < Date.now() - 60_000) return res.status(400).json({ error: 'data/hora inválida' });
  res.json(await prisma.scheduledMessage.create({ data: { workspaceId: ws, conversationId: req.params.id, body, sendAt } }));
});

crmRouter.delete('/schedules/:id', async (req, res) => {
  const r = await prisma.scheduledMessage.deleteMany({ where: { id: req.params.id, workspaceId: wsOf(req) } });
  res.json({ ok: r.count > 0 });
});

crmRouter.get('/conversations/:id/messages', async (req, res) => {
  if (!(await prisma.conversation.findFirst({ where: { id: req.params.id, workspaceId: wsOf(req) } }))) return notFound(res);
  const messages = await prisma.message.findMany({
    where: { conversationId: req.params.id },
    orderBy: { createdAt: 'asc' },
  });
  res.json(messages);
});

crmRouter.post('/conversations/:id/messages', async (req, res) => {
  const ws = wsOf(req);
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'texto vazio' });
  try {
    const message = await sendFromConversation(ws, req.params.id, text);
    // Quando alguém da equipe responde, a IA para nesta conversa (evita os dois falando).
    const conv = await prisma.conversation.findFirst({ where: { id: req.params.id, workspaceId: ws } });
    if (conv?.aiEnabled) {
      cancelPendingReply(conv.id);
      const updated = await prisma.conversation.update({ where: { id: conv.id }, data: { aiEnabled: false } });
      emit(ws, { type: 'conversation:update', conversation: updated });
      await systemNote(ws, conv.id, 'A equipe assumiu a conversa. A IA foi pausada.');
    }
    res.json(message);
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

crmRouter.patch('/conversations/:id', async (req, res) => {
  const ws = wsOf(req);
  if (!(await prisma.conversation.findFirst({ where: { id: req.params.id, workspaceId: ws } }))) return notFound(res);
  const { aiEnabled, status, assignedAgentId } = req.body ?? {};
  if (assignedAgentId && !(await prisma.agent.findFirst({ where: { id: assignedAgentId, workspaceId: ws } }))) {
    return notFound(res);
  }
  const conversation = await prisma.conversation.update({
    where: { id: req.params.id },
    data: {
      aiEnabled,
      status,
      // Escolher um agente manualmente já devolve a conversa para a IA; null desvincula.
      ...(assignedAgentId !== undefined
        ? { assignedAgentId: assignedAgentId || null, aiEnabled: aiEnabled ?? Boolean(assignedAgentId) }
        : {}),
    },
  });
  if (conversation.aiEnabled === false) cancelPendingReply(conversation.id);
  emit(ws, { type: 'conversation:update', conversation });
  res.json(conversation);
});

// Zera o contador de não lidas ao abrir a conversa.
crmRouter.post('/conversations/:id/read', async (req, res) => {
  const r = await prisma.conversation.updateMany({
    where: { id: req.params.id, workspaceId: wsOf(req) },
    data: { unread: 0 },
  });
  res.json({ ok: r.count > 0 });
});

/* ----------------------------- Funis -------------------------------- */

crmRouter.get('/funnels', async (req, res) => {
  res.json(await prisma.funnel.findMany({ where: { workspaceId: wsOf(req) }, orderBy: { order: 'asc' } }));
});

// Todas as etapas do cliente (com o nome do funil) — usado no editor do roteiro.
crmRouter.get('/stages', async (req, res) => {
  const ws = wsOf(req);
  const funnels = await prisma.funnel.findMany({
    where: { workspaceId: ws },
    orderBy: { order: 'asc' },
    include: { stages: { orderBy: { order: 'asc' } } },
  });
  const out: { id: string; name: string; color: string; funnelId: string; funnelName: string }[] = [];
  for (const f of funnels) for (const s of f.stages) out.push({ id: s.id, name: s.name, color: s.color, funnelId: f.id, funnelName: f.name });
  res.json(out);
});

crmRouter.post('/funnels', async (req, res) => {
  const name = String(req.body?.name ?? 'Novo funil').trim();
  res.json(await createFunnelWithDefaults(wsOf(req), name));
});

crmRouter.patch('/funnels/:id', async (req, res) => {
  if (!(await prisma.funnel.findFirst({ where: { id: req.params.id, workspaceId: wsOf(req) } }))) return notFound(res);
  res.json(await prisma.funnel.update({ where: { id: req.params.id }, data: { name: req.body?.name } }));
});

crmRouter.delete('/funnels/:id', async (req, res) => {
  const r = await prisma.funnel.deleteMany({ where: { id: req.params.id, workspaceId: wsOf(req) } });
  res.json({ ok: r.count > 0 });
});

// Quadro completo de um funil: etapas ordenadas, cada uma com seus negócios.
crmRouter.get('/funnels/:id/board', async (req, res) => {
  const ws = wsOf(req);
  const funnel = await prisma.funnel.findFirst({ where: { id: req.params.id, workspaceId: ws } });
  if (!funnel) return res.status(404).json({ error: 'funil não encontrado' });
  // No funil padrão (primeiro do cliente), puxa para o CRM os leads antigos que
  // ainda não têm negócio — assim conversas anteriores à feature aparecem aqui.
  const first = await prisma.funnel.findFirst({ where: { workspaceId: ws }, orderBy: { order: 'asc' } });
  if (first?.id === funnel.id) await backfillLeads(ws, funnel.id);
  const stages = await prisma.pipelineStage.findMany({
    where: { funnelId: funnel.id },
    orderBy: { order: 'asc' },
    include: { deals: { orderBy: { createdAt: 'desc' }, include: { contact: true } } },
  });

  // Agente de IA atribuído à conversa de cada contato (para exibir no card).
  const contactIds = stages.flatMap((s) => s.deals.map((d) => d.contactId).filter(Boolean) as string[]);
  const agentByContact = new Map<string, string>();
  if (contactIds.length) {
    const [convs, agents] = await Promise.all([
      prisma.conversation.findMany({
        where: { workspaceId: ws, contactId: { in: contactIds }, assignedAgentId: { not: null } },
        orderBy: { lastMessageAt: 'desc' },
        select: { contactId: true, assignedAgentId: true },
      }),
      prisma.agent.findMany({ where: { workspaceId: ws }, select: { id: true, name: true } }),
    ]);
    const agentName = new Map(agents.map((a) => [a.id, a.name]));
    for (const c of convs) {
      if (c.contactId && c.assignedAgentId && !agentByContact.has(c.contactId)) {
        agentByContact.set(c.contactId, agentName.get(c.assignedAgentId) ?? '');
      }
    }
  }
  const withAgent = stages.map((s) => ({
    ...s,
    deals: s.deals.map((d) => ({ ...d, agentName: (d.contactId && agentByContact.get(d.contactId)) || null })),
  }));
  res.json({ funnel, stages: withAgent });
});

/** Cria negócios na 1ª etapa para contatos com conversa aberta e sem nenhum negócio. */
async function backfillLeads(ws: string, funnelId: string) {
  const stage = await prisma.pipelineStage.findFirst({ where: { funnelId }, orderBy: { order: 'asc' } });
  if (!stage) return;
  const convos = await prisma.conversation.findMany({
    where: { workspaceId: ws, status: { not: 'closed' } },
    select: { contactId: true },
    distinct: ['contactId'],
    take: 500,
  });
  for (const { contactId } of convos) {
    const has = await prisma.deal.findFirst({ where: { workspaceId: ws, contactId } });
    if (has) continue;
    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    await prisma.deal
      .create({
        data: {
          workspaceId: ws,
          title: contact?.name || contact?.phone || 'Lead',
          contactId,
          funnelId,
          stageId: stage.id,
          source: 'WhatsApp',
          stageSince: new Date(),
        },
      })
      .catch(() => {});
    if (contact) await prisma.contact.update({ where: { id: contactId }, data: { stageId: stage.id } }).catch(() => {});
  }
}

/* ----------------------------- Etapas ------------------------------- */

crmRouter.post('/funnels/:id/stages', async (req, res) => {
  const ws = wsOf(req);
  if (!(await prisma.funnel.findFirst({ where: { id: req.params.id, workspaceId: ws } }))) return notFound(res);
  const count = await prisma.pipelineStage.count({ where: { funnelId: req.params.id } });
  const name = String(req.body?.name ?? 'Nova etapa');
  const color = String(req.body?.color ?? '#64748b');
  // Por padrão, a etiqueta automática da etapa = nome da etapa (cor da etapa).
  const autoTag = typeof req.body?.autoTag === 'string' ? req.body.autoTag.trim() : name;
  const stage = await prisma.pipelineStage.create({
    data: { name, color, order: count, funnelId: req.params.id, workspaceId: ws, autoTag },
  });
  if (autoTag) await prisma.tag.create({ data: { workspaceId: ws, name: autoTag, color } }).catch(() => {});
  res.json(stage);
});

crmRouter.patch('/stages/:id', async (req, res) => {
  if (!(await prisma.pipelineStage.findFirst({ where: { id: req.params.id, workspaceId: wsOf(req) } }))) return notFound(res);
  const { name, color, order, followupMinutes, followupMessage, autoTag } = req.body ?? {};
  res.json(
    await prisma.pipelineStage.update({
      where: { id: req.params.id },
      data: {
        name,
        color,
        order,
        followupMinutes: followupMinutes === undefined ? undefined : Math.max(0, Number(followupMinutes) || 0),
        followupMessage: followupMessage === undefined ? undefined : String(followupMessage),
        autoTag: autoTag === undefined ? undefined : String(autoTag),
      },
    }),
  );
});

crmRouter.delete('/stages/:id', async (req, res) => {
  const ws = wsOf(req);
  if (!(await prisma.pipelineStage.findFirst({ where: { id: req.params.id, workspaceId: ws } }))) return notFound(res);
  await prisma.deal.updateMany({ where: { stageId: req.params.id }, data: { stageId: null } });
  await prisma.contact.updateMany({ where: { stageId: req.params.id }, data: { stageId: null } });
  await prisma.pipelineStage.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

/* ----------------------------- Negócios ----------------------------- */

/** Confere que funil, etapa e contato informados são do mesmo cliente. */
async function refsOk(ws: string, d: { funnelId?: string; stageId?: string; contactId?: string }) {
  if (d.funnelId && !(await prisma.funnel.findFirst({ where: { id: d.funnelId, workspaceId: ws } }))) return false;
  if (d.stageId && !(await prisma.pipelineStage.findFirst({ where: { id: d.stageId, workspaceId: ws } }))) return false;
  if (d.contactId && !(await prisma.contact.findFirst({ where: { id: d.contactId, workspaceId: ws } }))) return false;
  return true;
}

crmRouter.post('/deals', async (req, res) => {
  const ws = wsOf(req);
  const { title, contactId, funnelId, stageId, valueCents, source, responsavel, tags } = req.body ?? {};
  if (!funnelId) return res.status(400).json({ error: 'funnelId obrigatório' });
  if (!(await refsOk(ws, { funnelId, stageId, contactId }))) return notFound(res);
  const deal = await prisma.deal.create({
    data: {
      workspaceId: ws,
      title: String(title ?? 'Nova negociação'),
      contactId: contactId || null,
      funnelId,
      stageId: stageId || null,
      valueCents: Number(valueCents ?? 0),
      source: source || null,
      responsavel: responsavel || null,
      tags: tags ?? '',
    },
    include: { contact: true },
  });
  if (stageId && deal.contactId) {
    await prisma.contact.update({ where: { id: deal.contactId }, data: { stageId } }).catch(() => {});
    await syncStageTag(ws, deal.contactId, stageId).catch(() => {});
  }
  res.json(deal);
});

crmRouter.patch('/deals/:id', async (req, res) => {
  const ws = wsOf(req);
  if (!(await prisma.deal.findFirst({ where: { id: req.params.id, workspaceId: ws } }))) return notFound(res);
  const { title, stageId, funnelId, valueCents, source, responsavel, tags } = req.body ?? {};
  if (!(await refsOk(ws, { funnelId, stageId }))) return notFound(res);
  const deal = await prisma.deal.update({
    where: { id: req.params.id },
    data: {
      title,
      stageId,
      funnelId,
      valueCents: valueCents === undefined ? undefined : Number(valueCents),
      source,
      responsavel,
      tags,
      // Mudou de etapa: reinicia o relógio do follow-up e permite notificar de novo.
      ...(stageId === undefined ? {} : { stageSince: new Date(), followupStageId: null }),
    },
    include: { contact: true },
  });
  // Arrastou/moveu o negócio de etapa: espelha no contato e sincroniza a etiqueta.
  if (stageId !== undefined && deal.contactId) {
    await prisma.contact.update({ where: { id: deal.contactId }, data: { stageId: stageId || null } }).catch(() => {});
    await syncStageTag(ws, deal.contactId, stageId || null).catch(() => {});
  }
  res.json(deal);
});

crmRouter.delete('/deals/:id', async (req, res) => {
  const r = await prisma.deal.deleteMany({ where: { id: req.params.id, workspaceId: wsOf(req) } });
  res.json({ ok: r.count > 0 });
});

// Exporta os negócios de um funil em CSV.
crmRouter.get('/funnels/:id/export', async (req, res) => {
  if (!(await prisma.funnel.findFirst({ where: { id: req.params.id, workspaceId: wsOf(req) } }))) return notFound(res);
  const stages = await prisma.pipelineStage.findMany({
    where: { funnelId: req.params.id },
    orderBy: { order: 'asc' },
    include: { deals: { include: { contact: true } } },
  });
  const rows = [['Negócio', 'Etapa', 'Contato', 'Telefone', 'Valor', 'Origem', 'Responsável', 'Etiquetas']];
  for (const stage of stages) {
    for (const d of stage.deals) {
      rows.push([
        d.title,
        stage.name,
        d.contact?.name ?? '',
        d.contact?.phone ?? '',
        (d.valueCents / 100).toFixed(2),
        d.source ?? '',
        d.responsavel ?? '',
        d.tags ?? '',
      ]);
    }
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="funil.csv"');
  res.send('﻿' + csv);
});

/* ----------------------------- Etiquetas ---------------------------- */

crmRouter.get('/tags', async (req, res) => {
  res.json(await prisma.tag.findMany({ where: { workspaceId: wsOf(req) }, orderBy: { name: 'asc' } }));
});

crmRouter.post('/tags', async (req, res) => {
  const ws = wsOf(req);
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'nome obrigatório' });
  const color = String(req.body?.color ?? '#b71312');
  const tag = await prisma.tag.upsert({
    where: { workspaceId_name: { workspaceId: ws, name } },
    update: { color },
    create: { workspaceId: ws, name, color },
  });
  res.json(tag);
});

crmRouter.patch('/tags/:id', async (req, res) => {
  if (!(await prisma.tag.findFirst({ where: { id: req.params.id, workspaceId: wsOf(req) } }))) return notFound(res);
  const { name, color } = req.body ?? {};
  res.json(await prisma.tag.update({ where: { id: req.params.id }, data: { name, color } }));
});

crmRouter.delete('/tags/:id', async (req, res) => {
  const r = await prisma.tag.deleteMany({ where: { id: req.params.id, workspaceId: wsOf(req) } });
  res.json({ ok: r.count > 0 });
});
