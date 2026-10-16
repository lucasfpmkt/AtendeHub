import 'dotenv/config';

export const env = {
  port: Number(process.env.PORT ?? 3001),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
  aiModel: process.env.AI_MODEL ?? 'claude-sonnet-4-5',
  aiSystemPrompt:
    process.env.AI_SYSTEM_PROMPT ??
    'Você é um assistente de atendimento ao cliente educado, objetivo e em português do Brasil.',

  // Autenticação (single-operator). Em produção, defina os dois.
  appPassword: process.env.APP_PASSWORD ?? 'admin',
  appSecret: process.env.APP_SECRET ?? 'dev-secret-troque-em-producao',

  // Quando "1", o backend também serve o frontend compilado (client/dist).
  serveClient: process.env.SERVE_CLIENT === '1',
};

export const aiEnabled = Boolean(env.anthropicKey);
