/**
 * Cópia de segurança do banco SQLite.
 *
 * - Diária (3h30 de Brasília): `VACUUM INTO` gera um arquivo consistente mesmo com o
 *   servidor em uso (nunca copiamos o .db "vivo" com cp). Guarda os últimos 7.
 * - Antes de cada deploy: o docker-entrypoint.sh faz um `.backup` com o sqlite3 antes
 *   do `prisma db push` (guarda os últimos 10, em /data/backups/pre-deploy-*.db).
 * - Manual: POST /api/admin/backup (administrador master).
 *
 * Falha de backup avisa o administrador pelo WhatsApp.
 */
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../db.js';
import { alertAdmin } from './alerts.js';

const KEEP_DAILY = 7;

/** Caminho do arquivo do banco a partir de DATABASE_URL (file:/data/atendehub.db). */
export function dbFilePath(): string | null {
  const url = process.env.DATABASE_URL ?? '';
  if (!url.startsWith('file:')) return null;
  const p = url.slice(5).split('?')[0];
  if (!p) return null;
  // Caminho relativo: o Prisma resolve a partir da pasta do schema (server/prisma).
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), 'prisma', p);
}

export function backupDir(): string | null {
  const db = dbFilePath();
  return db ? path.join(path.dirname(db), 'backups') : null;
}

/** Gera uma cópia consistente do banco. Devolve o caminho e o tamanho. */
export async function backupNow(prefix = 'daily'): Promise<{ file: string; bytes: number }> {
  const dir = backupDir();
  if (!dir) throw new Error('DATABASE_URL não aponta para um arquivo SQLite.');
  await mkdir(dir, { recursive: true });
  // Nome com a hora de Brasília (igual ao pre-deploy do entrypoint): 2026-11-09-03-30.
  const b = brasiliaHM();
  const stamp = `${b.day}-${String(b.hour).padStart(2, '0')}-${String(b.minute).padStart(2, '0')}`;
  // Manual pode acontecer duas vezes no mesmo minuto: segundos evitam "arquivo já existe".
  const file = path.join(dir, `${prefix}-${stamp}${prefix === 'daily' ? '' : `-${String(new Date().getSeconds()).padStart(2, '0')}`}.db`);
  // VACUUM INTO não pode rodar dentro de transação; executeRawUnsafe roda solto.
  await prisma.$executeRawUnsafe(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const { size } = await stat(file);
  await prune(dir, prefix, prefix === 'daily' ? KEEP_DAILY : 10);
  console.log(`[backup] ${file} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  return { file, bytes: size };
}

/** Mantém só os N mais recentes de um prefixo. */
async function prune(dir: string, prefix: string, keep: number) {
  const files = (await readdir(dir)).filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.db')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) await unlink(path.join(dir, f)).catch(() => {});
}

/** Lista os backups existentes (para o painel do administrador). */
export async function listBackups(): Promise<{ file: string; bytes: number; at: Date }[]> {
  const dir = backupDir();
  if (!dir) return [];
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: { file: string; bytes: number; at: Date }[] = [];
  for (const f of names.filter((n) => n.endsWith('.db'))) {
    const s = await stat(path.join(dir, f)).catch(() => null);
    if (s) out.push({ file: f, bytes: s.size, at: s.mtime });
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime());
}

function brasiliaHM(): { hour: number; minute: number; day: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return { hour: Number(p.hour) % 24, minute: Number(p.minute), day: `${p.year}-${p.month}-${p.day}` };
}

let lastDay = '';
let started = false;
export function startBackupLoop() {
  if (started) return;
  started = true;
  setInterval(async () => {
    const { hour, minute, day } = brasiliaHM();
    if (hour !== 3 || minute < 30 || lastDay === day) return;
    lastDay = day;
    try {
      await backupNow('daily');
    } catch (err) {
      console.error('[backup] falhou:', (err as Error).message);
      void alertAdmin('backup_failed', `❌ O backup diário do banco falhou: ${(err as Error).message.slice(0, 200)}`);
    }
  }, 60_000);
}
