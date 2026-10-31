import { Router } from 'express';
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { prisma } from '../db.js';
import { wsOf } from '../auth.js';
import { dec } from '../crypto.js';
import { env, metaOauthEnabled } from '../env.js';
import {
  encPageToken,
  handleLeadgenEvent,
  ingestLead,
  leadConfigOf,
  leadFromPayload,
  listPages,
  pullLeads,
  subscribePage,
  tokenReadyForLeads,
  validSignature,
  webhookVerifyToken,
} from '../services/leadForms.js';

const baseUrl = (req: Request) => env.publicUrl || `${req.protocol}://${req.get('host')}`;

/* ------------------------- Autenticado: /api/leadforms ------------------- */
export const leadFormsRouter = Router();

/** Token usado para os formulários: o colado aqui ou o da conexão de anúncios. */
async function userToken(ws: string) {
  const lf = await prisma.leadFormConfig.findUnique({ where: { id: ws }, select: { userToken: true } });
  if (lf?.userToken) return dec(lf.userToken);
  const meta = await prisma.metaConfig.findUnique({ where: { id: ws } });
  return meta?.token ? dec(meta.token) : '';
}

leadFormsRouter.get('/config', async (req, res) => {
  const ws = wsOf(req);
  const cfg = await leadConfigOf(ws);
  const meta = await prisma.metaConfig.findUnique({ where: { id: ws } });
  const token = await userToken(ws);
  const funnels = await prisma.funnel.findMany({
    where: { workspaceId: ws },
    orderBy: { order: 'asc' },
    select: { id: true, name: true, stages: { orderBy: { order: 'asc' }, select: { id: true, name: true } } },
  });
  const entries = await prisma.leadFormEntry.findMany({ where: { workspaceId: ws }, orderBy: { createdAt: 'desc' }, take: 15 });
  res.json({
    enabled: cfg.enabled,
    pageId: cfg.pageId,
    pageName: cfg.pageName,
    funnelId: cfg.funnelId,
    stageId: cfg.stageId,
    notify: cfg.notify,
    lastPollAt: cfg.lastPollAt,
    lastError: cfg.lastError,
    metaConnected: Boolean(token),
    metaName: meta?.connectedName ?? '',
    oauthAvailable: metaOauthEnabled,
    manualToken: Boolean(cfg.userToken),
    instantAvailable: Boolean(env.fbAppSecret),
    scopesOk: token ? await tokenReadyForLeads(token) : false,
    hookUrl: `${baseUrl(req)}/api/leads/in/${cfg.hookKey}`,
    webhookUrl: `${baseUrl(req)}/api/meta/leadgen`,
    verifyToken: webhookVerifyToken(),
    funnels,
    entries: entries.map((e) => ({
      id: e.id,
      source: e.source,
      name: e.name,
      phone: e.phone,
      email: e.email,
      formName: e.formName,
      campaign: e.campaign,
      answers: (() => {
        try {
          return JSON.parse(e.answers);
        } catch {
          return [];
        }
      })(),
      createdAt: e.createdAt,
    })),
  });
});

leadFormsRouter.get('/pages', async (req, res) => {
  const token = await userToken(wsOf(req));
  if (!token) return res.json({ pages: [] });
  try {
    const pages = await listPages(token);
    res.json({ pages: pages.map(({ id, name }) => ({ id, name })) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

leadFormsRouter.patch('/config', async (req, res) => {
  const ws = wsOf(req);
  const cfg = await leadConfigOf(ws);
  const b = req.body ?? {};
  const data: Record<string, unknown> = {};
  let warning = '';

  // Token colado à mão (sem o login do Meta): valida antes de salvar.
  if (typeof b.userToken === 'string') {
    const t = b.userToken.trim();
    if (!t) data.userToken = '';
    else {
      try {
        const pages = await listPages(t);
        if (!pages.length) return res.status(400).json({ error: 'Esse token não tem acesso a nenhuma página. Atribua a página ao usuário do sistema e gere o token de novo.' });
      } catch (err) {
        return res.status(400).json({ error: `O Meta recusou o token: ${(err as Error).message}` });
      }
      data.userToken = encPageToken(t);
    }
    await prisma.leadFormConfig.update({ where: { id: ws }, data });
    return res.json({ ok: true, warning: '' });
  }

  if (typeof b.pageId === 'string' && b.pageId && b.pageId !== cfg.pageId) {
    const token = await userToken(ws);
    if (!token) return res.status(400).json({ error: 'Conecte o Meta primeiro (botão "Conectar com o Meta").' });
    let pages: { id: string; name: string; token: string }[];
    try {
      pages = await listPages(token);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }
    const page = pages.find((p) => p.id === b.pageId);
    if (!page?.token) return res.status(400).json({ error: 'Página não encontrada nesta conta do Meta.' });
    data.pageId = page.id;
    data.pageName = page.name;
    data.pageToken = encPageToken(page.token);
    data.lastPollAt = null;
    try {
      await subscribePage(page.id, page.token);
    } catch (err) {
      warning = `Página salva, mas o Meta não liberou o aviso instantâneo: ${(err as Error).message}. Os leads ainda chegam pela busca automática a cada 10 minutos.`;
    }
  }
  if (typeof b.funnelId === 'string') {
    const ok = !b.funnelId || (await prisma.funnel.findFirst({ where: { id: b.funnelId, workspaceId: ws } }));
    if (ok) data.funnelId = b.funnelId;
  }
  if (typeof b.stageId === 'string') {
    const ok = !b.stageId || (await prisma.pipelineStage.findFirst({ where: { id: b.stageId, workspaceId: ws } }));
    if (ok) data.stageId = b.stageId;
  }
  if (typeof b.notify === 'boolean') data.notify = b.notify;
  if (typeof b.enabled === 'boolean') data.enabled = b.enabled;

  await prisma.leadFormConfig.update({ where: { id: ws }, data });
  res.json({ ok: true, warning });
});

// Busca os leads dos últimos 7 dias agora (também importa os que chegaram antes de ligar).
leadFormsRouter.post('/sync', async (req, res) => {
  try {
    res.json(await pullLeads(wsOf(req), new Date(Date.now() - 7 * 24 * 60 * 60_000)));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Gera um novo endereço de entrada (o anterior para de funcionar).
leadFormsRouter.post('/rotate-key', async (req, res) => {
  const ws = wsOf(req);
  await leadConfigOf(ws);
  const cfg = await prisma.leadFormConfig.update({ where: { id: ws }, data: { hookKey: randomBytes(18).toString('hex') } });
  res.json({ hookUrl: `${baseUrl(req)}/api/leads/in/${cfg.hookKey}` });
});

/* ---------------- PÚBLICO: webhook do Meta (/api/meta/leadgen) ----------- */
// Montado com express.raw (precisa do corpo cru para conferir a assinatura).
export const leadgenWebhookRouter = Router();

leadgenWebhookRouter.get('/', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === webhookVerifyToken()) {
    return res.status(200).send(String(req.query['hub.challenge'] ?? ''));
  }
  res.sendStatus(403);
});

leadgenWebhookRouter.post('/', (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  if (!validSignature(raw, req.get('x-hub-signature-256') ?? undefined)) return res.sendStatus(401);
  res.sendStatus(200); // responde rápido; processa depois
  let body: any;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return;
  }
  if (body?.object !== 'page') return;
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'leadgen') continue;
      const v = change.value ?? {};
      if (!v.leadgen_id || !v.page_id) continue;
      handleLeadgenEvent(String(v.page_id), String(v.leadgen_id), v.form_id ? String(v.form_id) : undefined).catch((e) =>
        console.error('[leadgen] falhou:', e.message),
      );
    }
  }
});

/* ------------- PÚBLICO: entrada externa (/api/leads/in/:key) ------------- */
export const leadInRouter = Router();

leadInRouter.post('/:key', async (req, res) => {
  const key = String(req.params.key ?? '');
  if (key.length < 20) return res.status(404).json({ error: 'Endereço inválido.' });
  const cfg = await prisma.leadFormConfig.findFirst({ where: { hookKey: key } });
  if (!cfg) return res.status(404).json({ error: 'Endereço inválido.' });
  const lead = leadFromPayload(req.body ?? {});
  if (!lead.phone && !lead.email && !lead.name) {
    return res.status(400).json({ error: 'Envie ao menos nome, telefone ou e-mail do lead.' });
  }
  try {
    const r = await ingestLead(cfg.id, lead);
    res.json({ ok: true, duplicate: !r.created });
  } catch (err) {
    console.error(`[leads-in:${cfg.id}] falhou:`, (err as Error).message);
    res.status(500).json({ error: 'Não foi possível registrar o lead.' });
  }
});
