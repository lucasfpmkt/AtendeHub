import { Router } from 'express';
import { prisma } from '../db.js';
import { dec } from '../crypto.js';
import { handleInboundMessage, type InboundMedia } from '../services/inbound.js';
import { sendText } from '../whatsapp/session.js';
import { downloadCloudMedia, markReadCloud } from '../whatsapp/cloud.js';
import type { MediaKind } from '../whatsapp/media.js';

/** Webhook PÚBLICO da API Oficial (Meta Cloud API). Um por cliente: /api/wa/webhook/:ws */
export const waWebhookRouter = Router();

// Verificação do webhook (a Meta chama com hub.verify_token).
waWebhookRouter.get('/:ws', async (req, res) => {
  const cfg = await prisma.waConfig.findUnique({ where: { id: req.params.ws } });
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (req.query['hub.mode'] === 'subscribe' && cfg?.cloudVerify && token === cfg.cloudVerify) {
    return res.status(200).send(String(challenge ?? ''));
  }
  res.sendStatus(403);
});

const MEDIA_KINDS: Record<string, MediaKind> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'document',
  sticker: 'sticker',
};

// Recebimento de mensagens.
waWebhookRouter.post('/:ws', async (req, res) => {
  res.sendStatus(200); // responde rápido; processa depois
  try {
    const ws = req.params.ws;
    const cfg = await prisma.waConfig.findUnique({ where: { id: ws } });
    if (!cfg || cfg.channel !== 'cloud') return;
    // O token é salvo criptografado: sem dec() a Meta recusava (401) mídia e "lido".
    const token = dec(cfg.cloudToken);

    for (const entry of req.body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        // Anti-spoofing: só aceita eventos do número configurado para este cliente.
        const incomingPhoneId = value?.metadata?.phone_number_id;
        // Falha fechada: evento sem phone_number_id (ou de outro número) é descartado.
        if (!cfg.cloudPhoneId || incomingPhoneId !== cfg.cloudPhoneId) continue;
        const contactName = value?.contacts?.[0]?.profile?.name as string | undefined;
        for (const msg of value?.messages ?? []) {
          if (msg.type === 'reaction' || msg.type === 'system') continue;
          const from = String(msg.from || '').replace(/\D/g, '');
          if (!from) continue;
          const waJid = `${from}@s.whatsapp.net`;
          const ctwaClid = msg?.referral?.ctwa_clid as string | undefined; // anúncio Click-to-WhatsApp

          let body = '';
          let media: InboundMedia | undefined;
          if (msg.type === 'text') body = msg.text?.body ?? '';
          else if (MEDIA_KINDS[msg.type]) {
            const node = msg[msg.type];
            body = node?.caption ?? '';
            try {
              const { buffer, mimetype } = await downloadCloudMedia(token, node.id);
              media = { kind: MEDIA_KINDS[msg.type], mimetype, filename: node?.filename, buffer };
            } catch (err) {
              console.error(`[cloud:${ws}] falha ao baixar mídia:`, (err as Error).message);
            }
          } else {
            continue; // tipos não suportados (location, contacts, etc.)
          }

          await markReadCloud(cfg.cloudPhoneId, token, msg.id);
          await handleInboundMessage({
            workspaceId: ws,
            waJid,
            pushName: contactName,
            body,
            media,
            waMessageId: msg.id,
            sendText: (to, text) => sendText(ws, to, text),
          }).catch((err) => console.error(`[cloud:${ws}] falha ao processar:`, err));
          // Após criar/achar o contato, guarda o id do clique do anúncio.
          if (ctwaClid) {
            await prisma.contact.updateMany({ where: { workspaceId: ws, waJid }, data: { ctwaClid } }).catch(() => {});
          }
        }
      }
    }
  } catch (err) {
    console.error('[webhook] erro:', (err as Error).message);
  }
});
