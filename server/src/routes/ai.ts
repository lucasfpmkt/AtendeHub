import { Router } from 'express';
import { wsOf } from '../auth.js';
import { generateReply, getAiConfig, updateAiConfig } from '../services/ai.js';
import { aiEnabled } from '../env.js';

export const aiRouter = Router();

aiRouter.get('/config', async (req, res) => {
  const cfg = await getAiConfig(wsOf(req));
  res.json({ ...cfg, providerConnected: aiEnabled });
});

aiRouter.patch('/config', async (req, res) => {
  const { systemPrompt, autoReply } = req.body ?? {};
  res.json(await updateAiConfig(wsOf(req), { systemPrompt, autoReply }));
});

// Gera um rascunho de resposta para a conversa (não envia).
aiRouter.post('/draft/:conversationId', async (req, res) => {
  try {
    res.json({ text: await generateReply(wsOf(req), req.params.conversationId) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
