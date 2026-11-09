import { PrismaClient } from '@prisma/client';

// Singleton do Prisma — evita abrir múltiplas conexões no hot-reload do tsx.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient; prismaTuned?: boolean };

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ log: ['warn', 'error'] });

if (!globalForPrisma.prisma) globalForPrisma.prisma = prisma;

/**
 * SQLite em produção com vários clientes falando ao mesmo tempo:
 * - WAL: leituras não bloqueiam a escrita nem vice-versa (persistente no arquivo).
 * - busy_timeout: em vez de "database is locked" na hora, espera até 5 s pela vez.
 * - synchronous=NORMAL: seguro com WAL e bem mais rápido que FULL.
 * Só para banco em arquivo; em Postgres não faz nada.
 */
export async function tuneSqlite() {
  if (globalForPrisma.prismaTuned) return;
  globalForPrisma.prismaTuned = true;
  if (!(process.env.DATABASE_URL ?? '').startsWith('file:')) return;
  try {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000');
    await prisma.$executeRawUnsafe('PRAGMA synchronous = NORMAL');
    console.log('[db] SQLite em modo WAL, busy_timeout 5 s');
  } catch (err) {
    console.warn('[db] não foi possível ajustar o SQLite:', (err as Error).message);
  }
}
