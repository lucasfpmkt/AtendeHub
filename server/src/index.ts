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
import { mediaFilePath } from './whatsapp/media.js';
import { getStatus, startSavedSessions } from './whatsapp/session.js';
import { startFollowupLoop } from './services/followup.js';
import { ensureTenancy } from './services/tenancy.js';
import { adminRouter } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { whatsappRouter } from './routes/whatsapp.js';
import { crmRouter } from './routes/crm.js';
import { aiRouter } from './routes/ai.js';
import { agentsRouter } from './routes/agents.js';
import { workRouter } from './routes/work.js';
import { campaignsRouter } from './routes/campaigns.js';
import { waWebhookRouter } from './routes/waWebhook.js';
import { adsRouter } from './routes/ads.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.set('trust proxy', true); // atrás do proxy do Easypanel (host/protocolo corretos)
app.use(cors({ origin: env.clientOrigin }));
app.use(express.json({ limit: '2mb' }));

// Webhook PÚBLICO da API Oficial do WhatsApp (a Meta chama sem token de sessão).
app.use('/api/wa/webhook', waWebhookRouter);

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
  // Content-Type explícito: os arquivos são salvos sem extensão, então o
  // sendFile marcaria tudo como octet-stream (quebra <img>/<audio>/PDF inline).
  res.setHeader('Content-Type', message.mimeType || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (message.mediaType === 'document' && message.mediaName) {
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(message.mediaName)}"`);
  }
  createReadStream(file).pipe(res);
});

// Protegido
app.use('/api/whatsapp', requireAuth, whatsappRouter);
app.use('/api', requireAuth, crmRouter);
app.use('/api/ai', requireAuth, aiRouter);
app.use('/api/agents', requireAuth, agentsRouter);
app.use('/api/campaigns', requireAuth, campaignsRouter);
app.use('/api/ads', requireAuth, adsRouter);
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
  await startSavedSessions();
  startFollowupLoop();
});
