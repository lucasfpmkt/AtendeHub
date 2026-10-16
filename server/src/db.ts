import { PrismaClient } from '@prisma/client';

// Singleton do Prisma — evita abrir múltiplas conexões no hot-reload do tsx.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ log: ['warn', 'error'] });

if (!globalForPrisma.prisma) globalForPrisma.prisma = prisma;
