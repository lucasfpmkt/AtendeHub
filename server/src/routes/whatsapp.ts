import { Router, raw } from 'express';
import { wsOf } from '../auth.js';
import { getStatus, startWhatsApp, logoutWhatsApp, normalizePhone, sendMedia } from '../whatsapp/session.js';
import { prisma } from '../db.js';
import { emit } from '../realtime.js';
import { saveMedia, kindFromMime } from '../whatsapp/media.js';

/** Conexão de WhatsApp do cliente aberto (cada escritório tem a sua). */
export const whatsappRouter = Router();

// Envia um arquivo pelo WhatsApp. O corpo é o arquivo bruto; metadados vêm na query.
// (evita dependência de multipart: o front faz fetch com o File como body)
whatsappRouter.post('/send-media/:conversationId', raw({ type: '*/*', limit: '32mb' }), async (req, res) => {
  try {
    const ws = wsOf(req);
    const conversation = await prisma.conversation.findFirst({
      where: { id: req.params.conversationId, workspaceId: ws },
      include: { contact: true },
    });
    if (!conversation) return res.status(404).json({ error: 'conversa não encontrada' });

    const buffer = req.body as Buffer;
    if (!buffer?.length) return res.status(400).json({ error: 'arquivo vazio' });

    const mimetype = String(req.query.mime || req.headers['content-type'] || 'application/octet-stream');
    const filename = req.query.name ? String(req.query.name) : undefined;
    const caption = req.query.caption ? String(req.query.caption) : '';
    const kind = kindFromMime(mimetype);

    const waMessageId = await sendMedia(ws, conversation.contact.waJid, { buffer, mimetype, filename, caption, kind });
    const mediaId = await saveMedia(ws, buffer);
    const message = await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: 'out',
        author: 'agent',
        body: caption,
        waMessageId,
        mediaType: kind,
        mediaId,
        mediaName: filename ?? null,
        mimeType: mimetype,
      },
    });
    const updated = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });
    emit(ws, { type: 'message:new', conversationId: conversation.id, message });
    emit(ws, { type: 'conversation:update', conversation: updated });
    res.json(message);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Estado atual (inclui QR em data URL se estiver aguardando a leitura).
whatsappRouter.get('/status', (req, res) => {
  res.json(getStatus(wsOf(req)));
});

// Inicia a conexão: QR code, ou código de pareamento se vier { phone }.
whatsappRouter.post('/connect', async (req, res) => {
  const raw = req.body?.phone;
  let phone: string | undefined;
  if (raw !== undefined && raw !== '') {
    phone = normalizePhone(String(raw)) ?? undefined;
    if (!phone) return res.status(400).json({ error: 'Número inválido. Use DDI + DDD + número, ex.: 55 21 99999-0000.' });
  }
  await startWhatsApp(wsOf(req), { phone });
  res.json(getStatus(wsOf(req)));
});

// Desconecta e apaga as credenciais deste cliente.
whatsappRouter.post('/logout', async (req, res) => {
  await logoutWhatsApp(wsOf(req));
  res.json({ ok: true });
});
