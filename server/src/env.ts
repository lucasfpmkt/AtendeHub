import 'dotenv/config';

export const env = {
  port: Number(process.env.PORT ?? 3001),
  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173',
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? '',
  aiModel: process.env.AI_MODEL ?? 'claude-haiku-5-5',
  aiSystemPrompt:
    process.env.AI_SYSTEM_PROMPT ??
    'Você é um assistente de atendimento ao cliente educado, objetivo e em português do Brasil.',

  // Autenticação (single-operator). Em produção, defina os dois.
  appPassword: process.env.APP_PASSWORD ?? 'admin',
  // Conta de administrador criada na primeira subida (vê todos os clientes).
  adminEmail: (process.env.ADMIN_EMAIL ?? 'admin').trim().toLowerCase(),
  adminPassword: process.env.ADMIN_PASSWORD ?? process.env.APP_PASSWORD ?? 'admin',
  // Nome do cliente que recebe os dados já existentes (instalação antiga).
  defaultWorkspaceName: process.env.DEFAULT_WORKSPACE_NAME ?? 'Law Mídias',
  // "0" desliga o botão "Criar conta" da tela de login.
  allowSignup: process.env.ALLOW_SIGNUP !== '0',
  appSecret: process.env.APP_SECRET ?? 'dev-secret-troque-em-producao',

  // Quando "1", o backend também serve o frontend compilado (client/dist).
  serveClient: process.env.SERVE_CLIENT === '1',
};

export const aiEnabled = Boolean(env.anthropicKey);
