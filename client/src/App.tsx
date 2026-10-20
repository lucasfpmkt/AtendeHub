import { useEffect, useState } from 'react';
import { socket, connectSocket, disconnectSocket } from './socket';
import { api, getToken, setToken, onUnauthorized, type SessionUser, type WorkspaceInfo } from './api';
import { Icon } from './icons';
import { applyBrand } from './prefs';
import { Login } from './pages/Login';
import { Connect } from './pages/Connect';
import { Inbox } from './pages/Inbox';
import { Contacts } from './pages/Contacts';
import { Campaigns } from './pages/Campaigns';
import { Pipeline } from './pages/Pipeline';
import { Settings } from './pages/Settings';
import { Home } from './pages/Home';
import { Dashboard } from './pages/Dashboard';
import { AgentsModule } from './pages/Agents';
import { Tasks } from './pages/Tasks';
import { Agenda } from './pages/Agenda';
import { Automations } from './pages/Automations';
import { Clients } from './pages/Clients';
import { WorkspacePicker } from './pages/WorkspacePicker';

export type Tab =
  | 'home'
  | 'dashboard'
  | 'inbox'
  | 'agents'
  | 'automations'
  | 'pipeline'
  | 'contacts'
  | 'campaigns'
  | 'tasks'
  | 'agenda'
  | 'connect'
  | 'settings'
  | 'clients';

// Mesma ordem e nomes do menu da Guimoo (adaptado ao LawHub).
const NAV: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'dashboard', label: 'Dashboard', icon: 'grid' },
  { id: 'inbox', label: 'Conversas', icon: 'chat' },
  { id: 'agents', label: 'LawHub IA', icon: 'bot' },
  { id: 'automations', label: 'Automações', icon: 'zap' },
  { id: 'pipeline', label: 'CRM', icon: 'crm' },
  { id: 'contacts', label: 'Contatos', icon: 'users' },
  { id: 'campaigns', label: 'Campanhas', icon: 'send' },
  { id: 'tasks', label: 'Gestão de Tarefas', icon: 'check' },
  { id: 'agenda', label: 'Agendas', icon: 'cal' },
];

const TAB_KEY = 'lawhub.tab';
const PICKED_KEY = 'lawhub.pickedWorkspace';
applyBrand();

type Session = { user: SessionUser; workspace: WorkspaceInfo };

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(() => Boolean(getToken()));
  const [blockedMsg, setBlockedMsg] = useState('');

  // Desloga automaticamente se a API responder 401 em qualquer ponto.
  useEffect(() => {
    const off = onUnauthorized(() => setSession(null));
    return () => {
      off();
    };
  }, []);

  // Sessão salva: confirma no servidor quem é e qual cliente está aberto.
  useEffect(() => {
    if (!getToken()) return;
    api
      .me()
      .then(setSession)
      .catch((e) => {
        setToken(null);
        setBlockedMsg((e as Error).message.includes('Sessão') ? '' : (e as Error).message);
      })
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <div className="auth-page muted">Carregando…</div>;

  if (!session) {
    return (
      <>
        {blockedMsg && <div className="auth-banner">{blockedMsg}</div>}
        <Login
          onSuccess={(r) => {
            // Admin escolhe o cliente logo depois de entrar (como na Guimoo).
            sessionStorage.removeItem(PICKED_KEY);
            setSession(r);
          }}
        />
      </>
    );
  }

  return (
    <Shell
      session={session}
      onLogout={() => {
        setToken(null);
        sessionStorage.removeItem(PICKED_KEY);
        setSession(null);
      }}
    />
  );
}

function Shell({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const { user, workspace } = session;
  const isAdmin = user.role === 'admin';
  const [tab, setTabState] = useState<Tab>(() => (localStorage.getItem(TAB_KEY) as Tab | null) ?? 'home');
  const [waStatus, setWaStatus] = useState<string>('disconnected');
  const [me, setMe] = useState<string | undefined>();
  const [unread, setUnread] = useState(0);
  const [picker, setPicker] = useState(() => isAdmin && !sessionStorage.getItem(PICKED_KEY));
  const [inboxContact, setInboxContact] = useState<string | null>(null);

  const setTab = (t: Tab) => {
    setTabState(t);
    localStorage.setItem(TAB_KEY, t);
  };

  // Abre a conversa de um contato (vindo do CRM).
  const openConversation = (contactId: string) => {
    setInboxContact(contactId);
    setTab('inbox');
  };
  const current: Tab = tab === 'clients' && !isAdmin ? 'home' : tab;

  useEffect(() => {
    connectSocket();
    api.waStatus().then((s) => {
      setWaStatus(s.status);
      setMe(s.me);
    });
    const refreshUnread = () =>
      api
        .conversations()
        .then((cs) => setUnread(cs.reduce((s, c) => s + (c.unread ?? 0), 0)))
        .catch(() => {});
    refreshUnread();
    const onStatus = (e: { status: string; me?: string }) => {
      setWaStatus(e.status);
      setMe(e.me);
    };
    socket.on('wa:status', onStatus);
    socket.on('message:new', refreshUnread);
    socket.on('conversation:update', refreshUnread);
    return () => {
      socket.off('wa:status', onStatus);
      socket.off('message:new', refreshUnread);
      socket.off('conversation:update', refreshUnread);
      disconnectSocket();
    };
  }, []);

  const connected = waStatus === 'connected';
  const number = me ? me.split(':')[0].split('@')[0] : undefined;
  const firstName = user.name.split(' ')[0];

  const closePicker = () => {
    sessionStorage.setItem(PICKED_KEY, '1');
    setPicker(false);
  };

  return (
    <div className="app">
      <nav className="rail" aria-label="Menu principal">
        <div className="rail-brand">
          <img src="/logo.png" alt="" />
          <span className="wordmark label">
            Law<b>Hub</b>
          </span>
        </div>
        {NAV.map((t) => (
          <button
            key={t.id}
            className={`rail-link ${current === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
            aria-label={t.label}
            title={t.label}
          >
            <Icon name={t.icon} size={20} />
            {t.id === 'inbox' && unread > 0 && <span className="rail-badge">{unread > 99 ? '99+' : unread}</span>}
            <span className="label">{t.label}</span>
          </button>
        ))}
        {isAdmin && (
          <button
            className={`rail-link ${current === 'clients' ? 'active' : ''}`}
            onClick={() => setTab('clients')}
            aria-label="Clientes"
            title="Clientes"
          >
            <Icon name="building" size={20} />
            <span className="label">Clientes</span>
          </button>
        )}
        <div className="rail-spacer" />
        <button
          className={`rail-link ${current === 'connect' ? 'active' : ''}`}
          onClick={() => setTab('connect')}
          aria-label="Conexão WhatsApp"
          title={connected ? 'WhatsApp conectado' : 'WhatsApp desconectado'}
        >
          <Icon name="wifi" size={20} />
          <span className={`rail-dot ${connected ? 'on' : ''}`} />
          <span className="label">{connected ? `WhatsApp ${number ? `+${number}` : 'conectado'}` : 'Conectar WhatsApp'}</span>
        </button>
        <button
          className={`rail-link ${current === 'settings' ? 'active' : ''}`}
          onClick={() => setTab('settings')}
          aria-label="Configurações"
          title="Configurações"
        >
          <Icon name="settings" size={20} />
          <span className="label">Configurações</span>
        </button>
        <button
          className="rail-ws"
          onClick={() => (isAdmin ? setPicker(true) : setTab('settings'))}
          title={isAdmin ? 'Trocar de cliente' : workspace.name}
        >
          <Icon name="building" size={18} />
          <span className="st">
            <b>Workspace · #{workspace.code}</b>
            <small>{workspace.name}</small>
          </span>
        </button>
        <div className="rail-user">
          <span className="avatar gray">{firstName[0]?.toUpperCase() ?? 'U'}</span>
          <span className="label user-name">
            {firstName}
            {isAdmin && <small>Administrador</small>}
          </span>
          <button className="icon-btn label" onClick={onLogout} aria-label="Sair" title="Sair">
            <Icon name="logout" size={18} />
          </button>
        </div>
      </nav>

      <main className="main">
        {current === 'home' && <Home go={setTab} connected={connected} userName={firstName} />}
        {current === 'dashboard' && <Dashboard />}
        {current === 'inbox' && (
          <Inbox connected={connected} focusContactId={inboxContact} onFocusConsumed={() => setInboxContact(null)} />
        )}
        {current === 'agents' && <AgentsModule number={number} />}
        {current === 'automations' && <Automations />}
        {current === 'pipeline' && <Pipeline onOpenConversation={openConversation} />}
        {current === 'contacts' && <Contacts />}
        {current === 'campaigns' && <Campaigns connected={connected} />}
        {current === 'tasks' && <Tasks />}
        {current === 'agenda' && <Agenda />}
        {current === 'connect' && <Connect status={waStatus} me={me} />}
        {current === 'settings' && <Settings user={user} workspace={workspace} />}
        {current === 'clients' && isAdmin && <Clients currentId={workspace.id} isMaster={user.isMaster} />}
      </main>

      {picker && <WorkspacePicker currentId={workspace.id} onClose={closePicker} />}
    </div>
  );
}
