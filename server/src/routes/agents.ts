import { Router } from 'express';
import { prisma } from '../db.js';
import { resolveLlm, type ChatTurn } from '../services/llm.js';
import { wsOf } from '../auth.js';
import { logAgent, offlineReply, runAgent, type Agent } from '../services/agents.js';

export const agentsRouter = Router();

/** Campos editáveis, já validados. `faq` chega como array e é salvo em JSON. */
function toData(body: Record<string, unknown>) {
  const d: Record<string, unknown> = {};
  for (const k of ['name', 'description', 'script', 'triggers', 'regras', 'signature'] as const) {
    if (typeof body[k] === 'string') d[k] = k === 'name' ? (body[k] as string).trim() : body[k];
  }
  for (const k of ['active', 'signatureOn'] as const) if (typeof body[k] === 'boolean') d[k] = body[k];
  if (body.type !== undefined) d.type = body.type === 'triage' ? 'triage' : 'theme';
  if (body.delaySeconds !== undefined) d.delaySeconds = Math.max(1, Math.min(300, Number(body.delaySeconds) || 15));
  if (body.order !== undefined) d.order = Number(body.order) || 0;
  if (Array.isArray(body.faq)) {
    d.faq = JSON.stringify(
      body.faq
        .map((x) => ({ q: String((x as { q?: string })?.q ?? '').trim(), a: String((x as { a?: string })?.a ?? '').trim() }))
        .filter((x) => x.q),
    );
  }
  return d;
}

const LABELS: Record<string, string> = {
  name: 'nome', description: 'descrição', script: 'roteiro', triggers: 'gatilhos', regras: 'regras',
  faq: 'FAQ', signature: 'assinatura', signatureOn: 'assinatura', active: 'status', type: 'tipo',
  delaySeconds: 'delay', order: 'ordem',
};

function describeChanges(before: Record<string, unknown>, data: Record<string, unknown>) {
  const changed = Object.keys(data).filter((k) => String(before[k]) !== String(data[k]));
  const names = [...new Set(changed.map((k) => LABELS[k] ?? k))];
  return names.length ? `Editou ${names.join(', ')}` : null;
}

const out = (a: Agent & Record<string, unknown>) => {
  let faq: unknown = [];
  try {
    faq = JSON.parse((a.faq as string) || '[]');
  } catch {
    /* mantém [] */
  }
  return { ...a, faq };
};

agentsRouter.get('/', async (req, res) => {
  const agents = await prisma.agent.findMany({
    where: { workspaceId: wsOf(req) },
    orderBy: [{ type: 'asc' }, { order: 'asc' }],
  });
  const llm = await resolveLlm(wsOf(req));
  res.json({ agents: agents.map(out), providerConnected: llm.ready });
});

agentsRouter.post('/', async (req, res) => {
  const data = toData(req.body ?? {});
  if (!String(data.name ?? '').trim()) return res.status(400).json({ error: 'nome obrigatório' });
  const ws = wsOf(req);
  const count = await prisma.agent.count({ where: { workspaceId: ws } });
  const agent = await prisma.agent.create({
    data: { ...(data as { name: string }), order: count, workspaceId: ws },
  });
  await logAgent(agent.id, 'Criou o agente');
  res.json(out(agent));
});

agentsRouter.patch('/:id', async (req, res) => {
  const before = await prisma.agent.findFirst({ where: { id: req.params.id, workspaceId: wsOf(req) } });
  if (!before) return res.status(404).json({ error: 'agente não encontrado' });
  const data = toData(req.body ?? {});
  const agent = await prisma.agent.update({ where: { id: before.id }, data });
  const what = describeChanges(before as unknown as Record<string, unknown>, data);
  if (what) await logAgent(agent.id, what);
  res.json(out(agent));
});

agentsRouter.delete('/:id', async (req, res) => {
  const ws = wsOf(req);
  if (!(await prisma.agent.findFirst({ where: { id: req.params.id, workspaceId: ws } }))) {
    return res.status(404).json({ error: 'agente não encontrado' });
  }
  // Conversas conduzidas por ele ficam sem agente (voltam para a triagem/equipe).
  await prisma.conversation.updateMany({
    where: { workspaceId: ws, assignedAgentId: req.params.id },
    data: { assignedAgentId: null },
  });
  await prisma.agent.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

agentsRouter.get('/:id/history', async (req, res) => {
  if (!(await prisma.agent.findFirst({ where: { id: req.params.id, workspaceId: wsOf(req) } }))) {
    return res.status(404).json({ error: 'agente não encontrado' });
  }
  const items = await prisma.agentHistory.findMany({
    where: { agentId: req.params.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json(items);
});

/**
 * Painel "Testar": simula a conversa com o rascunho atual do agente (o corpo
 * pode trazer roteiro/regras/FAQ ainda não salvos). Nada é gravado nem enviado.
 */
agentsRouter.post('/:id/test', async (req, res) => {
  const saved = await prisma.agent.findFirst({ where: { id: req.params.id, workspaceId: wsOf(req) } });
  if (!saved) return res.status(404).json({ error: 'agente não encontrado' });
  const draft = { ...saved, ...toData(req.body?.agent ?? {}) } as Agent;
  const history: ChatTurn[] = (Array.isArray(req.body?.messages) ? req.body.messages : []).map(
    (m: { from: string; text: string }) => ({ role: m.from === 'lead' ? 'user' : 'assistant', content: String(m.text ?? '') }),
  );
  try {
    const llm = await resolveLlm(wsOf(req));
    res.json(llm.ready ? await runAgent(draft, history, llm) : offlineReply(draft, history));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

/** Copiloto: reescreve o roteiro aplicando um pedido em linguagem natural. */
agentsRouter.post('/copilot', async (req, res) => {
  const llm = await resolveLlm(wsOf(req));
  if (!llm.ready) return res.status(400).json({ error: 'Conecte um provedor de IA em Ajustes para usar o copiloto.' });
  try {
    const roteiro = await llm.complete({
      system:
        'Você ajuda a escrever roteiros de agentes de WhatsApp para escritórios de advocacia. ' +
        'Mantenha o formato do roteiro (◆ Passo N — Título, 🚩 Situação, 💬 Mensagem/Responder com, ⚡ Ação). ' +
        'Responda somente com o roteiro completo reescrito, sem comentários.',
      messages: [
        { role: 'user', content: `PEDIDO: ${String(req.body?.request ?? '')}\n\nROTEIRO ATUAL:\n${String(req.body?.script ?? '')}` },
      ],
      maxTokens: 4000,
    });
    res.json({ script: roteiro });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
