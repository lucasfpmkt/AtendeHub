import { prisma } from '../db.js';
import { resolveLlm } from './llm.js';
import { isQualifiedStage } from './crmSeed.js';

/** Número informado nas configurações → JID do WhatsApp (assume Brasil sem DDI). */
function jidFromNumber(raw: string): string | null {
  let d = raw.replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return d.length >= 12 ? `${d}@s.whatsapp.net` : null;
}

function formatPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const ddd = d.slice(2, 4);
    const rest = d.slice(4);
    return `+55 (${ddd}) ${rest.slice(0, rest.length - 4)}-${rest.slice(-4)}`;
  }
  return d ? `+${d}` : '—';
}

/** Para onde vai a notificação: número configurado ou o próprio número conectado. */
async function notifyTarget(ws: string, configured: string): Promise<string | null> {
  const fromCfg = jidFromNumber(configured);
  if (fromCfg) return fromCfg;
  const { ownJid } = await import('../whatsapp/session.js');
  return ownJid(ws);
}

/** Resumo curto do atendimento, feito pela IA (ou as últimas falas, sem IA). */
async function summarize(ws: string, conversationId: string): Promise<string> {
  const msgs = await prisma.message.findMany({
    where: { conversationId, author: { not: 'system' } },
    orderBy: { createdAt: 'desc' },
    take: 40,
  });
  msgs.reverse();
  const lines = msgs
    .filter((m) => m.body?.trim())
    .map((m) => `${m.direction === 'in' ? 'Lead' : 'Escritório'}: ${m.body.trim().slice(0, 500)}`);
  if (!lines.length) return 'Sem mensagens para resumir.';

  const llm = await resolveLlm(ws);
  if (llm.ready) {
    try {
      const out = await llm.complete({
        system:
          'Você resume atendimentos de WhatsApp de um escritório de advocacia para o advogado responsável. ' +
          'Escreva em português do Brasil, no máximo 5 linhas curtas, sem inventar nada: quem é o lead, ' +
          'qual o caso/pedido, os dados importantes informados (datas, tempo de trabalho, valores, documentos) ' +
          'e o próximo passo sugerido. Sem saudação, sem markdown além de quebras de linha.',
        messages: [{ role: 'user', content: lines.join('\n') }],
        maxTokens: 350,
      });
      if (out.trim()) return out.trim();
    } catch (err) {
      console.error('[notify] falha ao resumir com IA:', (err as Error).message);
    }
  }
  // Sem IA: as últimas falas do lead.
  return msgs
    .filter((m) => m.direction === 'in' && m.body?.trim())
    .slice(-3)
    .map((m) => `• ${m.body.trim().slice(0, 200)}`)
    .join('\n');
}

/** Monta o texto da notificação. */
async function buildMessage(ws: string, conversationId: string, contactId: string, stageId: string): Promise<string> {
  const [contact, stage, conv] = await Promise.all([
    prisma.contact.findUnique({ where: { id: contactId } }),
    prisma.pipelineStage.findUnique({ where: { id: stageId }, include: { funnel: true } }),
    prisma.conversation.findUnique({ where: { id: conversationId }, select: { assignedAgentId: true } }),
  ]);
  const agent = conv?.assignedAgentId
    ? await prisma.agent.findUnique({ where: { id: conv.assignedAgentId }, select: { name: true } })
    : null;
  const tags = (contact?.tags ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const summary = await summarize(ws, conversationId);

  return [
    '🔔 *Lead qualificado pela IA*',
    '',
    `👤 *Nome:* ${contact?.name?.trim() || 'Não informado'}`,
    `📱 *Telefone:* ${formatPhone(contact?.phone ?? '')}`,
    `🗂️ *Funil:* ${stage?.funnel?.name ? `${stage.funnel.name} › ` : ''}${stage?.name ?? '—'}`,
    tags.length ? `🏷️ *Etiquetas:* ${tags.join(', ')}` : '',
    agent ? `🤖 *Atendido por:* ${agent.name}` : '',
    '',
    '📝 *Resumo*',
    summary,
  ]
    .filter((l, i, arr) => l !== '' || (arr[i - 1] ?? '') !== '')
    .join('\n');
}

/**
 * Quando a IA move um lead para uma etapa de "qualificado", avisa o escritório no
 * WhatsApp (o próprio número conectado, ou o número configurado), uma única vez por
 * negócio, com os dados do lead e um resumo do atendimento.
 */
export async function notifyQualifiedLead(ws: string, conversationId: string, contactId: string, stageId: string) {
  const stage = await prisma.pipelineStage.findUnique({ where: { id: stageId }, select: { name: true } });
  if (!stage || !isQualifiedStage(stage.name)) return;

  const cfg = await prisma.aiConfig.findUnique({ where: { id: ws }, select: { notifyQualified: true, notifyNumber: true } });
  if (cfg && !cfg.notifyQualified) return;

  // Reserva o aviso antes de enviar (evita duplicar se a IA mover duas vezes).
  const deal = await prisma.deal.findFirst({ where: { workspaceId: ws, contactId, stageId }, orderBy: { updatedAt: 'desc' } });
  if (deal) {
    const claimed = await prisma.deal.updateMany({ where: { id: deal.id, qualifiedNotifiedAt: null }, data: { qualifiedNotifiedAt: new Date() } });
    if (!claimed.count) return; // já avisado
  }

  const to = await notifyTarget(ws, cfg?.notifyNumber ?? '');
  if (!to) {
    console.warn(`[notify:${ws}] lead qualificado sem destino (WhatsApp desconectado ou API Oficial sem número configurado).`);
    if (deal) await prisma.deal.update({ where: { id: deal.id }, data: { qualifiedNotifiedAt: null } }).catch(() => {});
    return;
  }

  const text = await buildMessage(ws, conversationId, contactId, stageId);
  const { sendText } = await import('../whatsapp/session.js');
  try {
    await sendText(ws, to, text);
    console.log(`[notify:${ws}] lead qualificado avisado em ${to.split('@')[0]}`);
  } catch (err) {
    console.error(`[notify:${ws}] falha ao enviar aviso:`, (err as Error).message);
    if (deal) await prisma.deal.update({ where: { id: deal.id }, data: { qualifiedNotifiedAt: null } }).catch(() => {});
  }
}

/** Envia uma notificação de exemplo (botão "Enviar teste" nas configurações). */
export async function sendTestNotification(ws: string): Promise<string> {
  const cfg = await prisma.aiConfig.findUnique({ where: { id: ws }, select: { notifyNumber: true } });
  const to = await notifyTarget(ws, cfg?.notifyNumber ?? '');
  if (!to) throw new Error('Sem destino: conecte o WhatsApp por QR ou informe um número para receber os avisos.');
  const { sendText } = await import('../whatsapp/session.js');
  await sendText(
    ws,
    to,
    [
      '🔔 *Lead qualificado pela IA* (teste)',
      '',
      '👤 *Nome:* Maria Exemplo',
      '📱 *Telefone:* +55 (11) 99999-0000',
      '🗂️ *Funil:* BPC LOAS › Lead Qualificado',
      '🤖 *Atendido por:* Agente de exemplo',
      '',
      '📝 *Resumo*',
      'Este é um aviso de teste. Quando a IA qualificar um lead, você recebe aqui os dados dele e um resumo do atendimento.',
    ].join('\n'),
  );
  return to.split('@')[0];
}
