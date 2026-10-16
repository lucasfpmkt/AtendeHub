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

export interface Funnel {
  id: string;
  name: string;
  order: number;
}

export interface Deal {
  id: string;
  title: string;
  valueCents: number;
  source?: string | null;
  responsavel?: string | null;
  tags: string;
  stageId?: string | null;
  funnelId?: string | null;
  contact?: Contact | null;
  createdAt: string;
}

export interface Stage {
  id: string;
  name: string;
  color: string;
  order: number;
  deals: Deal[];
}

export interface Board {
  funnel: Funnel;
  stages: Stage[];
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface Agent {
  id: string;
  name: string;
  type: 'triage' | 'theme';
  description: string;
  script: string;
  triggers: string;
  active: boolean;
  delaySeconds: number;
  order?: number;
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

  // Funis
  funnels: () => req<Funnel[]>('/funnels'),
  addFunnel: (name: string) =>
    req<Funnel>('/funnels', { method: 'POST', body: JSON.stringify({ name }) }),
  renameFunnel: (id: string, name: string) =>
    req<Funnel>(`/funnels/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteFunnel: (id: string) => req(`/funnels/${id}`, { method: 'DELETE' }),
  board: (funnelId: string) => req<Board>(`/funnels/${funnelId}/board`),
  exportFunnel: async (funnelId: string): Promise<Blob> => {
    const token = getToken();
    const res = await fetch(`/api/funnels/${funnelId}/export`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error('falha ao exportar');
    return res.blob();
  },

  // Etapas
  addStage: (funnelId: string, name: string, color: string) =>
    req<Stage>(`/funnels/${funnelId}/stages`, {
      method: 'POST',
      body: JSON.stringify({ name, color }),
    }),
  updateStage: (id: string, data: { name?: string; color?: string; order?: number }) =>
    req<Stage>(`/stages/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteStage: (id: string) => req(`/stages/${id}`, { method: 'DELETE' }),

  // Negócios
  addDeal: (data: Partial<Deal> & { funnelId: string }) =>
    req<Deal>('/deals', { method: 'POST', body: JSON.stringify(data) }),
  updateDeal: (id: string, data: Partial<Deal>) =>
    req<Deal>(`/deals/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteDeal: (id: string) => req(`/deals/${id}`, { method: 'DELETE' }),

  // Etiquetas
  tags: () => req<Tag[]>('/tags'),
  addTag: (name: string, color: string) =>
    req<Tag>('/tags', { method: 'POST', body: JSON.stringify({ name, color }) }),

  // Agentes
  agents: () => req<{ agents: Agent[]; providerConnected: boolean }>('/agents'),
  addAgent: (data: Partial<Agent>) =>
    req<Agent>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (id: string, data: Partial<Agent>) =>
    req<Agent>(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAgent: (id: string) => req(`/agents/${id}`, { method: 'DELETE' }),

  // IA
  aiConfig: () =>
    req<{ systemPrompt: string; autoReply: boolean; model: string; providerConnected: boolean }>(
      '/ai/config',
    ),
  updateAiConfig: (data: { systemPrompt?: string; autoReply?: boolean }) =>
    req('/ai/config', { method: 'PATCH', body: JSON.stringify(data) }),
};
