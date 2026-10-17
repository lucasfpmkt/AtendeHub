import { useEffect, useState } from 'react';
import { socket, connectSocket, disconnectSocket } from './socket';
import { api, getToken, setToken, onUnauthorized } from './api';
import { Icon } from './icons';
import { Login } from './pages/Login';
import { Connect } from './pages/Connect';
import { Inbox } from './pages/Inbox';
import { Contacts } from './pages/Contacts';
import { Pipeline } from './pages/Pipeline';
import { Settings } from './pages/Settings';
import { Home } from './pages/Home';
import { Dashboard } from './pages/Dashboard';
import { Agents } from './pages/Agents';
import { Tasks } from './pages/Tasks';
import { Agenda } from './pages/Agenda';
import { Automations } from './pages/Automations';

export type Tab =
  | 'home'
  | 'dashboard'
  | 'inbox'
  | 'agents'
  | 'pipeline'
  | 'contacts'
  | 'tasks'
  | 'agenda'
  | 'automations'
  | 'connect'
  | 'settings';

// Navegação em trilho de ícones, na ordem do fluxo de trabalho.
const TABS: { id: Tab; label: string; icon: string; ai?: boolean }[] = [
  { id: 'home', label: 'Início', icon: 'home' },
  { id: 'dashboard', label: 'Dashboard', icon: 'grid' },
  { id: 'inbox', label: 'Conversas', icon: 'chat' },
  { id: 'agents', label: 'Agentes IA', icon: 'bot', ai: true },
  { id: 'automations', label: 'Automações', icon: 'zap' },
  { id: 'pipeline', label: 'CRM / Funil', icon: 'crm' },
  { id: 'contacts', label: 'Contatos', icon: 'users' },
  { id: 'tasks', label: 'Tarefas', icon: 'check' },
  { id: 'agenda', label: 'Agenda', icon: 'cal' },
];

const TAB_KEY = 'lawhub.tab';

export function App() {
  const [authed, setAuthed] = useState<boolean>(() => Boolean(getToken()));

  // Desloga automaticamente se a API responder 401 em qualquer ponto.
  useEffect(() => {
    const off = onUnauthorized(() => setAuthed(false));
    return () => {
      off();
    };
  }, []);

  if (!authed) {
    return <Login onSuccess={() => setAuthed(true)} />;
  }

  return <Shell onLogout={() => setAuthed(false)} />;
}

function Shell({ onLogout }: { onLogout: () => void }) {
  const [tab, setTabState] = useState<Tab>(() => {
    const saved = localStorage.getItem(TAB_KEY) as Tab | null;
    return saved ?? 'home';
  });
  const [waStatus, setWaStatus] = useState<string>('disconnected');
  const [me, setMe] = useState<string | undefined>();
  const [unread, setUnread] = useState(0);

  const setTab = (t: Tab) => {
    setTabState(t);
    localStorage.setItem(TAB_KEY, t);
  };

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

  const logout = () => {
    setToken(null);
    disconnectSocket();
    onLogout();
  };

  const connected = waStatus === 'connected';
  const number = me ? me.split(':')[0].split('@')[0] : undefined;

  return (
    <div className="app">
      <nav className="rail" aria-label="Módulos">
        <img src="/logo.png" alt="LawHub" className="rail-logo" title="LawHub" />
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`rail-btn ${tab === t.id ? 'active' : ''} ${t.ai ? 'ai' : ''}`}
            onClick={() => setTab(t.id)}
            aria-label={t.label}
          >
            <Icon name={t.icon} size={20} />
            {t.id === 'inbox' && unread > 0 && <span className="rail-badge">{unread > 99 ? '99+' : unread}</span>}
            <span className="rail-tip">{t.label}</span>
          </button>
        ))}
        <div className="rail-spacer" />
        <button
          className={`rail-btn ${tab === 'connect' ? 'active' : ''}`}
          onClick={() => setTab('connect')}
          aria-label="Conexão WhatsApp"
        >
          <Icon name="wifi" size={20} />
          <span className={`rail-dot ${connected ? 'on' : ''}`} />
          <span className="rail-tip">
            {connected ? `WhatsApp conectado${number ? ` (${number})` : ''}` : labelFor(waStatus)}
          </span>
        </button>
        <button
          className={`rail-btn ${tab === 'settings' ? 'active' : ''}`}
          onClick={() => setTab('settings')}
          aria-label="IA & Ajustes"
        >
          <Icon name="settings" size={20} />
          <span className="rail-tip">IA & Ajustes</span>
        </button>
        <button className="rail-btn" onClick={logout} aria-label="Sair">
          <Icon name="logout" size={20} />
          <span className="rail-tip">Sair</span>
        </button>
      </nav>

      <main className="main">
        {tab === 'home' && <Home go={setTab} connected={connected} />}
        {tab === 'dashboard' && <Dashboard />}
        {tab === 'inbox' && <Inbox connected={connected} />}
        {tab === 'agents' && <Agents />}
        {tab === 'automations' && <Automations />}
        {tab === 'pipeline' && <Pipeline />}
        {tab === 'contacts' && <Contacts />}
        {tab === 'tasks' && <Tasks />}
        {tab === 'agenda' && <Agenda />}
        {tab === 'connect' && <Connect status={waStatus} me={me} />}
        {tab === 'settings' && <Settings />}
      </main>
    </div>
  );
}

function labelFor(s: string) {
  switch (s) {
    case 'connecting':
      return 'Conectando…';
    case 'qr':
      return 'Aguardando QR code';
    default:
      return 'WhatsApp desconectado';
  }
}
