import { randomBytes } from 'node:crypto';
import { Router, raw } from 'express';
import { wsOf } from '../auth.js';
import { getStatus, startWhatsApp, logoutWhatsApp, normalizePhone, sendMedia, refreshChannel } from '../whatsapp/session.js';
import { prisma } from '../db.js';
import { emit } from '../realtime.js';
import { saveMedia, kindFromMime, prepareOutgoingMedia, sanitizeMime } from '../whatsapp/media.js';
import { listTemplates } from '../whatsapp/cloud.js';
import { enc, dec } from '../crypto.js';

/** Conexão de WhatsApp do cliente aberto (cada escritório tem a sua). */
export const whatsappRouter = Router();

/* --------------------- API Oficial (Meta Cloud API) --------------------- */
whatsappRouter.get('/cloud', async (req, res) => {
  const ws = wsOf(req);
  let cfg = await prisma.waConfig.findUnique({ where: { id: ws } });
  if (!cfg) cfg = await prisma.waConfig.create({ data: { id: ws, cloudVerify: randomBytes(12).toString('hex') } });
  if (!cfg.cloudVerify) {
    cfg = await prisma.waConfig.update({ where: { id: ws }, data: { cloudVerify: randomBytes(12).toString('hex') } });
  }
  const host = req.get('x-forwarded-host') || req.get('host');
  res.json({
    channel: cfg.channel,
    phoneId: cfg.cloudPhoneId,
    wabaId: cfg.cloudWabaId,
    hasToken: Boolean(cfg.cloudToken),
    verifyToken: cfg.cloudVerify,
    webhookUrl: `https://${host}/api/wa/webhook/${ws}`,
  });
});

// Templates aprovados da conta (para disparos pela API Oficial).
whatsappRouter.get('/cloud/templates', async (req, res) => {
  const cfg = await prisma.waConfig.findUnique({ where: { id: wsOf(req) } });
  if (!cfg?.cloudToken || !cfg?.cloudWabaId) return res.json([]);
  try {
    res.json(await listTemplates(cfg.cloudWabaId, dec(cfg.cloudToken)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

whatsappRouter.patch('/cloud', async (req, res) => {
  const ws = wsOf(req);
  const { channel, phoneId, token, wabaId } = req.body ?? {};
  const data: Record<string, unknown> = {};
  if (channel === 'qr' || channel === 'cloud') data.channel = channel;
  if (typeof phoneId === 'string') data.cloudPhoneId = phoneId.trim();
  if (typeof wabaId === 'string') data.cloudWabaId = wabaId.trim();
  if (typeof token === 'string' && token.trim()) data.cloudToken = enc(token.trim());
  await prisma.waConfig.upsert({
    where: { id: ws },
    update: data,
    create: { id: ws, cloudVerify: randomBytes(12).toString('hex'), ...data },
  });
  await refreshChannel(ws);
  res.json({ ok: true, status: getStatus(ws) });
});

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

    const rawMime = sanitizeMime(String(req.query.mime || req.headers['content-type'] || ''));
    const caption = req.query.caption ? String(req.query.caption) : '';
    // Áudio (inclusive a gravação feita no LawHub) vira mensagem de voz OGG/Opus.
    const { buffer: outBuf, mimetype, filename, kind } = await prepareOutgoingMedia({
      buffer,
      mimetype: rawMime,
      filename: req.query.name ? String(req.query.name) : undefined,
      caption,
      kind: kindFromMime(rawMime),
    });

    const waMessageId = await sendMedia(ws, conversation.contact.waJid, { buffer: outBuf, mimetype, filename, caption, kind });
    const mediaId = await saveMedia(ws, outBuf);
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
  // force: pedido manual recomeça mesmo se o socket estiver preso em "conectando".
  await startWhatsApp(wsOf(req), { phone, force: true });
  res.json(getStatus(wsOf(req)));
});

// Reconecta do zero: apaga a sessão antiga e gera um QR novo (desbloqueia casos travados).
whatsappRouter.post('/reconnect', async (req, res) => {
  await logoutWhatsApp(wsOf(req));
  await startWhatsApp(wsOf(req), { force: true });
  res.json(getStatus(wsOf(req)));
});

// Desconecta e apaga as credenciais deste cliente.
whatsappRouter.post('/logout', async (req, res) => {
  await logoutWhatsApp(wsOf(req));
  res.json({ ok: true });
});
