import { prisma } from '../db.js';

// Funil padrão de um escritório de advocacia (todo cliente novo já vem com ele).
const DEFAULT_STAGES = [
  { name: 'Recepção', color: '#64748b' },
  { name: 'Análise de Viabilidade', color: '#f59e0b' },
  { name: 'Oferta do Contrato', color: '#3b82f6' },
  { name: 'Enviou Contrato', color: '#eab308' },
  { name: 'Contrato Assinado', color: '#16a34a' },
  { name: 'Aguardando Agendamento', color: '#6366f1' },
  { name: 'Agendamento Feito', color: '#14b8a6' },
  { name: 'Desqualificado', color: '#dc2626' },
  { name: 'Não Tem Interesse', color: '#9ca3af' },
  { name: 'Já é Cliente do Escritório', color: '#a855f7' },
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
      autoTag: s.name, // já nasce com a etiqueta automática = nome da etapa
    })),
  });
  // Garante a etiqueta no catálogo, na cor da etapa.
  for (const s of DEFAULT_STAGES) {
    await prisma.tag.create({ data: { workspaceId, name: s.name, color: s.color } }).catch(() => {});
  }
  return funnel;
}
