import { Router } from 'express';
import { wsOf } from '../auth.js';
import { getStatus, startWhatsApp, logoutWhatsApp } from '../whatsapp/session.js';

/** Conexão de WhatsApp do cliente aberto (cada escritório tem a sua). */
export const whatsappRouter = Router();

// Estado atual (inclui QR em data URL se estiver aguardando a leitura).
whatsappRouter.get('/status', (req, res) => {
  res.json(getStatus(wsOf(req)));
});

// Inicia a conexão (gera QR se não houver sessão salva).
whatsappRouter.post('/connect', async (req, res) => {
  await startWhatsApp(wsOf(req));
  res.json(getStatus(wsOf(req)));
});

// Desconecta e apaga as credenciais deste cliente.
whatsappRouter.post('/logout', async (req, res) => {
  await logoutWhatsApp(wsOf(req));
  res.json({ ok: true });
});
