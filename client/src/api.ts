// ---- Token de autenticação (persistido no navegador) ----
const TOKEN_KEY = 'atendehub.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

// Notifica a aplicação quando o token expira / fica inválido (401).
type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener) {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

// Camada fina sobre fetch. Caminhos relativos (proxy do Vite cuida do resto).
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...init,
  });
  if (res.status === 401) {
    setToken(null);
    unauthorizedListeners.forEach((fn) => fn());
    throw new Error('Sessão expirada. Faça login novamente.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function login(password: string): Promise<void> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new Error('Senha incorreta');
  const { token } = (await res.json()) as { token: string };
  setToken(token);
}

export interface Contact {
  id: string;
  waJid: string;
  phone: string;
  name?: string | null;
  notes?: string | null;
  tags: string;
  stageId?: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: 'in' | 'out';
  author: 'contact' | 'agent' | 'ai';
  body: string;
  createdAt: string;
}

export interface Conversation {
  id: string;
  contact: Contact;
  status: string;
  aiEnabled: boolean;
  lastMessageAt: string;
  messages?: Message[];
}

export interface Stage {
  id: string;
  name: string;
  order: number;
  deals: { id: string; title: string; valueCents: number; contact: Contact }[];
}

export const api = {
  // WhatsApp
  waStatus: () => req<{ status: string; me?: string; qr: string | null }>('/whatsapp/status'),
  waConnect: () => req('/whatsapp/connect', { method: 'POST' }),
  waLogout: () => req('/whatsapp/logout', { method: 'POST' }),

  // Conversas / mensagens
  conversations: () => req<Conversation[]>('/conversations'),
  messages: (id: string) => req<Message[]>(`/conversations/${id}/messages`),
  send: (id: string, text: string) =>
    req<Message>(`/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  toggleAi: (id: string, aiEnabled: boolean) =>
    req<Conversation>(`/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ aiEnabled }),
    }),
  draft: (id: string) =>
    req<{ text: string }>(`/ai/draft/${id}`, { method: 'POST' }),

  // Contatos
  contacts: (q = '') => req<Contact[]>(`/contacts?q=${encodeURIComponent(q)}`),
  updateContact: (id: string, data: Partial<Contact>) =>
    req<Contact>(`/contacts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  // Pipeline
  stages: () => req<Stage[]>('/stages'),
  addStage: (name: string) =>
    req<Stage>('/stages', { method: 'POST', body: JSON.stringify({ name }) }),
  moveDeal: (id: string, stageId: string) =>
    req(`/deals/${id}`, { method: 'PATCH', body: JSON.stringify({ stageId }) }),

  // IA
  aiConfig: () =>
    req<{ systemPrompt: string; autoReply: boolean; model: string; providerConnected: boolean }>(
      '/ai/config',
    ),
  updateAiConfig: (data: { systemPrompt?: string; autoReply?: boolean }) =>
    req('/ai/config', { method: 'PATCH', body: JSON.stringify(data) }),
};
