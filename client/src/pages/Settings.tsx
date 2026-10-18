import { useEffect, useMemo, useState } from 'react';
import { api, type AiProvider, type SessionUser, type WorkspaceInfo } from '../api';
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

  // Provedor de IA
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const preset = useMemo(() => providers.find((p) => p.id === provider), [providers, provider]);

  useEffect(() => {
    api.aiConfig().then((c) => {
      setSystemPrompt(c.systemPrompt);
      setConnected(c.providerConnected);
      setProviders(c.providers);
      setProvider(c.provider);
      setModel(c.model);
      setBaseUrl(c.baseUrl);
      setHasKey(c.hasKey);
    });
  }, []);

  const onProvider = (id: string) => {
    setProvider(id);
    setTestMsg(null);
    const p = providers.find((x) => x.id === id);
    if (p) {
      setModel(p.defaultModel);
      setBaseUrl(p.baseUrl);
    }
  };

  const save = async () => {
    setTestMsg(null);
    const r = await api.updateAiConfig({
      systemPrompt,
      provider,
      model,
      baseUrl,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
    setConnected(r.providerConnected);
    setHasKey(r.hasKey);
    setApiKey('');
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const disconnect = async () => {
    const r = await api.updateAiConfig({ clearKey: true });
    setConnected(r.providerConnected);
    setHasKey(r.hasKey);
    setApiKey('');
  };

  const test = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const r = await api.testAi();
      setTestMsg(r.ok ? { ok: true, text: `Conectado · ${r.provider} · ${r.model}` } : { ok: false, text: r.error || 'Falhou' });
      if (r.ok) setConnected(true);
    } catch (x) {
      setTestMsg({ ok: false, text: (x as Error).message });
    } finally {
      setTesting(false);
    }
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
            <span className={`pill ${connected ? 'ok' : 'warn'}`}>{connected ? 'IA conectada' : 'IA não conectada'}</span>
          </div>

          <p className="muted small">
            Conecte qualquer IA do mercado: escolha o provedor, cole a chave da API e selecione o modelo. A chave fica salva só para este cliente.
          </p>

          <div className="duo">
            <div className="field-sm">
              <span>Provedor</span>
              <select value={provider} onChange={(e) => onProvider(e.target.value)}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-sm">
              <span>Modelo</span>
              <input
                list="ai-models"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={preset?.defaultModel || 'nome do modelo'}
              />
              <datalist id="ai-models">
                {(preset?.models ?? []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
          </div>

          {provider === 'custom' && (
            <div className="field-sm">
              <span>Endpoint (compatível com OpenAI)</span>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://.../v1" />
            </div>
          )}

          <div className="field-sm">
            <span>
              Chave da API{' '}
              {preset?.keyUrl && (
                <a href={preset.keyUrl} target="_blank" rel="noreferrer" className="small">
                  (onde pegar)
                </a>
              )}
            </span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasKey ? '•••••••• (chave salva — deixe em branco para manter)' : preset?.keyHint || 'cole a chave'}
              autoComplete="off"
            />
          </div>

          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="primary" onClick={save}>
              {saved ? 'Salvo' : 'Salvar e conectar'}
            </button>
            <button onClick={test} disabled={testing}>
              {testing ? 'Testando…' : 'Testar conexão'}
            </button>
            {hasKey && (
              <button className="ghost" onClick={disconnect}>
                Desconectar
              </button>
            )}
            {testMsg && <span className={`small ${testMsg.ok ? 'ok-text' : 'late-text'}`}>{testMsg.text}</span>}
          </div>

          <div className="field-sm" style={{ marginTop: 6 }}>
            <span>Instrução base do rascunho de resposta (botão ✦ nas conversas sem agente)</span>
            <textarea rows={4} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
          </div>
        </section>
      </div>
    </div>
  );
}
