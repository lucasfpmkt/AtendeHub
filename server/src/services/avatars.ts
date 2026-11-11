/**
 * Foto de perfil dos contatos (leads) puxada do WhatsApp.
 *
 * A URL que o WhatsApp devolve expira em poucos dias, então guardamos uma cópia em
 * <mídia do cliente>/avatars/<contactId>.jpg e servimos por /api/avatar/:contactId.
 * `Contact.avatarUrl` guarda só o estado:
 *   "ok:<ms>"   → cópia salva naquele momento
 *   "none:<ms>" → sem foto / foto escondida na privacidade (tenta de novo depois)
 *
 * Consulta devagar (1 contato a cada ~2 s por cliente) para não chamar atenção do
 * WhatsApp: novos contatos entram numa fila na hora; os demais são atualizados por um
 * laço que passa pelos contatos com conversa nos últimos 60 dias.
 */
import path from 'node:path';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { prisma } from '../db.js';
import { emit } from '../realtime.js';
import { mediaDirOf } from '../whatsapp/media.js';
import { fetchProfilePicture, getStatus } from '../whatsapp/session.js';

const REFRESH_OK_MS = 7 * 24 * 60 * 60_000; // foto existente: confere de novo a cada 7 dias
const REFRESH_NONE_MS = 3 * 24 * 60 * 60_000; // sem foto: tenta de novo em 3 dias
const GAP_MS = 2000;

export function avatarFilePath(ws: string, contactId: string): string {
  return path.join(mediaDirOf(ws), 'avatars', `${contactId.replace(/[^a-zA-Z0-9_-]/g, '')}.jpg`);
}

function stale(avatarUrl: string | null | undefined): boolean {
  if (!avatarUrl) return true;
  const [state, ts] = avatarUrl.split(':');
  const at = Number(ts) || 0;
  return Date.now() - at > (state === 'ok' ? REFRESH_OK_MS : REFRESH_NONE_MS);
}

/** Busca e grava a foto de um contato. true = consultou (com ou sem foto). */
async function refreshOne(ws: string, contact: { id: string; waJid: string; avatarUrl: string | null }): Promise<boolean> {
  if (contact.waJid.endsWith('@g.us') || contact.waJid.endsWith('@broadcast')) return true;
  const img = await fetchProfilePicture(ws, contact.waJid);
  if (img === undefined) return false; // não deu agora: tenta no próximo ciclo
  const file = avatarFilePath(ws, contact.id);
  let avatarUrl: string;
  if (img) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, img);
    avatarUrl = `ok:${Date.now()}`;
  } else {
    await rm(file, { force: true }).catch(() => {});
    avatarUrl = `none:${Date.now()}`;
  }
  const updated = await prisma.contact.update({ where: { id: contact.id }, data: { avatarUrl } });
  if (img || contact.avatarUrl?.startsWith('ok:')) emit(ws, { type: 'contact:update', contact: updated });
  return true;
}

/* ---------------------------- fila por cliente ---------------------------- */

const queues = new Map<string, Set<string>>();
const running = new Set<string>();

/** Agenda a foto de um contato (ex.: contato novo). Não bloqueia quem chamou. */
export function queueAvatar(ws: string, contactId: string, avatarUrl?: string | null) {
  if (!stale(avatarUrl)) return;
  const q = queues.get(ws) ?? new Set<string>();
  q.add(contactId);
  queues.set(ws, q);
  void drain(ws);
}

async function drain(ws: string) {
  if (running.has(ws)) return;
  running.add(ws);
  try {
    const q = queues.get(ws);
    while (q && q.size) {
      if (getStatus(ws).status !== 'connected') break;
      const id = q.values().next().value as string;
      q.delete(id);
      const c = await prisma.contact.findUnique({ where: { id }, select: { id: true, waJid: true, avatarUrl: true, workspaceId: true } });
      if (!c || c.workspaceId !== ws || !stale(c.avatarUrl)) continue;
      await refreshOne(ws, c).catch((err) => console.warn(`[avatar:${ws}] falhou:`, (err as Error).message));
      await new Promise((r) => setTimeout(r, GAP_MS));
    }
  } finally {
    running.delete(ws);
  }
}

/* ------------------------- laço de atualização ------------------------- */

/** Contatos com conversa recente sem foto (ou com foto velha) entram na fila, 40 por vez. */
async function sweep() {
  const wss = await prisma.workspace.findMany({ where: { active: true }, select: { id: true } });
  const since = new Date(Date.now() - 60 * 24 * 60 * 60_000);
  for (const { id: ws } of wss) {
    if (getStatus(ws).status !== 'connected') continue;
    if ((queues.get(ws)?.size ?? 0) > 0) continue; // ainda drenando o lote anterior
    const contacts = await prisma.contact.findMany({
      where: { workspaceId: ws, conversations: { some: { lastMessageAt: { gte: since } } } },
      select: { id: true, avatarUrl: true },
      orderBy: { updatedAt: 'desc' },
      take: 400,
    });
    let n = 0;
    for (const c of contacts) {
      if (n >= 40) break;
      if (stale(c.avatarUrl)) {
        queueAvatar(ws, c.id, c.avatarUrl);
        n++;
      }
    }
  }
}

let started = false;
export function startAvatarLoop() {
  if (started) return;
  started = true;
  setTimeout(() => void sweep().catch(() => {}), 90_000); // depois das sessões conectarem
  setInterval(() => void sweep().catch(() => {}), 10 * 60_000);
}
