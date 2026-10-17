import { useEffect, useState } from 'react';
import { api, type SessionUser, type WorkspaceInfo } from '../api';
import { Icon } from '../icons';
import { getBrand, setBrand, type Brand } from '../prefs';

export function Settings({ user, workspace }: { user: SessionUser; workspace: WorkspaceInfo }) {
  const [systemPrompt, setSystemPrompt] = useState('');
  const [connected, setConnected] = useState(false);
  const [saved, setSaved] = useState(false);
  const [brand, setBrandState] = useState<Brand>(getBrand());
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [passMsg, setPassMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api.aiConfig().then((c) => {
      setSystemPrompt(c.systemPrompt);
      setConnected(c.providerConnected);
    });
  }, []);

  const save = async () => {
    await api.updateAiConfig({ systemPrompt });
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const changePass = async (e: React.FormEvent) => {
    e.preventDefault();
    setPassMsg(null);
    try {
      await api.changePassword(cur, next);
      setCur('');
      setNext('');
      setPassMsg({ ok: true, text: 'Senha alterada.' });
    } catch (x) {
      setPassMsg({ ok: false, text: (x as Error).message });
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h1">Configurações</h1>
          <p className="sub">
            {workspace.name} · #{workspace.code}
          </p>
        </div>
      </div>

      <div className="settings-grid">
        <section className="card stack">
          <h3 className="card-title">
            <Icon name="user" /> Minha conta
          </h3>
          <div className="kv">
            <span>Nome</span>
            <b>{user.name}</b>
            <span>Login</span>
            <b>{user.email}</b>
            <span>Perfil</span>
            <b>{user.role === 'admin' ? 'Administrador (vê todos os clientes)' : 'Usuário do escritório'}</b>
            <span>Plano</span>
            <b>
              {workspace.plan}
              {workspace.expiresAt && ` · até ${workspace.expiresAt.split('-').reverse().join('/')}`}
            </b>
          </div>
          <form className="stack-sm" onSubmit={changePass}>
            <div className="duo">
              <div className="field-sm">
                <span>Senha atual</span>
                <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
              </div>
              <div className="field-sm">
                <span>Nova senha</span>
                <input
                  type="password"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  minLength={8}
                  autoComplete="new-password"
                  required
                />
              </div>
            </div>
            <div className="row">
              <button>
                <Icon name="key" size={16} /> Trocar senha
              </button>
              {passMsg && <span className={`small ${passMsg.ok ? 'ok-text' : 'late-text'}`}>{passMsg.text}</span>}
            </div>
          </form>
        </section>

        <section className="card stack">
          <h3 className="card-title">
            <Icon name="settings" /> Aparência
          </h3>
          <div className="field-sm">
            <span>Cor de destaque</span>
            <div className="segmented" style={{ alignSelf: 'flex-start' }}>
              {(
                [
                  ['red', 'Vermelho Law Mídias'],
                  ['blue', 'Azul'],
                ] as const
              ).map(([k, l]) => (
                <button
                  key={k}
                  className={brand === k ? 'active' : ''}
                  onClick={() => {
                    setBrand(k);
                    setBrandState(k);
                  }}
                >
                  {l}
                </button>
              ))}
            </div>
            <span className="muted small">Vale só para este navegador.</span>
          </div>
        </section>

        <section className="card stack" style={{ gridColumn: '1 / -1' }}>
          <div className="row between">
            <h3 className="card-title" style={{ margin: 0 }}>
              <Icon name="bot" /> Assistente de IA
            </h3>
            <span className={`pill ${connected ? 'ok' : 'warn'}`}>{connected ? 'IA conectada' : 'IA não configurada'}</span>
          </div>
          {!connected && (
            <p className="muted small">
              Defina <code>ANTHROPIC_API_KEY</code> no servidor para os agentes e o rascunho responderem de verdade.
            </p>
          )}
          <div className="field-sm">
            <span>Instrução base do rascunho de resposta (botão ✦ nas conversas sem agente)</span>
            <textarea rows={4} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
          </div>
          <div className="row">
            <button className="primary" onClick={save}>
              {saved ? 'Salvo' : 'Salvar'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
