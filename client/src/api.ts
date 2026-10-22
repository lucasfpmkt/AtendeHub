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

export type Role = 'admin' | 'user';
export interface AiProvider {
  id: string;
  label: string;
  kind: 'anthropic' | 'openai';
  baseUrl: string;
  defaultModel: string;
  models: string[];
  keyHint: string;
  keyUrl: string;
}
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  isMaster?: boolean;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  isMaster: boolean;
  lastLoginAt: string | null;
  workspaceIds: string[];
}
export interface WorkspaceInfo {
  id: string;
  code: number;
  name: string;
  plan: string;
  expiresAt: string | null;
  active: boolean;
}
export interface AdminWorkspace extends WorkspaceInfo {
  createdAt: string;
  users: { id: string; name: string; email: string; role: Role; lastLoginAt: string | null }[];
  whatsapp: string;
  contacts: number;
  openConversations: number;
  agents: number;
}
type AuthResult = { token: string; user: SessionUser; workspace: WorkspaceInfo };

async function postPublic<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export async function login(email: string, password: string): Promise<AuthResult> {
  const r = await postPublic<AuthResult>('/auth/login', { email, password });
  setToken(r.token);
  return r;
}

export async function signup(data: { name: string; company: string; email: string; password: string }): Promise<AuthResult> {
  const r = await postPublic<AuthResult>('/auth/signup', data);
  setToken(r.token);
  return r;
}

export async function authOptions(): Promise<{ allowSignup: boolean }> {
  const res = await fetch('/api/auth/options');
  return res.ok ? res.json() : { allowSignup: false };
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
  author: 'contact' | 'agent' | 'ai' | 'system';
  body: string;
  mediaType?: 'image' | 'video' | 'audio' | 'document' | 'sticker' | null;
  mediaId?: string | null;
  mediaName?: string | null;
  mimeType?: string | null;
  createdAt: string;
}

export interface Conversation {
  id: string;
  contact: Contact;
  status: string;
  aiEnabled: boolean;
  assignedAgentId?: string | null;
  unread: number;
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
  agentName?: string | null;
  createdAt: string;
}

export interface Stage {
  id: string;
  name: string;
  color: string;
  order: number;
  followupMinutes: number;
  followupMessage: string;
  autoTag: string;
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

export interface MetaAdMetrics {
  id: string;
  name: string;
  status?: string;
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  cpc: number;
  ctr: number;
}
export interface MetaAdNode extends MetaAdMetrics {
  adsets?: (MetaAdMetrics & { ads?: MetaAdMetrics[] })[];
}

export interface Agent {
  id: string;
  name: string;
  type: 'triage' | 'theme';
  description: string;
  script: string;
  triggers: string;
  funnelId?: string | null;
  regras: string;
  faq: FaqItem[];
  signatureOn: boolean;
  signature: string;
  active: boolean;
  delaySeconds: number;
  order?: number;
}

export interface FaqItem {
  q: string;
  a: string;
}

export interface AgentHistoryItem {
  id: string;
  action: string;
  createdAt: string;
}

export type AgentAction = { type: 'transfer'; agentName: string } | { type: 'deactivate' } | null;

export interface Task {
  id: string;
  title: string;
  status: 'todo' | 'doing' | 'done';
  priority: 'Alta' | 'Média' | 'Baixa';
  responsavel?: string | null;
  dueDate?: string | null;
}

export interface CalEvent {
  id: string;
  title: string;
  date: string;
  start: string;
  end: string;
  kind: 'meet' | 'int';
  notes?: string | null;
}

export interface QuickReply {
  id: string;
  shortcut: string;
  text: string;
}

export interface KeywordRule {
  id: string;
  keyword: string;
  reply: string;
  active: boolean;
}

export interface DashboardData {
  perDay: { date: string; count: number }[];
  messages: { in: number; out: number };
  whatsappConversations: number;
  metaResults: number | null;
  googleResults: number | null;
  firstResponseMin: number | null;
  bySource: { source: string; count: number }[];
  conversion: { won: number; total: number; rate: number };
  totals: {
    newContacts: number;
    openConversations: number;
    aiConversations: number;
    unread: number;
    tasksOpen: number;
    deals: number;
    pipelineCents: number;
  };
  agents: { id: string; name: string; active: boolean; type: string; conversations: number }[];
  funnels: { id: string; name: string; stages: { id: string; name: string; color: string; deals: number }[] }[];
}

export const api = {
  // WhatsApp
  waStatus: () =>
    req<{ status: string; me?: string; qr: string | null; pairCode: string | null }>('/whatsapp/status'),
  waConnect: (phone?: string) =>
    req<{ status: string; qr: string | null; pairCode: string | null }>('/whatsapp/connect', {
      method: 'POST',
      body: JSON.stringify(phone ? { phone } : {}),
    }),
  waReconnect: () =>
    req<{ status: string; qr: string | null; pairCode: string | null }>('/whatsapp/reconnect', { method: 'POST' }),
  waLogout: () => req('/whatsapp/logout', { method: 'POST' }),
  waCloud: () =>
    req<{ channel: string; phoneId: string; wabaId: string; hasToken: boolean; verifyToken: string; webhookUrl: string }>(
      '/whatsapp/cloud',
    ),
  waCloudSave: (data: { channel?: 'qr' | 'cloud'; phoneId?: string; token?: string; wabaId?: string }) =>
    req<{ ok: boolean }>('/whatsapp/cloud', { method: 'PATCH', body: JSON.stringify(data) }),

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
  setConversation: (id: string, data: { status?: string; assignedAgentId?: string | null; aiEnabled?: boolean }) =>
    req<Conversation>(`/conversations/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  markRead: (id: string) => req(`/conversations/${id}/read`, { method: 'POST' }),
  draft: (id: string) =>
    req<{ text: string }>(`/ai/draft/${id}`, { method: 'POST' }),

  // Mídia nas conversas
  sendMedia: async (conversationId: string, file: File, caption = '') => {
    const token = getToken();
    const qs = new URLSearchParams({ mime: file.type || 'application/octet-stream', name: file.name, caption });
    const res = await fetch(`/api/whatsapp/send-media/${conversationId}?${qs.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: file,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Falha ao enviar arquivo');
    return (await res.json()) as Message;
  },
  mediaUrl: (mediaId: string) => `/api/media/${mediaId}?token=${encodeURIComponent(getToken() ?? '')}`,

  // Mensagens agendadas (lembretes)
  schedules: (conversationId: string) =>
    req<{ id: string; body: string; sendAt: string; sent: boolean }[]>(`/conversations/${conversationId}/schedules`),
  schedule: (conversationId: string, body: string, sendAt: string) =>
    req(`/conversations/${conversationId}/schedules`, { method: 'POST', body: JSON.stringify({ body, sendAt }) }),
  cancelSchedule: (id: string) => req(`/schedules/${id}`, { method: 'DELETE' }),

  // Campanhas (disparo em massa)
  campaigns: () =>
    req<{ id: string; body: string; audience: string; total: number; sent: number; status: string; createdAt: string }[]>('/campaigns'),
  startCampaign: (
    body: string,
    audienceType: 'all' | 'tag' | 'stage',
    value?: string,
    template?: { name: string; lang: string; bodyText: string; params: string[] },
  ) => req<{ id: string; total: number }>('/campaigns', { method: 'POST', body: JSON.stringify({ body, audienceType, value, template }) }),
  waTemplates: () =>
    req<{ name: string; language: string; bodyText: string; variables: number }[]>('/whatsapp/cloud/templates'),

  // Contatos
  contacts: (q = '') => req<Contact[]>(`/contacts?q=${encodeURIComponent(q)}`),
  updateContact: (id: string, data: Partial<Contact>) =>
    req<Contact>(`/contacts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  exportContact: async (id: string): Promise<Blob> => {
    const token = getToken();
    const res = await fetch(`/api/contacts/${id}/export`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error('falha ao exportar');
    return res.blob();
  },
  eraseContact: (id: string) => req(`/contacts/${id}/erase`, { method: 'DELETE' }),

  // Funis
  funnels: () => req<Funnel[]>('/funnels'),
  addFunnel: (name: string) =>
    req<Funnel>('/funnels', { method: 'POST', body: JSON.stringify({ name }) }),
  renameFunnel: (id: string, name: string) =>
    req<Funnel>(`/funnels/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteFunnel: (id: string) => req(`/funnels/${id}`, { method: 'DELETE' }),
  board: (funnelId: string) => req<Board>(`/funnels/${funnelId}/board`),
  stages: () => req<{ id: string; name: string; color: string; funnelId: string; funnelName: string }[]>('/stages'),
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
  updateStage: (
    id: string,
    data: { name?: string; color?: string; order?: number; followupMinutes?: number; followupMessage?: string; autoTag?: string },
  ) => req<Stage>(`/stages/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
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
  updateTag: (id: string, data: { name?: string; color?: string }) =>
    req<Tag>(`/tags/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteTag: (id: string) => req(`/tags/${id}`, { method: 'DELETE' }),

  // Agentes
  agents: () => req<{ agents: Agent[]; providerConnected: boolean }>('/agents'),
  addAgent: (data: Partial<Agent>) =>
    req<Agent>('/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (id: string, data: Partial<Agent>) =>
    req<Agent>(`/agents/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteAgent: (id: string) => req(`/agents/${id}`, { method: 'DELETE' }),
  agentHistory: (id: string) => req<AgentHistoryItem[]>(`/agents/${id}/history`),
  testAgent: (id: string, agent: Partial<Agent>, messages: { from: 'lead' | 'agent'; text: string }[]) =>
    req<{ text: string; action: AgentAction }>(`/agents/${id}/test`, {
      method: 'POST',
      body: JSON.stringify({ agent, messages }),
    }),
  copilot: (script: string, request: string) =>
    req<{ script: string }>('/agents/copilot', { method: 'POST', body: JSON.stringify({ script, request }) }),

  // Tarefas
  tasks: () => req<Task[]>('/tasks'),
  addTask: (data: Partial<Task>) => req<Task>('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  updateTask: (id: string, data: Partial<Task>) =>
    req<Task>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteTask: (id: string) => req(`/tasks/${id}`, { method: 'DELETE' }),

  // Agenda
  events: (from: string, to: string) => req<CalEvent[]>(`/events?from=${from}&to=${to}`),
  addEvent: (data: Partial<CalEvent>) => req<CalEvent>('/events', { method: 'POST', body: JSON.stringify(data) }),
  updateEvent: (id: string, data: Partial<CalEvent>) =>
    req<CalEvent>(`/events/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteEvent: (id: string) => req(`/events/${id}`, { method: 'DELETE' }),

  // Automações
  quickReplies: () => req<QuickReply[]>('/quick-replies'),
  addQuickReply: (shortcut: string, text: string) =>
    req<QuickReply>('/quick-replies', { method: 'POST', body: JSON.stringify({ shortcut, text }) }),
  deleteQuickReply: (id: string) => req(`/quick-replies/${id}`, { method: 'DELETE' }),
  keywordRules: () => req<KeywordRule[]>('/keyword-rules'),
  addKeywordRule: (keyword: string, reply: string) =>
    req<KeywordRule>('/keyword-rules', { method: 'POST', body: JSON.stringify({ keyword, reply }) }),
  updateKeywordRule: (id: string, data: Partial<KeywordRule>) =>
    req<KeywordRule>(`/keyword-rules/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteKeywordRule: (id: string) => req(`/keyword-rules/${id}`, { method: 'DELETE' }),

  // Dashboard
  dashboard: (days = 7) => req<DashboardData>(`/dashboard?days=${days}`),

  // IA
  aiConfig: () =>
    req<{
      systemPrompt: string;
      autoReply: boolean;
      autoStage: boolean;
      model: string;
      provider: string;
      baseUrl: string;
      hasKey: boolean;
      providerConnected: boolean;
      crmProvider: string;
      crmModel: string;
      crmBaseUrl: string;
      crmHasKey: boolean;
      crmConnected: boolean;
      providers: AiProvider[];
    }>('/ai/config'),
  updateAiConfig: (data: {
    systemPrompt?: string;
    autoReply?: boolean;
    autoStage?: boolean;
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    clearKey?: boolean;
    crmProvider?: string;
    crmModel?: string;
    crmBaseUrl?: string;
    crmApiKey?: string;
    clearCrmKey?: boolean;
  }) =>
    req<{ providerConnected: boolean; hasKey: boolean; crmConnected: boolean; crmHasKey: boolean }>('/ai/config', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  testAi: (which?: 'crm') =>
    req<{ ok: boolean; provider?: string; model?: string; sample?: string; error?: string }>(
      `/ai/config/test${which ? '?which=crm' : ''}`,
      { method: 'POST' },
    ),
  reclassifyStages: () => req<{ total: number }>('/ai/reclassify-stages', { method: 'POST' }),

  // Sessão / clientes
  me: () => req<{ user: SessionUser; workspace: WorkspaceInfo }>('/auth/me'),
  changePassword: (current: string, next: string) =>
    req('/auth/password', { method: 'POST', body: JSON.stringify({ current, next }) }),
  switchWorkspace: async (workspaceId: string) => {
    const r = await req<{ token: string; workspace: WorkspaceInfo }>('/auth/switch', {
      method: 'POST',
      body: JSON.stringify({ workspaceId }),
    });
    setToken(r.token);
    return r.workspace;
  },
  adminWorkspaces: () => req<AdminWorkspace[]>('/admin/workspaces'),
  adminCreateWorkspace: (data: {
    name: string;
    plan: string;
    expiresAt: string | null;
    userName: string;
    email: string;
    password: string;
  }) => req<WorkspaceInfo>('/admin/workspaces', { method: 'POST', body: JSON.stringify(data) }),
  adminUpdateWorkspace: (id: string, data: Partial<Pick<WorkspaceInfo, 'name' | 'plan' | 'expiresAt' | 'active'>>) =>
    req<WorkspaceInfo>(`/admin/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  adminDeleteWorkspace: (id: string, confirmName: string) =>
    req(`/admin/workspaces/${id}`, { method: 'DELETE', body: JSON.stringify({ confirmName }) }),
  adminSetPassword: (userId: string, password: string) =>
    req(`/admin/users/${userId}/password`, { method: 'POST', body: JSON.stringify({ password }) }),
  adminSetEmail: (userId: string, email: string) =>
    req(`/admin/users/${userId}/email`, { method: 'POST', body: JSON.stringify({ email }) }),

  // IA GLOBAL da plataforma (só admin). Vale para todos os clientes.
  adminAiConfig: () =>
    req<{
      provider: string;
      model: string;
      baseUrl: string;
      hasKey: boolean;
      providerConnected: boolean;
      crmProvider: string;
      crmModel: string;
      crmBaseUrl: string;
      crmHasKey: boolean;
      crmConnected: boolean;
      autoStage: boolean;
      mediaHasKey: boolean;
      mediaReady: boolean;
      mediaModel: string;
      gadsClientId: string;
      gadsLoginCustomerId: string;
      gadsHasSecret: boolean;
      gadsHasDeveloperToken: boolean;
      gadsHasRefreshToken: boolean;
      gadsReady: boolean;
      gadsOauthReady: boolean;
      providers: AiProvider[];
    }>('/admin/ai'),
  adminUpdateAi: (data: {
    provider?: string;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    clearKey?: boolean;
    crmProvider?: string;
    crmModel?: string;
    crmBaseUrl?: string;
    crmApiKey?: string;
    clearCrmKey?: boolean;
    autoStage?: boolean;
    mediaApiKey?: string;
    mediaModel?: string;
    clearMediaKey?: boolean;
    gadsClientId?: string;
    gadsClientSecret?: string;
    gadsDeveloperToken?: string;
    gadsLoginCustomerId?: string;
    gadsRefreshToken?: string;
    clearGadsSecret?: boolean;
    clearGadsDeveloperToken?: boolean;
    clearGadsRefreshToken?: boolean;
  }) =>
    req<{
      providerConnected: boolean;
      hasKey: boolean;
      crmConnected: boolean;
      crmHasKey: boolean;
      mediaHasKey: boolean;
      mediaReady: boolean;
      gadsReady: boolean;
      gadsOauthReady: boolean;
      gadsHasSecret: boolean;
      gadsHasDeveloperToken: boolean;
      gadsHasRefreshToken: boolean;
    }>('/admin/ai', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  adminTestAi: (which?: 'crm') =>
    req<{ ok: boolean; provider?: string; model?: string; error?: string }>(`/admin/ai/test${which ? '?which=crm' : ''}`, {
      method: 'POST',
    }),
  adminReclassifyWorkspace: (workspaceId: string) =>
    req<{ total: number }>(`/admin/ai/reclassify/${workspaceId}`, { method: 'POST' }),

  // Administradores (só master)
  adminAdmins: () => req<AdminUser[]>('/admin/admins'),
  adminCreateAdmin: (data: { name: string; email: string; password: string; isMaster: boolean; workspaceIds: string[] }) =>
    req<{ id: string }>('/admin/admins', { method: 'POST', body: JSON.stringify(data) }),
  adminUpdateAdmin: (id: string, data: { name?: string; isMaster?: boolean; workspaceIds?: string[] }) =>
    req(`/admin/admins/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  adminDeleteAdmin: (id: string) => req(`/admin/admins/${id}`, { method: 'DELETE' }),

  // Meta Ads
  adsMeta: () =>
    req<{
      adAccountId: string;
      adAccountName: string;
      pixelId: string;
      capiEnabled: boolean;
      qualifiedStageId: string;
      eventName: string;
      hasToken: boolean;
      oauthAvailable: boolean;
      connectedVia: string;
      connectedName: string;
      tokenExpiresAt: number | null;
      stages: { id: string; name: string }[];
    }>('/ads/meta'),
  adsMetaSave: (data: {
    adAccountId?: string;
    adAccountName?: string;
    token?: string;
    pixelId?: string;
    capiEnabled?: boolean;
    qualifiedStageId?: string;
    eventName?: string;
  }) => req('/ads/meta', { method: 'PATCH', body: JSON.stringify(data) }),
  adsMetaOauthUrl: () => req<{ available: boolean; url?: string }>('/ads/meta/oauth-url'),
  adsMetaAccounts: () => req<{ accounts: { id: string; name: string }[]; error?: string }>('/ads/meta/accounts'),
  adsMetaDisconnect: () => req<{ ok: boolean }>('/ads/meta/disconnect', { method: 'POST' }),
  adsMetaSummary: (preset = 'last_30d') =>
    req<{
      configured: boolean;
      error?: string;
      spend?: number;
      impressions?: number;
      clicks?: number;
      cpc?: number;
      ctr?: number;
      leads?: number;
      campaigns?: { name: string; status: string; objective?: string }[];
    }>(`/ads/meta/summary?preset=${preset}`),
  adsMetaTestCapi: (phone?: string) => req<{ ok: boolean }>('/ads/meta/test-capi', { method: 'POST', body: JSON.stringify({ phone }) }),
  adsMetaBreakdown: (preset = 'last_30d') =>
    req<{
      configured: boolean;
      error?: string;
      campaigns?: MetaAdNode[];
    }>(`/ads/meta/breakdown?preset=${preset}`),

  // Google Ads
  adsGoogle: () =>
    req<{
      customerId: string;
      customerName: string;
      clientId: string;
      connectedVia: string;
      connectedEmail: string;
      hasDeveloperToken: boolean;
      hasRefreshToken: boolean;
      hasClientSecret: boolean;
      oauthAvailable: boolean;
      developerTokenReady: boolean;
      globalReady: boolean;
      conversionsEnabled: boolean;
      qualifiedStageId: string;
      conversionActionId: string;
      conversionName: string;
      stages: { id: string; name: string }[];
    }>('/ads/google'),
  adsGoogleSave: (data: {
    customerId?: string;
    customerName?: string;
    developerToken?: string;
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
    conversionsEnabled?: boolean;
    qualifiedStageId?: string;
    conversionActionId?: string;
    conversionName?: string;
  }) => req('/ads/google', { method: 'PATCH', body: JSON.stringify(data) }),
  adsGoogleBreakdown: (preset = 'last_30d') =>
    req<{ configured: boolean; error?: string; campaigns?: MetaAdNode[] }>(`/ads/google/breakdown?preset=${preset}`),
  adsGoogleOauthUrl: () => req<{ available: boolean; url?: string }>('/ads/google/oauth-url'),
  adsGoogleCustomers: () => req<{ customers: { id: string; name: string }[]; error?: string }>('/ads/google/customers'),
  adsGoogleConversionActions: () => req<{ actions: { id: string; name: string }[]; error?: string }>('/ads/google/conversion-actions'),
  adsGoogleTestConversion: (phone?: string) =>
    req<{ ok: boolean }>('/ads/google/test-conversion', { method: 'POST', body: JSON.stringify({ phone }) }),
  adsGoogleDisconnect: () => req<{ ok: boolean }>('/ads/google/disconnect', { method: 'POST' }),
  adsGoogleSummary: () =>
    req<{
      configured: boolean;
      error?: string;
      spend?: number;
      impressions?: number;
      clicks?: number;
      conversions?: number;
      cpc?: number;
      campaigns?: { name: string; status: string }[];
    }>('/ads/google/summary'),
};
