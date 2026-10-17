import { Router, type Response } from 'express';
import { prisma } from '../db.js';
import { emit } from '../realtime.js';
import { wsOf } from '../auth.js';
import { sendFromConversation } from '../whatsapp/session.js';
import { createFunnelWithDefaults } from '../services/crmSeed.js';
import { cancelPendingReply, systemNote } from '../services/inbound.js';

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
  res.json(await prisma.contact.update({ where: { id: req.params.id }, data: { name, notes, tags, stageId } }));
});

/* --------------------------- Conversas ------------------------------ */

crmRouter.get('/conversations', async (req, res) => {
  const conversations = await prisma.conversation.findMany({
    where: { workspaceId: wsOf(req) },
    orderBy: { lastMessageAt: 'desc' },
    include: {
      contact: true,
      messages: { where: { author: { not: 'system' } }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  res.json(conversations);
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
  const funnel = await prisma.funnel.findFirst({ where: { id: req.params.id, workspaceId: wsOf(req) } });
  if (!funnel) return res.status(404).json({ error: 'funil não encontrado' });
  const stages = await prisma.pipelineStage.findMany({
    where: { funnelId: funnel.id },
    orderBy: { order: 'asc' },
    include: { deals: { orderBy: { createdAt: 'desc' }, include: { contact: true } } },
  });
  res.json({ funnel, stages });
});

/* ----------------------------- Etapas ------------------------------- */

crmRouter.post('/funnels/:id/stages', async (req, res) => {
  const ws = wsOf(req);
  if (!(await prisma.funnel.findFirst({ where: { id: req.params.id, workspaceId: ws } }))) return notFound(res);
  const count = await prisma.pipelineStage.count({ where: { funnelId: req.params.id } });
  const stage = await prisma.pipelineStage.create({
    data: {
      name: String(req.body?.name ?? 'Nova etapa'),
      color: String(req.body?.color ?? '#64748b'),
      order: count,
      funnelId: req.params.id,
      workspaceId: ws,
    },
  });
  res.json(stage);
});

crmRouter.patch('/stages/:id', async (req, res) => {
  if (!(await prisma.pipelineStage.findFirst({ where: { id: req.params.id, workspaceId: wsOf(req) } }))) return notFound(res);
  const { name, color, order } = req.body ?? {};
  res.json(await prisma.pipelineStage.update({ where: { id: req.params.id }, data: { name, color, order } }));
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
    },
    include: { contact: true },
  });
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
