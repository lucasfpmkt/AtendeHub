import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Kpi } from './Home';

const BRL = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const NUM = (n: number) => n.toLocaleString('pt-BR');

/* ============================== Meta Ads ============================== */
export function MetaAds() {
  const [cfg, setCfg] = useState<Awaited<ReturnType<typeof api.adsMeta>> | null>(null);
  const [token, setToken] = useState('');
  const [sum, setSum] = useState<Awaited<ReturnType<typeof api.adsMetaSummary>> | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loadingSum, setLoadingSum] = useState(false);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const loadCfg = () => api.adsMeta().then(setCfg).catch(() => {});
  const loadSum = () => {
    setLoadingSum(true);
    api
      .adsMetaSummary()
      .then(setSum)
      .catch(() => {})
      .finally(() => setLoadingSum(false));
  };
  const loadAccounts = () =>
    api
      .adsMetaAccounts()
      .then((r) => setAccounts(r.accounts || []))
      .catch(() => {});
  useEffect(() => {
    loadCfg();
    loadSum();
    loadAccounts();
    // Retorno do login com o Meta (?metaads=ok|erro|cancelado).
    const p = new URLSearchParams(window.location.search);
    const r = p.get('metaads');
    if (r) {
      setMsg(
        r === 'ok'
          ? { ok: true, text: 'Conta do Meta conectada! Já puxei a conta de anúncios e os dados abaixo.' }
          : { ok: false, text: r === 'cancelado' ? 'Login cancelado.' : 'Não foi possível conectar. Tente novamente.' },
      );
      // Limpa a URL para não repetir a mensagem.
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const save = async () => {
    if (!cfg) return;
    setMsg(null);
    try {
      await api.adsMetaSave({
        adAccountId: cfg.adAccountId,
        pixelId: cfg.pixelId,
        capiEnabled: cfg.capiEnabled,
        qualifiedStageId: cfg.qualifiedStageId,
        eventName: cfg.eventName,
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      setToken('');
      setMsg({ ok: true, text: 'Salvo.' });
      loadCfg();
      loadSum();
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    }
  };
  const connectMeta = async () => {
    setConnecting(true);
    setMsg(null);
    try {
      const r = await api.adsMetaOauthUrl();
      if (r.available && r.url) window.location.href = r.url;
      else setMsg({ ok: false, text: 'Login com o Meta não está disponível neste servidor.' });
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    } finally {
      setConnecting(false);
    }
  };
  const disconnectMeta = async () => {
    if (!confirm('Desconectar a conta do Meta? O resumo e o retorno de leads param até reconectar.')) return;
    await api.adsMetaDisconnect().catch(() => {});
    setAccounts([]);
    setMsg({ ok: true, text: 'Conta desconectada.' });
    loadCfg();
    loadSum();
  };
  const pickAccount = async (id: string) => {
    const acc = accounts.find((a) => a.id === id);
    await api.adsMetaSave({ adAccountId: id, adAccountName: acc?.name || '' }).catch(() => {});
    setCfg((c) => (c ? { ...c, adAccountId: id, adAccountName: acc?.name || '' } : c));
    loadSum();
  };
  const testCapi = async () => {
    setMsg(null);
    try {
      await api.adsMetaTestCapi();
      setMsg({ ok: true, text: 'Evento de teste enviado ao Meta.' });
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    }
  };

  if (!cfg) return <div className="page muted">Carregando…</div>;

  const connected = cfg.connectedVia === 'oauth';

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h1">Meta ADS</h1>
          <p className="sub">Resumo da conta de anúncios e retorno de leads qualificados para a Meta.</p>
        </div>
      </div>

      {/* Login direto com o Meta (OAuth) */}
      {cfg.oauthAvailable && (
        <div className="card" style={{ marginBottom: 14 }}>
          {connected ? (
            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div className="row" style={{ gap: 10 }}>
                <span className="pill ok">
                  <Icon name="share" size={14} /> Conectado
                </span>
                <div>
                  <b>{cfg.connectedName || 'Conta do Meta'}</b>
                  <div className="muted small">
                    {cfg.adAccountName ? `Conta: ${cfg.adAccountName}` : cfg.adAccountId || 'Escolha a conta de anúncios'}
                  </div>
                </div>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {accounts.length > 1 && (
                  <select value={cfg.adAccountId} onChange={(e) => pickAccount(e.target.value)} style={{ maxWidth: 260 }}>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                )}
                <button onClick={connectMeta} disabled={connecting}>
                  Reconectar
                </button>
                <button className="danger-text" onClick={disconnectMeta}>
                  Desconectar
                </button>
              </div>
            </div>
          ) : (
            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div>
                <h3 className="card-title" style={{ margin: 0 }}>
                  <Icon name="share" /> Conectar com o Meta
                </h3>
                <span className="muted small">
                  Faça login com a conta do Facebook/Meta do cliente e o LawHub puxa a conta de anúncios e os dados automaticamente —
                  sem colar token.
                </span>
              </div>
              <button className="primary" onClick={connectMeta} disabled={connecting}>
                <Icon name="share" size={16} /> {connecting ? 'Abrindo…' : 'Entrar com o Meta'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Resumo da conta */}
      <div className="kpis">
        <Kpi label="Investimento (30d)" value={sum?.configured && sum.spend != null ? BRL(sum.spend) : '—'} hint="últimos 30 dias" icon="share" />
        <Kpi label="Leads" value={sum?.configured && sum.leads != null ? NUM(sum.leads) : '—'} hint="resultados" icon="users" />
        <Kpi label="Cliques" value={sum?.configured && sum.clicks != null ? NUM(sum.clicks) : '—'} hint="no anúncio" icon="right" />
        <Kpi label="Impressões" value={sum?.configured && sum.impressions != null ? NUM(sum.impressions) : '—'} hint="alcance" icon="grid" />
        <Kpi label="CPC" value={sum?.configured && sum.cpc != null ? BRL(sum.cpc) : '—'} hint="custo por clique" icon="crm" />
      </div>

      {sum && !sum.configured && (
        <div className="alert" style={{ marginTop: 12 }}>
          Configure o ID da conta de anúncios e o token abaixo para ver os dados.
        </div>
      )}
      {sum?.error && <div className="alert" style={{ marginTop: 12 }}>{sum.error}</div>}

      <div className="grid2" style={{ marginTop: 14 }}>
        {sum?.configured && sum.campaigns && (
          <div className="card">
            <h3 className="card-title">
              <Icon name="list" /> Campanhas {loadingSum && <span className="muted small">atualizando…</span>}
            </h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Campanha</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {sum.campaigns.map((c, i) => (
                  <tr key={i}>
                    <td>{c.name}</td>
                    <td>
                      <span className={`pill ${/ACTIVE/i.test(c.status) ? 'ok' : ''}`}>{c.status}</span>
                    </td>
                  </tr>
                ))}
                {sum.campaigns.length === 0 && (
                  <tr>
                    <td colSpan={2} className="muted">Nenhuma campanha.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Configuração + Conversions API */}
        <div className="card stack">
          <h3 className="card-title">
            <Icon name="settings" /> Conexão e retorno de leads
          </h3>

          {(!cfg.oauthAvailable || showAdvanced) && (
            <>
              <div className="field-sm">
                <span>ID da conta de anúncios (act_…)</span>
                <input value={cfg.adAccountId} onChange={(e) => setCfg({ ...cfg, adAccountId: e.target.value })} placeholder="act_123456789" />
              </div>
              <div className="field-sm">
                <span>Token (System User, com ads_read e CAPI)</span>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={cfg.hasToken ? '•••••••• (salvo — deixe em branco para manter)' : 'cole o token'}
                  autoComplete="off"
                />
              </div>
            </>
          )}
          {cfg.oauthAvailable && (
            <button
              className="small"
              style={{ alignSelf: 'flex-start', padding: 0, background: 'none', border: 0, color: 'var(--brand, #2563eb)', cursor: 'pointer' }}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? '− Ocultar modo manual (token)' : '+ Modo manual (colar token)'}
            </button>
          )}

          <hr style={{ border: 0, borderTop: '1px solid var(--g-200)', margin: '4px 0' }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={cfg.capiEnabled} onChange={(e) => setCfg({ ...cfg, capiEnabled: e.target.checked })} style={{ width: 16, flex: 'none' }} />
            Devolver ao Meta quando o lead chega na etapa qualificada (Conversions API)
          </label>
          <div className="duo">
            <div className="field-sm">
              <span>Etapa que conta como "qualificado"</span>
              <select value={cfg.qualifiedStageId} onChange={(e) => setCfg({ ...cfg, qualifiedStageId: e.target.value })}>
                <option value="">Selecione…</option>
                {cfg.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field-sm">
              <span>Pixel / Dataset ID</span>
              <input value={cfg.pixelId} onChange={(e) => setCfg({ ...cfg, pixelId: e.target.value })} placeholder="123456789" />
            </div>
          </div>
          <div className="field-sm">
            <span>Nome do evento</span>
            <input value={cfg.eventName} onChange={(e) => setCfg({ ...cfg, eventName: e.target.value })} placeholder="Lead" style={{ maxWidth: 220 }} />
          </div>
          <span className="muted small">
            A atribuição ao anúncio usa o <b>ctwa_clid</b> capturado automaticamente quando o lead vem de um anúncio Click-to-WhatsApp
            (funciona na API Oficial).
          </span>

          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="primary" onClick={save}>
              Salvar
            </button>
            <button onClick={testCapi}>Testar evento</button>
            {msg && <span className={`small ${msg.ok ? 'ok-text' : 'late-text'}`}>{msg.text}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================= Google Ads ============================= */
export function GoogleAds() {
  const [cfg, setCfg] = useState<Awaited<ReturnType<typeof api.adsGoogle>> | null>(null);
  const [devToken, setDevToken] = useState('');
  const [refresh, setRefresh] = useState('');
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => api.adsGoogle().then(setCfg).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    if (!cfg) return;
    setMsg(null);
    try {
      await api.adsGoogleSave({
        customerId: cfg.customerId,
        clientId: cfg.clientId,
        ...(devToken.trim() ? { developerToken: devToken.trim() } : {}),
        ...(refresh.trim() ? { refreshToken: refresh.trim() } : {}),
        ...(secret.trim() ? { clientSecret: secret.trim() } : {}),
      });
      setDevToken('');
      setRefresh('');
      setSecret('');
      setMsg({ ok: true, text: 'Salvo.' });
      load();
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    }
  };

  if (!cfg) return <div className="page muted">Carregando…</div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h1">Google ADS</h1>
          <p className="sub">Conecte a conta do Google Ads do cliente para o resumo.</p>
        </div>
      </div>

      <div className="alert" style={{ marginBottom: 14 }}>
        A integração do Google Ads exige credenciais de API (developer token + OAuth). Preencha abaixo; o resumo de dados é
        liberado assim que as credenciais forem validadas.
      </div>

      <div className="card stack" style={{ maxWidth: 640 }}>
        <h3 className="card-title">
          <Icon name="settings" /> Credenciais do Google Ads
        </h3>
        <div className="field-sm">
          <span>Customer ID (ex.: 123-456-7890)</span>
          <input value={cfg.customerId} onChange={(e) => setCfg({ ...cfg, customerId: e.target.value })} placeholder="123-456-7890" />
        </div>
        <div className="field-sm">
          <span>OAuth Client ID</span>
          <input value={cfg.clientId} onChange={(e) => setCfg({ ...cfg, clientId: e.target.value })} placeholder="....apps.googleusercontent.com" />
        </div>
        <div className="duo">
          <div className="field-sm">
            <span>Client Secret</span>
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={cfg.hasClientSecret ? '•••••••• (salvo)' : 'cole aqui'} autoComplete="off" />
          </div>
          <div className="field-sm">
            <span>Developer Token</span>
            <input type="password" value={devToken} onChange={(e) => setDevToken(e.target.value)} placeholder={cfg.hasDeveloperToken ? '•••••••• (salvo)' : 'cole aqui'} autoComplete="off" />
          </div>
        </div>
        <div className="field-sm">
          <span>Refresh Token (OAuth)</span>
          <input type="password" value={refresh} onChange={(e) => setRefresh(e.target.value)} placeholder={cfg.hasRefreshToken ? '•••••••• (salvo)' : 'cole aqui'} autoComplete="off" />
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="primary" onClick={save}>
            Salvar credenciais
          </button>
          {msg && <span className={`small ${msg.ok ? 'ok-text' : 'late-text'}`}>{msg.text}</span>}
        </div>
      </div>
    </div>
  );
}
