import { prisma } from '../db.js';

const DEFAULT_STAGES = [
  { name: 'Recepção', color: '#64748b' },
  { name: 'Em análise', color: '#f59e0b' },
  { name: 'Proposta enviada', color: '#3b82f6' },
  { name: 'Fechado', color: '#16a34a' },
  { name: 'Perdido', color: '#b71312' },
];

/** Cria um funil (no cliente indicado) com um conjunto de etapas padrão. */
export async function createFunnelWithDefaults(workspaceId: string, name: string) {
  const count = await prisma.funnel.count({ where: { workspaceId } });
  const funnel = await prisma.funnel.create({
    data: { name, order: count, workspaceId },
  });
  await prisma.pipelineStage.createMany({
    data: DEFAULT_STAGES.map((s, i) => ({
      name: s.name,
      color: s.color,
      order: i,
      funnelId: funnel.id,
      workspaceId,
    })),
  });
  return funnel;
}
