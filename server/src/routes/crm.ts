import { Router } from 'express';
import { prisma } from '../db.js';
import { emit } from '../realtime.js';
import { sendFromConversation } from '../whatsapp/session.js';
import { createFunnelWithDefaults } from '../services/crmSeed.js';
import { cancelPendingReply, systemNote } from '../services/inbound.js';

export const crmRouter = Router();

/* ----------------------------- Contatos ----------------------------- */

crmRouter.get('/contacts', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const contacts = await prisma.contact.findMany({
    where: q ? { OR: [{ name: { contains: q } }, { phone: { contains: q } }] } : undefined,
    orderBy: { updatedAt: 'desc' },
    include: { stage: true },
  });
  res.json(contacts);
});

crmRouter.patch('/contacts/:id', async (req, res) => {
  const { name, notes, tags, stageId } = req.body ?? {};
  const contact = await prisma.contact.update({
    where: { id: req.params.id },
    data: { name, notes, tags, stageId },
  });
  res.json(contact);
});

/* --------------------------- Conversas ------------------------------ */

crmRouter.get('/conversations', async (_req, res) => {
  const conversations = await prisma.conversation.findMany({
    orderBy: { lastMessageAt: 'desc' },
    include: {
      contact: true,
      messages: { where: { author: { not: 'system' } }, orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
  res.json(conversations);
});

crmRouter.get('/conversations/:id/messages', async (req, res) => {
  const messages = await prisma.message.findMany({
    where: { conversationId: req.params.id },
    orderBy: { createdAt: 'asc' },
  });
  res.json(messages);
});

crmRouter.post('/conversations/:id/messages', async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'texto vazio' });
  try {
    const message = await sendFromConversation(req.params.id, text);
    // Quando alguém da equipe responde, a IA para nesta conversa (evita os dois falando).
    const conv = await prisma.conversation.findUnique({ where: { id: req.params.id } });
    if (conv?.aiEnabled) {
      cancelPendingReply(conv.id);
      const updated = await prisma.conversation.update({ where: { id: conv.id }, data: { aiEnabled: false } });
      emit({ type: 'conversation:update', conversation: updated });
      await systemNote(conv.id, 'A equipe assumiu a conversa. A IA foi pausada.');
    }
    res.json(message);
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

crmRouter.patch('/conversations/:id', async (req, res) => {
  const { aiEnabled, status, assignedAgentId } = req.body ?? {};
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
  emit({ type: 'conversation:update', conversation });
  res.json(conversation);
});

// Zera o contador de não lidas ao abrir a conversa.
crmRouter.post('/conversations/:id/read', async (req, res) => {
  const conversation = await prisma.conversation.update({ where: { id: req.params.id }, data: { unread: 0 } });
  res.json(conversation);
});

/* ----------------------------- Funis -------------------------------- */

crmRouter.get('/funnels', async (_req, res) => {
  const funnels = await prisma.funnel.findMany({ orderBy: { order: 'asc' } });
  res.json(funnels);
});

crmRouter.post('/funnels', async (req, res) => {
  const name = String(req.body?.name ?? 'Novo funil').trim();
  const funnel = await createFunnelWithDefaults(name);
  res.json(funnel);
});

crmRouter.patch('/funnels/:id', async (req, res) => {
  const { name } = req.body ?? {};
  const funnel = await prisma.funnel.update({ where: { id: req.params.id }, data: { name } });
  res.json(funnel);
});

crmRouter.delete('/funnels/:id', async (req, res) => {
  await prisma.funnel.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// Quadro completo de um funil: etapas ordenadas, cada uma com seus negócios.
crmRouter.get('/funnels/:id/board', async (req, res) => {
  const funnel = await prisma.funnel.findUnique({ where: { id: req.params.id } });
  if (!funnel) return res.status(404).json({ error: 'funil não encontrado' });
  const stages = await prisma.pipelineStage.findMany({
    where: { funnelId: funnel.id },
    orderBy: { order: 'asc' },
    include: {
      deals: { orderBy: { createdAt: 'desc' }, include: { contact: true } },
    },
  });
  res.json({ funnel, stages });
});

/* ----------------------------- Etapas ------------------------------- */

crmRouter.post('/funnels/:id/stages', async (req, res) => {
  const count = await prisma.pipelineStage.count({ where: { funnelId: req.params.id } });
  const stage = await prisma.pipelineStage.create({
    data: {
      name: String(req.body?.name ?? 'Nova etapa'),
      color: String(req.body?.color ?? '#64748b'),
      order: count,
      funnelId: req.params.id,
    },
  });
  res.json(stage);
});

crmRouter.patch('/stages/:id', async (req, res) => {
  const { name, color, order } = req.body ?? {};
  const stage = await prisma.pipelineStage.update({
    where: { id: req.params.id },
    data: { name, color, order },
  });
  res.json(stage);
});

crmRouter.delete('/stages/:id', async (req, res) => {
  await prisma.pipelineStage.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

/* ----------------------------- Negócios ----------------------------- */

crmRouter.post('/deals', async (req, res) => {
  const { title, contactId, funnelId, stageId, valueCents, source, responsavel, tags } =
    req.body ?? {};
  if (!funnelId) return res.status(400).json({ error: 'funnelId obrigatório' });
  const deal = await prisma.deal.create({
    data: {
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
  const { title, stageId, funnelId, valueCents, source, responsavel, tags } = req.body ?? {};
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
  await prisma.deal.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// Exporta os negócios de um funil em CSV.
crmRouter.get('/funnels/:id/export', async (req, res) => {
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
  const csv = rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','))
    .join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="funil.csv"');
  res.send('﻿' + csv);
});

/* ----------------------------- Etiquetas ---------------------------- */

crmRouter.get('/tags', async (_req, res) => {
  const tags = await prisma.tag.findMany({ orderBy: { name: 'asc' } });
  res.json(tags);
});

crmRouter.post('/tags', async (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'nome obrigatório' });
  const color = String(req.body?.color ?? '#b71312');
  const tag = await prisma.tag.upsert({
    where: { name },
    update: { color },
    create: { name, color },
  });
  res.json(tag);
});

crmRouter.patch('/tags/:id', async (req, res) => {
  const { name, color } = req.body ?? {};
  const tag = await prisma.tag.update({ where: { id: req.params.id }, data: { name, color } });
  res.json(tag);
});

crmRouter.delete('/tags/:id', async (req, res) => {
  await prisma.tag.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});
