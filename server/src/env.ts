import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

/**
 * Segredo que assina os tokens de login. Se APP_SECRET não for definido,
 * gera um aleatório e PERSISTE no volume (para os tokens sobreviverem a
 * restarts) — assim o sistema é seguro por padrão, sem depender de config.
 */
function resolveAppSecret(): string {
  const fromEnv = process.env.APP_SECRET?.trim();
  if (fromEnv && fromEnv !== 'dev-secret-troque-em-producao') return fromEnv;
  const base = process.env.WA_AUTH_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../auth_info');
  const file = `${base}-secret`;
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing) return existing;
  } catch {
    /* ainda não existe */
  }
  const secret = randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    console.warn('[segurança] APP_SECRET não definido — gerado e salvo em', file);
  } catch {
    console.warn('[segurança] APP_SECRET não definido e não foi possível persistir; usando um segredo em memória (logins caem no restart).');
  }
  return secret;
}

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
  appSecret: resolveAppSecret(),

  // Quando "1", o backend também serve o frontend compilado (client/dist).
  serveClient: process.env.SERVE_CLIENT === '1',

  // App do Meta (Facebook Login) — habilita o "Conectar com o Meta" (OAuth).
  // Sem isso, cai no modo manual (colar token). Um único app serve todos os
  // clientes; cada cliente apenas faz login e escolhe a conta de anúncios.
  fbAppId: process.env.FB_APP_ID?.trim() ?? '',
  fbAppSecret: process.env.FB_APP_SECRET?.trim() ?? '',
  // Versão da Graph API usada no OAuth e nas chamadas de anúncios.
  graphVersion: process.env.GRAPH_VERSION?.trim() || 'v21.0',
  // URL pública do app (para o redirect do OAuth). Se vazio, é derivado do
  // próprio request (protocolo+host), então normalmente não precisa definir.
  publicUrl: process.env.PUBLIC_URL?.trim().replace(/\/+$/, '') ?? '',

  // Google Ads (login direto / OAuth). clientId+secret são do app do LawHub
  // (um só serve todos os clientes) e o developer token é da conta MCC.
  googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() ?? '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() ?? '',
  googleAdsDeveloperToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim() ?? '',
  // ID da conta gerenciadora (MCC) — enviado como login-customer-id, se houver.
  googleLoginCustomerId: (process.env.GOOGLE_LOGIN_CUSTOMER_ID ?? '').replace(/\D/g, ''),
  // Refresh token GLOBAL da MCC: um só serve todos os clientes (só o Customer
  // ID muda por cliente). Se vazio, usa o refresh token salvo por cliente.
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN?.trim() ?? '',
  googleAdsVersion: process.env.GOOGLE_ADS_VERSION?.trim() || 'v26',
};

export const metaOauthEnabled = Boolean(env.fbAppId && env.fbAppSecret);
// OAuth do Google precisa do client do app; o developer token é exigido para
// ler dados, mas o login já funciona sem ele (o resumo é que fica pendente).
export const googleOauthEnabled = Boolean(env.googleClientId && env.googleClientSecret);

export const aiEnabled = Boolean(env.anthropicKey);
