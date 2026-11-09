import { Router, type Request } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '../db.js';
import { dec } from '../crypto.js';
import { env } from '../env.js';
import { alertAdmin } from '../services/alerts.js';
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

/**
 * Assinatura da Meta (X-Hub-Signature-256 = HMAC-SHA256 do corpo cru com o App Secret).
 * Devolve 'ok' | 'bad' | 'unverified' (sem segredo ou sem cabeçalho para conferir).
 */
function checkSignature(req: Request, secret: string): 'ok' | 'bad' | 'unverified' {
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  const header = String(req.headers['x-hub-signature-256'] ?? '');
  if (!secret || !raw || !header.startsWith('sha256=')) return 'unverified';
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  const got = header.slice(7).toLowerCase();
  if (got.length !== expected.length) return 'bad';
  return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex')) ? 'ok' : 'bad';
}

// Recebimento de mensagens.
waWebhookRouter.post('/:ws', async (req, res) => {
  res.sendStatus(200); // responde rápido; processa depois
  try {
    const ws = req.params.ws;
    const cfg = await prisma.waConfig.findUnique({ where: { id: ws } });
    if (!cfg || cfg.channel !== 'cloud') return;

    // Assinatura: com o App Secret do próprio cliente (Conectar WhatsApp › API Oficial) a
    // conferência é obrigatória; só com o do app global, uma falha avisa o administrador
    // mas não descarta (o cliente pode usar outro app da Meta). Sem segredo nenhum, fica
    // só a conferência do phone_number_id abaixo.
    const ownSecret = dec(cfg.cloudAppSecret).trim();
    const sig = checkSignature(req, ownSecret || env.fbAppSecret);
    if (sig === 'bad') {
      console.warn(`[cloud:${ws}] webhook com assinatura inválida${ownSecret ? ' — descartado' : ' (app global; processado mesmo assim)'}`);
      void alertAdmin(
        `wa_webhook_sig:${ws}`,
        ownSecret
          ? `⚠️ O webhook da API Oficial do WhatsApp de um cliente chegou com assinatura inválida e foi descartado. Se o App Secret colado em Conectar WhatsApp › API Oficial estiver errado, mensagens reais estão sendo perdidas.`
          : `⚠️ O webhook da API Oficial do WhatsApp de um cliente chegou com assinatura que não bate com o FB_APP_SECRET global. Se o cliente usa outro app da Meta, cole o App Secret dele em Conectar WhatsApp › API Oficial; se não, pode ser alguém forjando eventos.`,
      );
      if (ownSecret) return;
    }
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
