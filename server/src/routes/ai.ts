import { Router } from 'express';
import { wsOf } from '../auth.js';
import { generateReply, getAiConfig, updateAiConfig } from '../services/ai.js';
import { providersPublic, resolveLlm, resolveCrmLlm } from '../services/llm.js';
import { reclassifyAllStages } from '../services/inbound.js';
import { sendTestNotification } from '../services/leadNotify.js';

export const aiRouter = Router();

aiRouter.get('/config', async (req, res) => {
  const ws = wsOf(req);
  const cfg = await getAiConfig(ws);
  const [llm, crmLlm] = await Promise.all([resolveLlm(ws), resolveCrmLlm(ws)]);
  // Nunca devolve as chaves cruas — só sinaliza que existem.
  const { apiKey, crmApiKey, ...safe } = cfg;
  res.json({
    ...safe,
    hasKey: Boolean(apiKey && apiKey.trim()),
    crmHasKey: Boolean(crmApiKey && crmApiKey.trim()),
    providerConnected: llm.ready,
    crmConnected: crmLlm.ready,
    providers: providersPublic(),
  });
});

aiRouter.patch('/config', async (req, res) => {
  const b = req.body ?? {};
  const cfg = await updateAiConfig(wsOf(req), b);
  const [llm, crmLlm] = await Promise.all([resolveLlm(wsOf(req)), resolveCrmLlm(wsOf(req))]);
  const { apiKey: _k, crmApiKey: _ck, ...safe } = cfg;
  res.json({
    ...safe,
    hasKey: Boolean(_k && _k.trim()),
    crmHasKey: Boolean(_ck && _ck.trim()),
    providerConnected: llm.ready,
    crmConnected: crmLlm.ready,
  });
});

// Testa a conexão fazendo uma chamada mínima. ?which=crm testa a IA do CRM.
aiRouter.post('/config/test', async (req, res) => {
  try {
    const which = req.query.which === 'crm';
    const llm = which ? await resolveCrmLlm(wsOf(req)) : await resolveLlm(wsOf(req));
    if (!llm.ready) return res.status(400).json({ ok: false, error: 'Nenhum provedor conectado. Salve a chave primeiro.' });
    const out = await llm.complete({
      system: 'Responda apenas com a palavra OK.',
      messages: [{ role: 'user', content: 'teste de conexão' }],
      maxTokens: 5,
    });
    res.json({ ok: true, provider: llm.provider, model: llm.model, sample: out.slice(0, 40) });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});

// Reavalia todas as conversas abertas e ajusta as etapas no CRM.
aiRouter.post('/reclassify-stages', async (req, res) => {
  const crmLlm = await resolveCrmLlm(wsOf(req));
  if (!crmLlm.ready) return res.status(400).json({ error: 'Conecte uma IA (ou a do CRM) antes de reavaliar.' });
  const total = await reclassifyAllStages(wsOf(req));
  res.json({ total });
});

// Gera um rascunho de resposta para a conversa (não envia).
aiRouter.post('/draft/:conversationId', async (req, res) => {
  try {
    res.json({ text: await generateReply(wsOf(req), req.params.conversationId) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Envia uma notificação de lead qualificado de exemplo para o destino configurado.
aiRouter.post('/notify-test', async (req, res) => {
  try {
    res.json({ ok: true, to: await sendTestNotification(wsOf(req)) });
  } catch (err) {
    res.status(400).json({ ok: false, error: (err as Error).message });
  }
});
