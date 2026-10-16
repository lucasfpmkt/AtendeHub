import { Router } from 'express';
import { generateReply, getAiConfig, updateAiConfig } from '../services/ai.js';
import { aiEnabled } from '../env.js';

export const aiRouter = Router();

aiRouter.get('/config', async (_req, res) => {
  const cfg = await getAiConfig();
  res.json({ ...cfg, providerConnected: aiEnabled });
});

aiRouter.patch('/config', async (req, res) => {
  const { systemPrompt, autoReply, model } = req.body ?? {};
  const cfg = await updateAiConfig({ systemPrompt, autoReply, model });
  res.json(cfg);
});

// Gera um rascunho de resposta para a conversa (não envia).
aiRouter.post('/draft/:conversationId', async (req, res) => {
  try {
    const text = await generateReply(req.params.conversationId);
    res.json({ text });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
