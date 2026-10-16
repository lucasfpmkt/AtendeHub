import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { Server as IOServer } from 'socket.io';
import { env } from './env.js';
import { setIO } from './realtime.js';
import { requireAuth, verifyToken } from './auth.js';
import { startWhatsApp, getStatus } from './whatsapp/session.js';
import { ensureCrmSeed } from './services/crmSeed.js';
import { authRouter } from './routes/auth.js';
import { whatsappRouter } from './routes/whatsapp.js';
import { crmRouter } from './routes/crm.js';
import { aiRouter } from './routes/ai.js';
import { agentsRouter } from './routes/agents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors({ origin: env.clientOrigin }));
app.use(express.json({ limit: '2mb' }));

// Público
app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRouter);

// Protegido
app.use('/api/whatsapp', requireAuth, whatsappRouter);
app.use('/api', requireAuth, crmRouter);
app.use('/api/ai', requireAuth, aiRouter);
app.use('/api/agents', requireAuth, agentsRouter);

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

// Socket.io só aceita conexões com token válido.
io.use((socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  if (verifyToken(token)) return next();
  next(new Error('não autenticado'));
});

io.on('connection', (socket) => {
  socket.emit('wa:status', { type: 'wa:status', ...getStatus() });
});

server.listen(env.port, async () => {
  console.log(`\n  LawHub API  →  http://localhost:${env.port}`);
  if (env.serveClient) console.log('  Servindo frontend compilado (client/dist)');
  console.log('');
  await ensureCrmSeed();
  void startWhatsApp();
});
