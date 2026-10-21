import { useEffect, useMemo, useState } from 'react';
import { api, type AiProvider, type SessionUser, type WorkspaceInfo } from '../api';
import { Icon } from '../icons';
import { getBrand, setBrand, type Brand } from '../prefs';

export function Settings({ user, workspace, onLogout }: { user: SessionUser; workspace: WorkspaceInfo; onLogout?: () => void }) {
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
  const [autoStage, setAutoStage] = useState(true);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // IA dedicada do CRM (ler conversas e mover/criar etapas)
  const [crmProvider, setCrmProvider] = useState('');
  const [crmModel, setCrmModel] = useState('');
  const [crmBaseUrl, setCrmBaseUrl] = useState('');
  const [crmApiKey, setCrmApiKey] = useState('');
  const [crmHasKey, setCrmHasKey] = useState(false);
  const [crmConnected, setCrmConnected] = useState(false);
  const [crmTestMsg, setCrmTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [crmTesting, setCrmTesting] = useState(false);
  const [crmSaved, setCrmSaved] = useState(false);
  const [reclass, setReclass] = useState<{ ok: boolean; text: string } | null>(null);

  const preset = useMemo(() => providers.find((p) => p.id === provider), [providers, provider]);
  const crmPreset = useMemo(() => providers.find((p) => p.id === crmProvider), [providers, crmProvider]);

  useEffect(() => {
    api.aiConfig().then((c) => {
      setSystemPrompt(c.systemPrompt);
      setConnected(c.providerConnected);
      setProviders(c.providers);
      setProvider(c.provider);
      setModel(c.model);
      setBaseUrl(c.baseUrl);
      setHasKey(c.hasKey);
      setAutoStage(c.autoStage);
      setCrmProvider(c.crmProvider || '');
      setCrmModel(c.crmModel || '');
      setCrmBaseUrl(c.crmBaseUrl || '');
      setCrmHasKey(c.crmHasKey);
      setCrmConnected(c.crmConnected);
    });
  }, []);

  const onCrmProvider = (id: string) => {
    setCrmProvider(id);
    setCrmTestMsg(null);
    const p = providers.find((x) => x.id === id);
    if (p) {
      setCrmModel(p.defaultModel);
      setCrmBaseUrl(p.baseUrl);
    }
  };
  const saveCrm = async () => {
    setCrmTestMsg(null);
    const r = await api.updateAiConfig({
      crmProvider,
      crmModel,
      crmBaseUrl,
      ...(crmApiKey.trim() ? { crmApiKey: crmApiKey.trim() } : {}),
    });
    setCrmConnected(r.crmConnected);
    setCrmHasKey(r.crmHasKey);
    setCrmApiKey('');
    setCrmSaved(true);
    setTimeout(() => setCrmSaved(false), 1800);
  };
  const disconnectCrm = async () => {
    const r = await api.updateAiConfig({ clearCrmKey: true, crmProvider: '' });
    setCrmConnected(r.crmConnected);
    setCrmHasKey(r.crmHasKey);
    setCrmProvider('');
    setCrmApiKey('');
  };
  const testCrm = async () => {
    setCrmTesting(true);
    setCrmTestMsg(null);
    try {
      const r = await api.testAi('crm');
      setCrmTestMsg(r.ok ? { ok: true, text: `Conectado · ${r.provider} · ${r.model}` } : { ok: false, text: r.error || 'Falhou' });
      if (r.ok) setCrmConnected(true);
    } catch (x) {
      setCrmTestMsg({ ok: false, text: (x as Error).message });
    } finally {
      setCrmTesting(false);
    }
  };
  const reclassify = async () => {
    setReclass({ ok: true, text: 'Iniciando…' });
    try {
      const r = await api.reclassifyStages();
      setReclass({ ok: true, text: `Reavaliando ${r.total} conversa(s) em segundo plano. As etapas vão se ajustar nos próximos minutos.` });
    } catch (x) {
      setReclass({ ok: false, text: (x as Error).message });
    }
  };

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
    await api.updateAiConfig({ systemPrompt });
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
        {onLogout && (
          <button className="danger-text" onClick={onLogout} title="Sair da conta">
            <Icon name="logout" size={16} /> Sair
          </button>
        )}
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
            A conexão de IA (provedor, modelo e a mudança automática de etapas) é gerenciada pelo administrador do LawHub e vale
            para todas as contas. Aqui você só ajusta a instrução do rascunho de resposta.
          </p>
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
