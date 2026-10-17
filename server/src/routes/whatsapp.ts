import { Router } from 'express';
import { wsOf } from '../auth.js';
import { getStatus, startWhatsApp, logoutWhatsApp, normalizePhone } from '../whatsapp/session.js';

/** Conexão de WhatsApp do cliente aberto (cada escritório tem a sua). */
export const whatsappRouter = Router();

// Estado atual (inclui QR em data URL se estiver aguardando a leitura).
whatsappRouter.get('/status', (req, res) => {
  res.json(getStatus(wsOf(req)));
});

// Inicia a conexão: QR code, ou código de pareamento se vier { phone }.
whatsappRouter.post('/connect', async (req, res) => {
  const raw = req.body?.phone;
  let phone: string | undefined;
  if (raw !== undefined && raw !== '') {
    phone = normalizePhone(String(raw)) ?? undefined;
    if (!phone) return res.status(400).json({ error: 'Número inválido. Use DDI + DDD + número, ex.: 55 21 99999-0000.' });
  }
  await startWhatsApp(wsOf(req), { phone });
  res.json(getStatus(wsOf(req)));
});

// Desconecta e apaga as credenciais deste cliente.
whatsappRouter.post('/logout', async (req, res) => {
  await logoutWhatsApp(wsOf(req));
  res.json({ ok: true });
});
