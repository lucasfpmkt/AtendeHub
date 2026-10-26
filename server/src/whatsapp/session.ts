import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  generateMessageIDV2,
  jidNormalizedUser,
  S_WHATSAPP_NET,
  type WASocket,
} from '@whiskeysockets/baileys';
import { kindLabel, type MediaKind } from './media.js';
import { sendTextCloud, sendMediaCloud } from './cloud.js';
import { dec } from '../crypto.js';
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

// Importação de histórico ao conectar: só as N conversas mais recentes, cada uma
// com as últimas M mensagens (evita lotar o LawHub com conversas antigas).
const HISTORY_CHATS = Math.max(0, Number(process.env.WA_HISTORY_CHATS ?? 30) || 0);
const HISTORY_MSGS_PER_CHAT = Math.max(1, Number(process.env.WA_HISTORY_MSGS_PER_CHAT ?? 10) || 10);

/** Uma conexão de WhatsApp por cliente (workspace). */
type Session = {
  sock: WASocket | null;
  status: WaStatus;
  me?: string;
  /** LID do próprio número (o WhatsApp também endereça a conversa consigo mesmo por LID). */
  meLid?: string;
  qr: string | null;
  starting: boolean;
  /** Conexão por código: número informado e código de 8 caracteres gerado. */
  pairPhone?: string;
  pairCode?: string | null;
  /** Tentativas seguidas de reconexão (para o backoff). */
  retries?: number;
  /** Timer do watchdog que confere se a conexão está viva de verdade. */
  watchdog?: NodeJS.Timeout | null;
};

/**
 * Ids de mensagens que o PRÓPRIO LawHub enviou. O Baileys emite o "eco" da
 * mensagem enviada antes do sendMessage retornar; sem isso o eco era tratado
 * como "operador digitou no celular" e a IA se desligava sozinha.
 */
const selfSent = new Map<string, number>();
function markSelfSent(id: string) {
  const now = Date.now();
  selfSent.set(id, now);
  for (const [k, t] of selfSent) if (now - t > 10 * 60_000) selfSent.delete(k);
}

/**
 * O Baileys represa TODOS os eventos (inclusive mensagens novas) logo após conectar
 * se a sessão ainda não recebeu a chave de sincronização do celular
 * (creds.myAppStateKeyId) — e esse represamento não tem tempo-limite. Quando a
 * chave não chega, a conexão fica "conectada" e muda. Libera o que estiver preso.
 */
function releaseBufferedEvents(ws: string, sock: WASocket): boolean {
  if (!sock.ev.isBuffering()) return false;
  console.warn(`[wa:${ws}] eventos represados pelo Baileys (sem chave de sync do celular) — liberando`);
  for (let i = 0; i < 20 && sock.ev.isBuffering(); i++) sock.ev.flush();
  return true;
}

/**
 * Identificador da conversa. O WhatsApp agora endereça muitos contatos por LID
 * (um id oculto, ex.: 146832063738035@lid) em vez do telefone. Quando o Baileys
 * informa o telefone real (remoteJidAlt), usamos ele: o contato fica com o número
 * de verdade na tela e não se duplica entre LID e telefone. Envio para o telefone
 * funciona — o Baileys 7 converte para o LID por baixo.
 */
function chatJidOf(key: { remoteJid?: string | null; remoteJidAlt?: string | null }): string | null {
  const jid = key.remoteJid ?? null;
  if (jid?.endsWith('@lid') && key.remoteJidAlt?.endsWith('@s.whatsapp.net')) return key.remoteJidAlt;
  return jid;
}

const userOf = (jid?: string | null) => (jid ? jid.split('@')[0].split(':')[0] : '');

/** É a conversa do número consigo mesmo ("Mensagem para você")? Não vira contato no CRM. */
function isSelfChat(s: Session, jid: string): boolean {
  const u = userOf(jid);
  return Boolean(u) && (u === userOf(s.me) || u === userOf(s.meLid));
}

/** JID do próprio número conectado por QR (destino das notificações ao escritório). */
export function ownJid(ws: string): string | null {
  if (cloudInfo.get(ws)) return null; // API Oficial não envia mensagem para si mesma
  const s = sessions.get(ws);
  return s?.me && s.status === 'connected' ? jidNormalizedUser(s.me) : null;
}

/** Ping na conexão do WhatsApp com tempo-limite: detecta socket "zumbi". */
async function pingSocket(sock: WASocket, timeoutMs = 20_000): Promise<boolean> {
  try {
    await Promise.race([
      sock.query({ tag: 'iq', attrs: { to: S_WHATSAPP_NET, type: 'get', xmlns: 'w:p' }, content: [{ tag: 'ping', attrs: {} }] }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('ping timeout')), timeoutMs)),
    ]);
    return true;
  } catch {
    return false;
  }
}
const sessions = new Map<string, Session>();

// Clientes que usam a API Oficial (Cloud API) em vez do QR/Baileys.
const cloudInfo = new Map<string, { phoneId: string; token: string }>();

function sessionOf(ws: string): Session {
  let s = sessions.get(ws);
  if (!s) {
    s = { sock: null, status: 'disconnected', qr: null, starting: false };
    sessions.set(ws, s);
  }
  return s;
}

/** Recarrega o canal de um cliente a partir do banco (QR x Cloud API). */
export async function refreshChannel(ws: string) {
  const cfg = await prisma.waConfig.findUnique({ where: { id: ws } });
  if (cfg?.channel === 'cloud' && cfg.cloudPhoneId.trim() && cfg.cloudToken.trim()) {
    cloudInfo.set(ws, { phoneId: cfg.cloudPhoneId.trim(), token: dec(cfg.cloudToken) });
    // Virou API Oficial: encerra qualquer sessão Baileys antiga (evita duplicidade).
    const s = sessions.get(ws);
    if (s?.sock) {
      try {
        s.sock.end?.(undefined as unknown as Error);
      } catch {
        /* ignore */
      }
      s.sock = null;
      s.starting = false;
      s.status = 'disconnected';
    }
  } else {
    cloudInfo.delete(ws);
  }
}

export function cloudOf(ws: string) {
  return cloudInfo.get(ws);
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
  const cloud = cloudInfo.get(ws);
  if (cloud) {
    return { status: 'connected' as WaStatus, me: cloud.phoneId, qr: null, pairCode: null, channel: 'cloud' as const };
  }
  const s = sessionOf(ws);
  return {
    status: s.status,
    me: s.me,
    qr: s.status === 'qr' ? s.qr : null,
    pairCode: s.status === 'qr' ? (s.pairCode ?? null) : null,
    channel: 'qr' as const,
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
export async function startWhatsApp(ws: string, opts: { phone?: string; force?: boolean } = {}) {
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
  if (opts.force && s.status !== 'connected') {
    // Pedido explícito do usuário: derruba um socket preso em "conectando" e recomeça.
    try {
      s.sock?.end?.(undefined as unknown as Error);
    } catch {
      /* ignore */
    }
    s.sock = null;
    s.starting = false;
    s.qr = null;
  }
  if (s.starting || s.status === 'connected' || s.status === 'connecting') return;
  s.starting = true;
  setStatus(ws, 'connecting');

  try {
    const { state, saveCreds } = await useMultiFileAuthState(await authDirOf(ws));
    const { version } = await fetchLatestBaileysVersion();

    // Por cliente: se importHistory=false, não puxa o histórico antigo ao
    // (re)conectar — só as mensagens novas entram no LawHub.
    const wsRow = await prisma.workspace.findUnique({ where: { id: ws }, select: { importHistory: true } });
    const importHistory = wsRow?.importHistory !== false;

    const sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['LawHub', 'Chrome', '1.0.0'],
      // Não marca o número como "online" ao conectar: assim o celular continua
      // recebendo as notificações normais do WhatsApp.
      markOnlineOnConnect: false,
      // Não pede o histórico COMPLETO (milhares de mensagens): o aparelho já manda o
      // histórico recente, e dele só importamos as conversas mais recentes (ver abaixo).
      syncFullHistory: false,
      // Cliente sem importação de histórico: o Baileys nem processa o histórico e vai
      // direto para "online". Sem isso ele entra em "Syncing" e, se a sincronização de
      // estado falhar, fica represando as mensagens novas para sempre.
      shouldSyncHistoryMessage: () => importHistory,
      // Links enviados ganham pré-visualização (título, imagem) — usa o link-preview-js.
      generateHighQualityLinkPreview: true,
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
        s.meLid = sock.user?.lid ?? undefined;
        s.qr = null;
        s.pairPhone = undefined;
        s.pairCode = null;
        s.retries = 0;
        setStatus(ws, 'connected');

        // Mensagens presas no represamento do Baileys após conectar: libera.
        for (const ms of [20_000, 60_000]) {
          setTimeout(() => {
            if (s.sock === sock) releaseBufferedEvents(ws, sock);
          }, ms);
        }

        // Watchdog: a cada minuto confere se a conexão responde. O status pode ficar
        // "conectado" com o socket morto (sem evento 'close'); 2 falhas seguidas → reconecta.
        if (s.watchdog) clearInterval(s.watchdog);
        let fails = 0;
        s.watchdog = setInterval(async () => {
          if (s.sock !== sock || s.status !== 'connected') {
            if (s.watchdog) clearInterval(s.watchdog);
            s.watchdog = null;
            return;
          }
          releaseBufferedEvents(ws, sock);
          if (await pingSocket(sock)) {
            fails = 0;
            return;
          }
          fails += 1;
          console.warn(`[wa:${ws}] watchdog: conexão sem resposta (${fails}/2)`);
          if (fails < 2) return;
          if (s.watchdog) clearInterval(s.watchdog);
          s.watchdog = null;
          console.warn(`[wa:${ws}] watchdog: reconectando o WhatsApp`);
          try {
            sock.end(new Error('watchdog: conexão sem resposta'));
          } catch {
            /* ignore */
          }
          // Se o 'close' não disparar, força a reconexão.
          setTimeout(() => {
            if (s.sock === sock) {
              s.sock = null;
              s.starting = false;
              setStatus(ws, 'disconnected');
              void startWhatsApp(ws);
            }
          }, 3000);
        }, 60_000);
      }

      if (connection === 'close') {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        s.me = undefined;
        s.sock = null;
        s.starting = false;
        s.pairCode = null;
        setStatus(ws, 'disconnected');
        if (s.watchdog) clearInterval(s.watchdog);
        s.watchdog = null;
        if (loggedOut) {
          // Credenciais inválidas (aparelho desvinculado): apaga para o próximo
          // "Gerar QR" mostrar um QR novo em vez de tentar retomar a sessão morta.
          await rm(await authDirOf(ws), { recursive: true, force: true }).catch(() => {});
        } else if (code === DisconnectReason.connectionReplaced) {
          // Outra sessão assumiu este número: reconectar só gera um "cabo de guerra"
          // (risco de bloqueio). Fica desconectado até alguém reconectar.
          console.warn(`[wa:${ws}] sessão substituída por outro aparelho/servidor; não vou reconectar sozinho.`);
        } else {
          // Queda de rede etc.: reconecta com espera crescente (2s, 4s, 8s… até 60s).
          s.retries = (s.retries ?? 0) + 1;
          const delay = Math.min(60_000, 2000 * 2 ** Math.min(s.retries - 1, 5));
          setTimeout(() => void startWhatsApp(ws), delay);
        }
      }
    });

    // Histórico: o aparelho envia as conversas antigas em lotes após conectar.
    // Histórico: o aparelho envia as conversas antigas em VÁRIOS lotes após conectar.
    // Para não lotar o LawHub, acumula os lotes e, quando param de chegar, importa só
    // as HISTORY_CHATS conversas mais recentes, cada uma com as últimas
    // HISTORY_MSGS_PER_CHAT mensagens. Mensagens novas continuam entrando normalmente.
    type HistItem = { jid: string; pushName?: string; body: string; fromMe: boolean; id?: string; ts: number };
    const histBuffer: HistItem[] = [];
    let histTimer: NodeJS.Timeout | null = null;

    const flushHistory = async () => {
      histTimer = null;
      const items = histBuffer.splice(0);
      if (!items.length) return;
      // Agrupa por conversa e ordena as conversas pela mensagem mais recente.
      const byChat = new Map<string, HistItem[]>();
      for (const it of items) {
        const list = byChat.get(it.jid) ?? [];
        list.push(it);
        byChat.set(it.jid, list);
      }
      const chats = [...byChat.values()]
        .map((list) => list.sort((a, b) => a.ts - b.ts))
        .sort((a, b) => b[b.length - 1].ts - a[a.length - 1].ts)
        .slice(0, HISTORY_CHATS);

      let imported = 0;
      for (const list of chats) {
        for (const it of list.slice(-HISTORY_MSGS_PER_CHAT)) {
          await importHistoryMessage({
            workspaceId: ws,
            waJid: it.jid,
            pushName: it.pushName,
            body: it.body,
            fromMe: it.fromMe,
            waMessageId: it.id,
            timestampMs: it.ts,
          })
            .then(() => (imported += 1))
            .catch((err) => console.error(`[wa:${ws}] falha ao importar histórico:`, err));
        }
      }
      if (imported > 0) {
        console.log(`[wa:${ws}] histórico importado: ${chats.length} conversas, ${imported} mensagens (de ${byChat.size} conversas recebidas)`);
        // Recarrega a lista de conversas na UI e o CRM.
        emit(ws, { type: 'conversation:update', conversation: { id: 'history-sync' } });
        emit(ws, { type: 'crm:update' });
      }
    };

    sock.ev.on('messaging-history.set', async ({ messages }) => {
      if (!importHistory) return; // cliente configurado para não importar histórico antigo
      if (!messages?.length) return;
      for (const m of messages) {
        const jid = chatJidOf(m.key);
        if (!jid || jid.endsWith('@g.us') || jid.endsWith('@newsletter') || jid === 'status@broadcast') continue;
        if (isSelfChat(s, jid)) continue;
        const body =
          m.message?.conversation ??
          m.message?.extendedTextMessage?.text ??
          m.message?.imageMessage?.caption ??
          m.message?.videoMessage?.caption ??
          '';
        if (!body) continue;
        histBuffer.push({
          jid,
          pushName: m.pushName ?? undefined,
          body,
          fromMe: Boolean(m.key.fromMe),
          id: m.key.id ?? undefined,
          ts: Number(m.messageTimestamp ?? 0) * 1000,
        });
      }
      // Espera os lotes pararem de chegar antes de escolher as mais recentes.
      if (histTimer) clearTimeout(histTimer);
      histTimer = setTimeout(() => void flushHistory(), 15_000);
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
      // Registro enxuto de recebimento: mostra no log se a mensagem chegou ao servidor.
      for (const m of messages) {
        console.log(`[wa:${ws}] upsert ${type} ${m.key.fromMe ? 'enviada' : 'recebida'} ${m.key.remoteJid ?? '?'}${m.key.remoteJidAlt ? ` (${m.key.remoteJidAlt})` : ''}${m.messageStubType ? ` stub=${m.messageStubType}` : ''}`);
      }
      for (const m of messages) {
        const jid = chatJidOf(m.key);
        if (!jid || jid.endsWith('@g.us') || jid.endsWith('@newsletter') || jid === 'status@broadcast') continue; // ignora grupos/canais/status
        if (isSelfChat(s, jid)) continue; // "Mensagem para você" (ex.: notificações do LawHub)

        const parsed = await readMessage(m);
        if (!parsed) continue;

        if (m.key.fromMe) {
          // Eco de uma mensagem que o próprio LawHub enviou: já está gravada.
          if (m.key.id && selfSent.has(m.key.id)) continue;
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

        // Mensagens de ENTRADA: 'notify' (ao vivo) E 'append' — o Baileys marca como 'append'
        // as mensagens que chegaram enquanto o LawHub estava fora do ar (restart/deploy/queda).
        // Antes eram descartadas e se perdiam. O histórico antigo NÃO vem por aqui (vem pelo
        // messaging-history.set) e mensagens repetidas são ignoradas pelo waMessageId.
        void type;

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
  // Carrega os canais (Cloud API) antes de iniciar o Baileys.
  const configs = await prisma.waConfig.findMany();
  for (const c of configs) {
    if (c.channel === 'cloud' && c.cloudPhoneId.trim() && c.cloudToken.trim()) {
      cloudInfo.set(c.id, { phoneId: c.cloudPhoneId.trim(), token: dec(c.cloudToken) });
    }
  }
  const all = await prisma.workspace.findMany({ where: { active: true }, select: { id: true } });
  for (const w of all) {
    if (cloudInfo.has(w.id)) continue; // usa API Oficial: não abre Baileys
    if (existsSync(path.join(await authDirOf(w.id), 'creds.json'))) void startWhatsApp(w.id);
  }
}

/** Envia texto pelo WhatsApp do cliente (QR ou API Oficial). */
export async function sendText(ws: string, jid: string, text: string): Promise<string | undefined> {
  const cloud = cloudInfo.get(ws);
  if (cloud) return sendTextCloud(cloud.phoneId, cloud.token, jid, text);
  const s = sessionOf(ws);
  if (!s.sock || s.status !== 'connected') throw new Error('WhatsApp não está conectado');
  const messageId = generateMessageIDV2(s.sock.user?.id);
  markSelfSent(messageId);
  const sent = await s.sock.sendMessage(jid, { text }, { messageId });
  return sent?.key?.id ?? messageId;
}

/** Envia um arquivo (imagem/vídeo/áudio/documento) pelo WhatsApp do cliente. */
export async function sendMedia(
  ws: string,
  jid: string,
  opts: { buffer: Buffer; mimetype: string; filename?: string; caption?: string; kind: MediaKind },
): Promise<string | undefined> {
  const cloud = cloudInfo.get(ws);
  if (cloud) return sendMediaCloud(cloud.phoneId, cloud.token, jid, opts);
  const s = sessionOf(ws);
  if (!s.sock || s.status !== 'connected') throw new Error('WhatsApp não está conectado');
  const caption = opts.caption?.trim() || undefined;
  let content: any;
  if (opts.kind === 'image') content = { image: opts.buffer, mimetype: opts.mimetype, caption };
  else if (opts.kind === 'video') content = { video: opts.buffer, mimetype: opts.mimetype, caption };
  else if (opts.kind === 'audio') content = { audio: opts.buffer, mimetype: opts.mimetype, ptt: true };
  else content = { document: opts.buffer, mimetype: opts.mimetype, fileName: opts.filename || 'arquivo', caption };
  const messageId = generateMessageIDV2(s.sock.user?.id);
  markSelfSent(messageId);
  const sent = await s.sock.sendMessage(jid, content, { messageId });
  return sent?.key?.id ?? messageId;
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
  s.starting = false;
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
