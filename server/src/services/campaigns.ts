import { prisma } from '../db.js';
import { emit } from '../realtime.js';
import { getStatus, sendText, cloudOf } from '../whatsapp/session.js';
import { sendTemplateCloud, fillTemplateBody } from '../whatsapp/cloud.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Audience = { type: 'all' | 'tag' | 'stage'; value?: string };
// Disparo por template da API Oficial (obrigatório fora da janela de 24h).
export type CampaignTemplate = { name: string; lang: string; bodyText: string; params: string[] };

/** Resolve o público: conversas abertas (opcionalmente por etiqueta ou etapa). */
async function resolveTargets(ws: string, audience: Audience) {
  const conversations = await prisma.conversation.findMany({
    where: { workspaceId: ws, status: { not: 'closed' } },
    include: { contact: true },
    orderBy: { lastMessageAt: 'desc' },
  });
  const seen = new Set<string>();
  const targets: { conversationId: string; waJid: string; name: string }[] = [];
  for (const c of conversations) {
    if (seen.has(c.contactId)) continue; // uma vez por contato
    if (audience.type === 'tag') {
      const tags = (c.contact.tags ?? '').toLowerCase();
      if (!audience.value || !tags.includes(audience.value.toLowerCase())) continue;
    } else if (audience.type === 'stage') {
      if (!audience.value || c.contact.stageId !== audience.value) continue;
    }
    seen.add(c.contactId);
    targets.push({ conversationId: c.id, waJid: c.contact.waJid, name: c.contact.name || '' });
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
const runningCampaigns = new Set<string>(); // um disparo por vez por número (evita dobrar o ritmo)

export async function startCampaign(ws: string, body: string, audience: Audience, template?: CampaignTemplate) {
  if (runningCampaigns.has(ws)) throw new Error('Já existe uma campanha em andamento neste número. Aguarde ela terminar.');
  const workspace = await prisma.workspace.findUnique({ where: { id: ws }, select: { active: true, expiresAt: true } });
  const today = new Date().toISOString().slice(0, 10);
  if (!workspace?.active || (workspace.expiresAt && workspace.expiresAt < today)) {
    throw new Error('Conta inativa ou vencida — não é possível disparar campanhas.');
  }
  const targets = await resolveTargets(ws, audience);
  const label = await audienceLabel(ws, audience);
  const cloud = template ? cloudOf(ws) : undefined; // template exige a API Oficial
  if (template && !cloud) throw new Error('Templates só funcionam com a API Oficial (Meta) conectada.');
  const campaign = await prisma.campaign.create({
    data: {
      workspaceId: ws,
      body: template ? `[template: ${template.name}] ${template.bodyText}` : body,
      audience: label,
      total: targets.length,
      sent: 0,
      status: 'running',
    },
  });

  runningCampaigns.add(ws);
  void (async () => {
    let sent = 0;
    try {
    for (const t of targets) {
      if (getStatus(ws).status !== 'connected') break; // parou: WhatsApp caiu
      try {
        let waMessageId: string | undefined;
        let logBody = body;
        if (template && cloud) {
          // {nome} em qualquer parâmetro vira o nome do contato.
          const params = template.params.map((p) => p.replace(/\{nome\}/gi, t.name || 'tudo bem'));
          waMessageId = await sendTemplateCloud(cloud.phoneId, cloud.token, t.waJid, template.name, template.lang, params);
          logBody = fillTemplateBody(template.bodyText, params);
        } else {
          waMessageId = await sendText(ws, t.waJid, body);
        }
        const message = await prisma.message.create({
          data: { conversationId: t.conversationId, direction: 'out', author: 'agent', body: logBody, waMessageId },
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
    } catch (err) {
      console.error('[campanha] erro no disparo:', (err as Error).message);
      await prisma.campaign.update({ where: { id: campaign.id }, data: { sent, status: 'error' } }).catch(() => {});
    } finally {
      runningCampaigns.delete(ws);
    }
  })();

  return campaign;
}
