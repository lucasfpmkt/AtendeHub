import { Router } from 'express';
import { prisma } from '../db.js';
import { emit } from '../realtime.js';
import { sendFromConversation } from '../whatsapp/session.js';

export const crmRouter = Router();

/* ----------------------------- Contatos ----------------------------- */

crmRouter.get('/contacts', async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const contacts = await prisma.contact.findMany({
    where: q
      ? {
          OR: [
            { name: { contains: q } },
            { phone: { contains: q } },
          ],
        }
      : undefined,
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
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
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

// Envia uma mensagem do agente pelo WhatsApp.
crmRouter.post('/conversations/:id/messages', async (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'texto vazio' });
  try {
    const message = await sendFromConversation(req.params.id, text);
    res.json(message);
  } catch (err) {
    res.status(409).json({ error: (err as Error).message });
  }
});

// Liga/desliga auto-resposta por IA e status da conversa.
crmRouter.patch('/conversations/:id', async (req, res) => {
  const { aiEnabled, status } = req.body ?? {};
  const conversation = await prisma.conversation.update({
    where: { id: req.params.id },
    data: { aiEnabled, status },
  });
  emit({ type: 'conversation:update', conversation });
  res.json(conversation);
});

/* ------------------------- Pipeline / Deals ------------------------- */

crmRouter.get('/stages', async (_req, res) => {
  const stages = await prisma.pipelineStage.findMany({
    orderBy: { order: 'asc' },
    include: {
      deals: { include: { contact: true } },
    },
  });
  res.json(stages);
});

crmRouter.post('/stages', async (req, res) => {
  const count = await prisma.pipelineStage.count();
  const stage = await prisma.pipelineStage.create({
    data: { name: String(req.body?.name ?? 'Nova etapa'), order: count },
  });
  res.json(stage);
});

crmRouter.post('/deals', async (req, res) => {
  const { title, contactId, stageId, valueCents } = req.body ?? {};
  const deal = await prisma.deal.create({
    data: {
      title: String(title ?? 'Nova oportunidade'),
      contactId,
      stageId,
      valueCents: Number(valueCents ?? 0),
    },
  });
  res.json(deal);
});

crmRouter.patch('/deals/:id', async (req, res) => {
  const { title, stageId, valueCents } = req.body ?? {};
  const deal = await prisma.deal.update({
    where: { id: req.params.id },
    data: { title, stageId, valueCents },
  });
  res.json(deal);
});
