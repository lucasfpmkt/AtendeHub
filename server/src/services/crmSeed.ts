import { prisma } from '../db.js';

// Funil padrão de um escritório de advocacia (todo cliente novo já vem com ele).
const DEFAULT_STAGES = [
  { name: 'Recepção', color: '#64748b' },
  { name: 'Análise de Viabilidade', color: '#f59e0b' },
  { name: 'Lead Qualificado', color: '#22c55e' },
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

const norm = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
// "Lead Qualificado", "Qualificado", etc. — mas NÃO "Desqualificado".
const isQualifiedStage = (name: string) => {
  const n = norm(name);
  return n.includes('qualificad') && !n.includes('desqualific');
};

/**
 * Garante que todo funil tenha uma etapa "Lead Qualificado". Se o funil já tem
 * qualquer etapa de qualificado, não mexe. Senão, insere "Lead Qualificado"
 * logo após "Análise de Viabilidade" (ou após a 1ª etapa), ajustando a ordem.
 */
export async function ensureQualifiedStageInAllFunnels() {
  const funnels = await prisma.funnel.findMany({ select: { id: true, workspaceId: true } });
  let added = 0;
  for (const f of funnels) {
    const stages = await prisma.pipelineStage.findMany({ where: { funnelId: f.id }, orderBy: { order: 'asc' } });
    if (stages.some((s) => isQualifiedStage(s.name))) continue;

    const anchor = stages.find((s) => norm(s.name).includes('analise de viabilidade'));
    const pos = anchor ? anchor.order + 1 : stages.length ? stages[0].order + 1 : 0;

    // Abre espaço: empurra as etapas a partir de "pos" uma posição pra frente.
    await prisma.pipelineStage.updateMany({ where: { funnelId: f.id, order: { gte: pos } }, data: { order: { increment: 1 } } }).catch(() => {});
    await prisma.pipelineStage
      .create({ data: { name: 'Lead Qualificado', color: '#22c55e', order: pos, funnelId: f.id, workspaceId: f.workspaceId, autoTag: 'Lead Qualificado' } })
      .catch(() => {});
    await prisma.tag.create({ data: { workspaceId: f.workspaceId, name: 'Lead Qualificado', color: '#22c55e' } }).catch(() => {});
    added++;
  }
  if (added) console.log(`[crm] etapa "Lead Qualificado" adicionada em ${added} funil(is).`);
}
