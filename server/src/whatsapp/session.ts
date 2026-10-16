import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type WASocket,
} from '@whiskeysockets/baileys';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import QRCode from 'qrcode';
import pino from 'pino';
import { emit, type WaStatus } from '../realtime.js';
import { prisma } from '../db.js';
import { handleInboundMessage } from '../services/inbound.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Em produção/Docker, aponte WA_AUTH_DIR para um volume persistente.
const AUTH_DIR =
  process.env.WA_AUTH_DIR ?? path.resolve(__dirname, '../../auth_info');

const logger = pino({ level: 'warn' });

let sock: WASocket | null = null;
let status: WaStatus = 'disconnected';
let meJid: string | undefined;
let lastQrDataUrl: string | null = null;
let starting = false;

export function getStatus() {
  return { status, me: meJid, qr: status === 'qr' ? lastQrDataUrl : null };
}

function setStatus(next: WaStatus) {
  status = next;
  emit({ type: 'wa:status', status, me: meJid });
}

/** Abre (ou reabre) a conexão com o WhatsApp. Idempotente. */
export async function startWhatsApp() {
  if (starting || status === 'connected' || status === 'connecting') return;
  starting = true;
  setStatus('connecting');

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['AtendeHub', 'Chrome', '1.0.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        lastQrDataUrl = await QRCode.toDataURL(qr);
        setStatus('qr');
        emit({ type: 'wa:qr', dataUrl: lastQrDataUrl });
      }

      if (connection === 'open') {
        meJid = sock?.user?.id;
        lastQrDataUrl = null;
        setStatus('connected');
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        meJid = undefined;
        setStatus('disconnected');
        sock = null;
        starting = false;
        if (!loggedOut) {
          // Reconexão automática (queda de rede, etc.)
          setTimeout(() => void startWhatsApp(), 2000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (m.key.fromMe) continue;
        const jid = m.key.remoteJid;
        if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue; // ignora grupos/status

        const body =
          m.message?.conversation ??
          m.message?.extendedTextMessage?.text ??
          m.message?.imageMessage?.caption ??
          m.message?.videoMessage?.caption ??
          '';

        if (!body) continue;

        await handleInboundMessage({
          waJid: jid,
          pushName: m.pushName ?? undefined,
          body,
          waMessageId: m.key.id ?? undefined,
          sendText,
        });
      }
    });
  } finally {
    starting = false;
  }
}

/** Envia uma mensagem de texto. Lança erro se não estiver conectado. */
export async function sendText(jid: string, text: string) {
  if (!sock || status !== 'connected') {
    throw new Error('WhatsApp não está conectado');
  }
  await sock.sendMessage(jid, { text });
}

/** Encerra a sessão e apaga as credenciais (força novo QR). */
export async function logoutWhatsApp() {
  try {
    await sock?.logout();
  } catch {
    /* ignore */
  }
  sock = null;
  meJid = undefined;
  lastQrDataUrl = null;
  setStatus('disconnected');
  const { rm } = await import('node:fs/promises');
  await rm(AUTH_DIR, { recursive: true, force: true });
}

/** Envia mensagem a partir de uma conversa do CRM (usado pelas rotas). */
export async function sendFromConversation(conversationId: string, text: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { contact: true },
  });
  if (!conversation) throw new Error('Conversa não encontrada');
  await sendText(conversation.contact.waJid, text);

  const message = await prisma.message.create({
    data: {
      conversationId,
      direction: 'out',
      author: 'agent',
      body: text,
    },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: new Date() },
  });
  emit({ type: 'message:new', conversationId, message });
  return message;
}
