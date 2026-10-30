import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { Server as IOServer } from 'socket.io';
import { env } from './env.js';
import { setIO, roomOf } from './realtime.js';
import { existsSync, createReadStream } from 'node:fs';
import { accessStillValid, requireAuth, requireAdmin, verifyToken } from './auth.js';
import { prisma } from './db.js';
import { forceHttps, rateLimit, securityHeaders } from './security.js';
import { mediaFilePath, safeMediaHeaders } from './whatsapp/media.js';
import { getStatus, startSavedSessions } from './whatsapp/session.js';
import { startFollowupLoop } from './services/followup.js';
import { startAdsInsightsLoop } from './services/adsInsights.js';
import { startAttendanceLoop } from './services/attendance.js';
import { attendanceRouter } from './routes/attendance.js';
import { backfillStageTags } from './services/inbound.js';
import { ensureTenancy } from './services/tenancy.js';
import { ensureQualifiedStageInAllFunnels } from './services/crmSeed.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { whatsappRouter } from './routes/whatsapp.js';
import { crmRouter } from './routes/crm.js';
import { aiRouter } from './routes/ai.js';
import { agentsRouter } from './routes/agents.js';
import { workRouter } from './routes/work.js';
import { campaignsRouter } from './routes/campaigns.js';
import { waWebhookRouter } from './routes/waWebhook.js';
import { adsRouter, metaOauthRouter, googleOauthRouter } from './routes/ads.js';
import { leadFormsRouter, leadgenWebhookRouter, leadInRouter } from './routes/leadForms.js';
import { startLeadFormsLoop } from './services/leadForms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
// Confia SÓ no proxy do Easypanel (1 salto). Com `true`, qualquer um forjava o IP
// pelo cabeçalho X-Forwarded-For e burlava o limite por IP.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(forceHttps);
app.use(securityHeaders);
app.use(cors({ origin: env.clientOrigin }));
// Webhook PÚBLICO dos formulários do Meta: precisa do corpo cru (assinatura),
// por isso vem antes do express.json.
app.use('/api/meta/leadgen', express.raw({ type: '*/*', limit: '1mb' }), leadgenWebhookRouter);
app.use(express.json({ limit: '2mb' }));

// Webhook PÚBLICO da API Oficial do WhatsApp (a Meta chama sem token de sessão).
app.use('/api/wa/webhook', waWebhookRouter);
// Retorno PÚBLICO do login com o Meta/Google (OAuth) — redireciona sem sessão.
app.use('/api/ads/meta/callback', metaOauthRouter);
app.use('/api/ads/google/callback', googleOauthRouter);

// Limites por IP (o webhook da Meta, acima, fica de fora: ela manda rajadas).
app.use(
  '/api/auth/login',
  rateLimit({ name: 'login', windowMs: 15 * 60_000, max: 20, message: 'Muitas tentativas de login. Tente de novo em alguns minutos.' }),
);
app.use('/api/auth/signup', rateLimit({ name: 'signup', windowMs: 60 * 60_000, max: 10 }));
app.use('/api/auth/password', rateLimit({ name: 'senha', windowMs: 15 * 60_000, max: 10 }));
const sendLimit = rateLimit({ name: 'envio', windowMs: 60_000, max: 120, message: 'Muitos envios em sequência. Aguarde um minuto.' });
app.use('/api/whatsapp/send-media', sendLimit);
app.use('/api/conversations', (req, res, next) => (req.method === 'POST' && /\/messages\/?$/.test(req.path) ? sendLimit(req, res, next) : next()));
app.use('/api', rateLimit({ name: 'api', windowMs: 60_000, max: 900 }));
// Entrada PÚBLICA de leads (Zapier/Make/site), protegida pela chave na URL.
app.use(
  '/api/leads/in',
  rateLimit({ name: 'leads-in', windowMs: 60_000, max: 60 }),
  express.urlencoded({ extended: true, limit: '1mb' }),
  leadInRouter,
);

// Público
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);

// Mídia das conversas: autenticada por token na query (para <img>/<audio> src).
app.get('/api/media/:id', async (req, res) => {
  const token = (req.query.token as string) || (req.headers.authorization?.replace('Bearer ', '') ?? '');
  const info = verifyToken(token);
  if (!info) return res.status(401).end();
  const message = await prisma.message.findFirst({
    where: { mediaId: req.params.id, conversation: { workspaceId: info.ws } },
    select: { mimeType: true, mediaName: true, mediaType: true },
  });
  if (!message) return res.status(404).end();
  const file = mediaFilePath(info.ws, req.params.id);
  if (!existsSync(file)) return res.status(404).end();
  // Só imagem/áudio/vídeo/PDF abrem no navegador; o resto (HTML, SVG, scripts…)
  // baixa como arquivo — um "documento" recebido não pode rodar código no LawHub.
  safeMediaHeaders(res, message.mimeType, message.mediaName);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  createReadStream(file).pipe(res);
});

// Protegido
app.use('/api/whatsapp', requireAuth, whatsappRouter);
app.use('/api', requireAuth, crmRouter);
app.use('/api/ai', requireAuth, aiRouter);
app.use('/api/agents', requireAuth, agentsRouter);
app.use('/api/campaigns', requireAuth, campaignsRouter);
app.use('/api/ads', requireAuth, adsRouter);
app.use('/api/attendance', requireAuth, attendanceRouter);
app.use('/api/leadforms', requireAuth, leadFormsRouter);
app.use('/api/admin', requireAuth, requireAdmin, adminRouter);
app.use('/api', requireAuth, workRouter);

// Em produção, serve o frontend compilado (SPA) a partir de client/dist.
if (env.serveClient) {
  const clientDir = path.resolve(__dirname, '../../client/dist');
  app.use(express.static(clientDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
      return next();
    }
    res.sendFile(path.join(clientDir, 'index.html'));
  });
}

const server = http.createServer(app);
const io = new IOServer(server, {
  cors: { origin: env.serveClient ? true : env.clientOrigin },
});
setIO(io);

// Socket.io só aceita conexões com token válido; cada conexão entra na sala
// do cliente (workspace) do token, então só recebe eventos dele.
io.use(async (socket, next) => {
  const info = verifyToken(socket.handshake.auth?.token as string | undefined);
  if (!info || !(await accessStillValid(info).catch(() => false))) return next(new Error('não autenticado'));
  socket.data.ws = info.ws;
  next();
});

io.on('connection', (socket) => {
  const ws = socket.data.ws as string;
  socket.join(roomOf(ws));
  socket.emit('wa:status', { type: 'wa:status', ...getStatus(ws) });
});

server.listen(env.port, async () => {
  console.log(`\n  LawHub API  →  http://localhost:${env.port}`);
  if (env.serveClient) console.log('  Servindo frontend compilado (client/dist)');
  console.log('');
  await ensureTenancy();
  await ensureQualifiedStageInAllFunnels().catch((e) => console.error('[crm] ensure Lead Qualificado falhou:', e));
  await backfillStageTags().catch((e) => console.error('[crm] backfill de etiquetas falhou:', e));
  if (env.adminPassword === 'admin') {
    console.warn('[segurança] Senha de admin padrão ("admin") em uso. Defina ADMIN_PASSWORD no ambiente e troque a senha.');
  }
  if (env.allowSignup) {
    console.warn('[segurança] Criação de conta pública está LIGADA. Defina ALLOW_SIGNUP=0 se o cadastro deve ser só pelo admin.');
  }
  await startSavedSessions();
  startFollowupLoop();
  startAdsInsightsLoop(); // análise de campanhas: segunda e quarta, 8h
  startAttendanceLoop(); // análise de atendimento: diária, 19h
  startLeadFormsLoop(); // formulários do Meta: busca de segurança a cada 10 min
});
