import { useEffect, useState } from 'react';
import { socket, connectSocket, disconnectSocket } from './socket';
import { api, getToken, setToken, onUnauthorized } from './api';
import { Login } from './pages/Login';
import { Connect } from './pages/Connect';
import { Inbox } from './pages/Inbox';
import { Contacts } from './pages/Contacts';
import { Pipeline } from './pages/Pipeline';
import { Settings } from './pages/Settings';

type Tab = 'connect' | 'inbox' | 'contacts' | 'pipeline' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'inbox', label: '💬 Atendimentos' },
  { id: 'contacts', label: '👥 Contatos (CRM)' },
  { id: 'pipeline', label: '📊 Funil' },
  { id: 'connect', label: '🔌 Conexão' },
  { id: 'settings', label: '⚙️ IA & Ajustes' },
];

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
    return (
      <Login
        onSuccess={() => {
          setAuthed(true);
        }}
      />
    );
  }

  return <Dashboard onLogout={() => setAuthed(false)} />;
}

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('inbox');
  const [waStatus, setWaStatus] = useState<string>('disconnected');
  const [me, setMe] = useState<string | undefined>();

  useEffect(() => {
    connectSocket();
    api.waStatus().then((s) => {
      setWaStatus(s.status);
      setMe(s.me);
    });
    const onStatus = (e: { status: string; me?: string }) => {
      setWaStatus(e.status);
      setMe(e.me);
    };
    socket.on('wa:status', onStatus);
    return () => {
      socket.off('wa:status', onStatus);
      disconnectSocket();
    };
  }, []);

  const logout = () => {
    setToken(null);
    disconnectSocket();
    onLogout();
  };

  const connected = waStatus === 'connected';

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <img src="/logo.png" alt="LawHub" />
          Law<span>Hub</span>
        </div>
        <div className={`status-pill ${connected ? 'connected' : ''}`}>
          <span className="dot" />
          {connected
            ? `Conectado${me ? ` (${me.split(':')[0].split('@')[0]})` : ''}`
            : labelFor(waStatus)}
        </div>
        <nav className="nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'active' : ''}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <button onClick={logout} className="ghost" style={{ width: '100%' }}>
          Sair
        </button>
      </aside>

      <main className="main">
        {tab === 'connect' && <Connect status={waStatus} me={me} />}
        {tab === 'inbox' && <Inbox connected={connected} />}
        {tab === 'contacts' && <Contacts />}
        {tab === 'pipeline' && <Pipeline />}
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
      return 'Desconectado';
  }
}
