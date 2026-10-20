import { prisma } from '../db.js';
import { emit } from '../realtime.js';
import { getStatus, sendText } from '../whatsapp/session.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Audience = { type: 'all' | 'tag' | 'stage'; value?: string };

/** Resolve o público: conversas abertas (opcionalmente por etiqueta ou etapa). */
async function resolveTargets(ws: string, audience: Audience) {
  const conversations = await prisma.conversation.findMany({
    where: { workspaceId: ws, status: { not: 'closed' } },
    include: { contact: true },
    orderBy: { lastMessageAt: 'desc' },
  });
  const seen = new Set<string>();
  const targets: { conversationId: string; waJid: string }[] = [];
  for (const c of conversations) {
    if (seen.has(c.contactId)) continue; // uma vez por contato
    if (audience.type === 'tag') {
      const tags = (c.contact.tags ?? '').toLowerCase();
      if (!audience.value || !tags.includes(audience.value.toLowerCase())) continue;
    } else if (audience.type === 'stage') {
      if (!audience.value || c.contact.stageId !== audience.value) continue;
    }
    seen.add(c.contactId);
    targets.push({ conversationId: c.id, waJid: c.contact.waJid });
  }
  return targets;
}

export async function audienceLabel(ws: string, audience: Audience): Promise<string> {
  if (audience.type === 'tag') return `Etiqueta: ${audience.value}`;
  if (audience.type === 'stage') {
    const s = audience.value ? await prisma.pipelineStage.findFirst({ where: { id: audience.value, workspaceId: ws } }) : null;
    return `Etapa: ${s?.name ?? '—'}`;
  }
  return 'Todas as conversas abertas';
}

/** Cria a campanha e dispara em segundo plano com throttle (evita bloqueio). */
export async function startCampaign(ws: string, body: string, audience: Audience) {
  const targets = await resolveTargets(ws, audience);
  const label = await audienceLabel(ws, audience);
  const campaign = await prisma.campaign.create({
    data: { workspaceId: ws, body, audience: label, total: targets.length, sent: 0, status: 'running' },
  });

  void (async () => {
    let sent = 0;
    for (const t of targets) {
      if (getStatus(ws).status !== 'connected') break; // parou: WhatsApp caiu
      try {
        const waMessageId = await sendText(ws, t.waJid, body);
        const message = await prisma.message.create({
          data: { conversationId: t.conversationId, direction: 'out', author: 'agent', body, waMessageId },
        });
        await prisma.conversation.update({ where: { id: t.conversationId }, data: { lastMessageAt: new Date() } });
        emit(ws, { type: 'message:new', conversationId: t.conversationId, message });
        sent += 1;
        if (sent % 5 === 0) await prisma.campaign.update({ where: { id: campaign.id }, data: { sent } });
      } catch (err) {
        console.error('[campanha] falha ao enviar:', (err as Error).message);
      }
      // Throttle: ~1 msg a cada 4–7s para reduzir risco de bloqueio.
      await sleep(4000 + Math.floor(Math.random() * 3000));
    }
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { sent, status: getStatus(ws).status === 'connected' ? 'done' : 'error' },
    });
    emit(ws, { type: 'conversation:update', conversation: { id: 'campaign-done' } });
  })();

  return campaign;
}
