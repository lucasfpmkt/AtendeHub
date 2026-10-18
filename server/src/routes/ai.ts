import { Router } from 'express';
import { wsOf } from '../auth.js';
import { generateReply, getAiConfig, updateAiConfig } from '../services/ai.js';
import { providersPublic, resolveLlm } from '../services/llm.js';

export const aiRouter = Router();

aiRouter.get('/config', async (req, res) => {
  const ws = wsOf(req);
  const cfg = await getAiConfig(ws);
  const llm = await resolveLlm(ws);
  // Nunca devolve a chave crua — só sinaliza que existe.
  const { apiKey, ...safe } = cfg;
  res.json({
    ...safe,
    hasKey: Boolean(apiKey && apiKey.trim()),
    providerConnected: llm.ready,
    providers: providersPublic(),
  });
});

aiRouter.patch('/config', async (req, res) => {
  const { systemPrompt, autoReply, provider, model, baseUrl, apiKey, clearKey } = req.body ?? {};
  const cfg = await updateAiConfig(wsOf(req), { systemPrompt, autoReply, provider, model, baseUrl, apiKey, clearKey });
  const llm = await resolveLlm(wsOf(req));
  const { apiKey: _k, ...safe } = cfg;
  res.json({ ...safe, hasKey: Boolean(_k && _k.trim()), providerConnected: llm.ready });
});

// Testa a conexão com o provedor fazendo uma chamada mínima.
aiRouter.post('/config/test', async (req, res) => {
  try {
    const llm = await resolveLlm(wsOf(req));
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

// Gera um rascunho de resposta para a conversa (não envia).
aiRouter.post('/draft/:conversationId', async (req, res) => {
  try {
    res.json({ text: await generateReply(wsOf(req), req.params.conversationId) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
