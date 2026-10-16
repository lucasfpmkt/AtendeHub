import { Router } from 'express';
import {
  getStatus,
  startWhatsApp,
  logoutWhatsApp,
} from '../whatsapp/session.js';

export const whatsappRouter = Router();

// Estado atual da conexão (inclui QR em data URL se estiver aguardando scan).
whatsappRouter.get('/status', (_req, res) => {
  res.json(getStatus());
});

// Inicia a conexão (gera QR se não houver sessão salva).
whatsappRouter.post('/connect', async (_req, res) => {
  await startWhatsApp();
  res.json(getStatus());
});

// Desconecta e apaga credenciais.
whatsappRouter.post('/logout', async (_req, res) => {
  await logoutWhatsApp();
  res.json({ ok: true });
});
