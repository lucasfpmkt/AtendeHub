import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import { kindLabel, type MediaKind } from './media.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import QRCode from 'qrcode';
import pino from 'pino';
import { emit, type WaStatus } from '../realtime.js';
import { prisma } from '../db.js';
import { handleInboundMessage, importHistoryMessage, recordOutgoingMessage } from '../services/inbound.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Em produção/Docker, aponte WA_AUTH_DIR para um volume persistente.
const BASE_DIR = process.env.WA_AUTH_DIR ?? path.resolve(__dirname, '../../auth_info');

const logger = pino({ level: 'warn' });

/** Uma conexão de WhatsApp por cliente (workspace). */
type Session = {
  sock: WASocket | null;
  status: WaStatus;
  me?: string;
  qr: string | null;
  starting: boolean;
  /** Conexão por código: número informado e código de 8 caracteres gerado. */
  pairPhone?: string;
  pairCode?: string | null;
};
const sessions = new Map<string, Session>();

function sessionOf(ws: string): Session {
  let s = sessions.get(ws);
  if (!s) {
    s = { sock: null, status: 'disconnected', qr: null, starting: false };
    sessions.set(ws, s);
  }
  return s;
}

/**
 * Pasta de credenciais do cliente. O cliente migrado da versão antiga
 * (legacyAuth) continua na pasta original, então não precisa novo QR.
 */
async function authDirOf(ws: string): Promise<string> {
  const w = await prisma.workspace.findUnique({ where: { id: ws }, select: { legacyAuth: true } });
  return w?.legacyAuth ? BASE_DIR : path.join(`${BASE_DIR}-ws`, ws);
}

export function getStatus(ws: string) {
  const s = sessionOf(ws);
  return {
    status: s.status,
    me: s.me,
    qr: s.status === 'qr' ? s.qr : null,
    pairCode: s.status === 'qr' ? (s.pairCode ?? null) : null,
  };
}

function setStatus(ws: string, next: WaStatus) {
  const s = sessionOf(ws);
  s.status = next;
  emit(ws, { type: 'wa:status', status: next, me: s.me });
}

/** Só dígitos, com DDI (ex.: 5521999990000). Devolve null se inválido. */
export function normalizePhone(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  return d.length >= 10 && d.length <= 15 ? d : null;
}

/** Pede ao WhatsApp o código de pareamento para o número informado. */
async function requestPair(ws: string, s: Session) {
  if (!s.sock || !s.pairPhone || s.pairCode) return;
  try {
    const code = await s.sock.requestPairingCode(s.pairPhone);
    s.pairCode = code;
    emit(ws, { type: 'wa:pair', code });
  } catch (err) {
    console.error(`[wa:${ws}] falha ao gerar código de pareamento:`, err);
    s.pairPhone = undefined;
    emit(ws, { type: 'wa:pair', code: null, error: 'O WhatsApp não gerou o código. Aguarde alguns minutos e tente de novo.' });
  }
}

/**
 * Abre (ou reabre) a conexão do cliente. Idempotente.
 * Com `phone`, conecta por código (digitado no celular) em vez de QR.
 */
export async function startWhatsApp(ws: string, opts: { phone?: string } = {}) {
  const s = sessionOf(ws);
  if (opts.phone) {
    s.pairPhone = opts.phone;
    s.pairCode = null;
    // Socket já aberto aguardando leitura: pede o código nele mesmo.
    if (s.status === 'qr' && s.sock) {
      await requestPair(ws, s);
      return;
    }
  }
  if (s.starting || s.status === 'connected' || s.status === 'connecting') return;
  s.starting = true;
  setStatus(ws, 'connecting');

  try {
    const { state, saveCreds } = await useMultiFileAuthState(await authDirOf(ws));
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['LawHub', 'Chrome', '1.0.0'],
      // Não marca o número como "online" ao conectar: assim o celular continua
      // recebendo as notificações normais do WhatsApp.
      markOnlineOnConnect: false,
      // Puxa o histórico de conversas do aparelho na sincronização inicial.
      syncFullHistory: true,
    });
    s.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        s.qr = await QRCode.toDataURL(qr);
        setStatus(ws, 'qr');
        emit(ws, { type: 'wa:qr', dataUrl: s.qr });
        // Socket pronto: se o usuário pediu conexão por código, gera agora (uma vez).
        if (s.pairPhone && !s.pairCode) await requestPair(ws, s);
      }

      if (connection === 'open') {
        s.me = sock.user?.id;
        s.qr = null;
        s.pairPhone = undefined;
        s.pairCode = null;
        setStatus(ws, 'connected');
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        s.me = undefined;
        s.sock = null;
        s.starting = false;
        s.pairCode = null;
        setStatus(ws, 'disconnected');
        if (!loggedOut) setTimeout(() => void startWhatsApp(ws), 2000); // queda de rede etc.
      }
    });

    // Histórico: o aparelho envia as conversas antigas em lotes após conectar.
    sock.ev.on('messaging-history.set', async ({ messages }) => {
      if (!messages?.length) return;
      let imported = 0;
      for (const m of messages) {
        const jid = m.key.remoteJid;
        if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;
        const body =
          m.message?.conversation ??
          m.message?.extendedTextMessage?.text ??
          m.message?.imageMessage?.caption ??
          m.message?.videoMessage?.caption ??
          '';
        if (!body) continue;
        await importHistoryMessage({
          workspaceId: ws,
          waJid: jid,
          pushName: m.pushName ?? undefined,
          body,
          fromMe: Boolean(m.key.fromMe),
          waMessageId: m.key.id ?? undefined,
          timestampMs: Number(m.messageTimestamp ?? 0) * 1000,
        })
          .then(() => (imported += 1))
          .catch((err) => console.error(`[wa:${ws}] falha ao importar histórico:`, err));
      }
      if (imported > 0) {
        console.log(`[wa:${ws}] histórico importado: ${imported} mensagens`);
        // Recarrega a lista de conversas na UI e o CRM.
        emit(ws, { type: 'conversation:update', conversation: { id: 'history-sync' } });
        emit(ws, { type: 'crm:update' });
      }
    });

    // Lê texto e baixa mídia (imagem/áudio/vídeo/documento) de uma mensagem.
    const readMessage = async (m: any): Promise<{ body: string; media?: { kind: MediaKind; mimetype: string; filename?: string; buffer: Buffer } } | null> => {
      const msg = m.message;
      if (!msg) return null;
      const text = msg.conversation ?? msg.extendedTextMessage?.text ?? '';

      let spec: { kind: MediaKind; mimetype: string; filename?: string; caption?: string } | null = null;
      if (msg.imageMessage) spec = { kind: 'image', mimetype: msg.imageMessage.mimetype ?? 'image/jpeg', caption: msg.imageMessage.caption ?? '' };
      else if (msg.videoMessage) spec = { kind: 'video', mimetype: msg.videoMessage.mimetype ?? 'video/mp4', caption: msg.videoMessage.caption ?? '' };
      else if (msg.audioMessage) spec = { kind: 'audio', mimetype: msg.audioMessage.mimetype ?? 'audio/ogg' };
      else if (msg.stickerMessage) spec = { kind: 'sticker', mimetype: 'image/webp' };
      else if (msg.documentMessage)
        spec = { kind: 'document', mimetype: msg.documentMessage.mimetype ?? 'application/octet-stream', filename: msg.documentMessage.fileName ?? 'arquivo', caption: msg.documentMessage.caption ?? '' };
      else if (msg.documentWithCaptionMessage?.message?.documentMessage) {
        const d = msg.documentWithCaptionMessage.message.documentMessage;
        spec = { kind: 'document', mimetype: d.mimetype ?? 'application/octet-stream', filename: d.fileName ?? 'arquivo', caption: d.caption ?? '' };
      }

      if (spec) {
        try {
          const buffer = (await downloadMediaMessage(m, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })) as Buffer;
          const caption = (spec.caption ?? '').trim();
          return { body: caption || kindLabel(spec.kind), media: { kind: spec.kind, mimetype: spec.mimetype, filename: spec.filename, buffer } };
        } catch (err) {
          console.error(`[wa:${ws}] falha ao baixar mídia:`, (err as Error).message);
          return { body: kindLabel(spec.kind) }; // registra ao menos o rótulo
        }
      }
      return text ? { body: text } : null;
    };

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const m of messages) {
        const jid = m.key.remoteJid;
        if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue; // ignora grupos/status

        const parsed = await readMessage(m);
        if (!parsed) continue;

        if (m.key.fromMe) {
          // Mensagem enviada pelo próprio número (celular do operador ou o próprio LawHub).
          // Processa em qualquer tipo (notify/append): o envio pelo celular pode vir como 'append'.
          await recordOutgoingMessage({
            workspaceId: ws,
            waJid: jid,
            body: parsed.body,
            waMessageId: m.key.id ?? undefined,
            media: parsed.media,
          }).catch((err) => console.error(`[wa:${ws}] falha ao gravar mensagem enviada:`, err));
          continue;
        }

        // Mensagens de ENTRADA: só as novas (notify). Ignora sincronização de histórico (append).
        if (type !== 'notify') continue;

        await handleInboundMessage({
          workspaceId: ws,
          waJid: jid,
          pushName: m.pushName ?? undefined,
          body: parsed.body,
          waMessageId: m.key.id ?? undefined,
          media: parsed.media,
          sendText: (to, text) => sendText(ws, to, text),
        }).catch((err) => console.error(`[wa:${ws}] falha ao processar mensagem:`, err));
      }
    });
  } finally {
    s.starting = false;
  }
}

/** Reabre na subida as conexões que já têm credenciais salvas. */
export async function startSavedSessions() {
  const all = await prisma.workspace.findMany({ where: { active: true }, select: { id: true } });
  for (const w of all) {
    if (existsSync(path.join(await authDirOf(w.id), 'creds.json'))) void startWhatsApp(w.id);
  }
}

/** Envia texto pelo WhatsApp do cliente. Lança erro se não estiver conectado. */
export async function sendText(ws: string, jid: string, text: string): Promise<string | undefined> {
  const s = sessionOf(ws);
  if (!s.sock || s.status !== 'connected') throw new Error('WhatsApp não está conectado');
  const sent = await s.sock.sendMessage(jid, { text });
  return sent?.key?.id ?? undefined;
}

/** Envia um arquivo (imagem/vídeo/áudio/documento) pelo WhatsApp do cliente. */
export async function sendMedia(
  ws: string,
  jid: string,
  opts: { buffer: Buffer; mimetype: string; filename?: string; caption?: string; kind: MediaKind },
): Promise<string | undefined> {
  const s = sessionOf(ws);
  if (!s.sock || s.status !== 'connected') throw new Error('WhatsApp não está conectado');
  const caption = opts.caption?.trim() || undefined;
  let content: any;
  if (opts.kind === 'image') content = { image: opts.buffer, mimetype: opts.mimetype, caption };
  else if (opts.kind === 'video') content = { video: opts.buffer, mimetype: opts.mimetype, caption };
  else if (opts.kind === 'audio') content = { audio: opts.buffer, mimetype: opts.mimetype, ptt: true };
  else content = { document: opts.buffer, mimetype: opts.mimetype, fileName: opts.filename || 'arquivo', caption };
  const sent = await s.sock.sendMessage(jid, content);
  return sent?.key?.id ?? undefined;
}

/** Encerra a sessão do cliente e apaga as credenciais (força novo QR). */
export async function logoutWhatsApp(ws: string) {
  const s = sessionOf(ws);
  try {
    await s.sock?.logout();
  } catch {
    /* ignore */
  }
  s.sock = null;
  s.me = undefined;
  s.qr = null;
  s.pairPhone = undefined;
  s.pairCode = null;
  setStatus(ws, 'disconnected');
  await rm(await authDirOf(ws), { recursive: true, force: true });
}

/** Encerra a conexão e esquece a sessão (usado ao excluir um cliente). */
export async function dropSession(ws: string) {
  await logoutWhatsApp(ws);
  sessions.delete(ws);
}

/** Envia mensagem a partir de uma conversa do CRM (usado pelas rotas). */
export async function sendFromConversation(ws: string, conversationId: string, text: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId: ws },
    include: { contact: true },
  });
  if (!conversation) throw new Error('Conversa não encontrada');
  const waMessageId = await sendText(ws, conversation.contact.waJid, text);

  const message = await prisma.message.create({
    data: { conversationId, direction: 'out', author: 'agent', body: text, waMessageId },
  });
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
  emit(ws, { type: 'message:new', conversationId, message });
  return message;
}
