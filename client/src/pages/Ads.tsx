import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { Icon } from '../icons';
import { Kpi } from './Home';

// Ordena campanhas com as ATIVAS primeiro (ENABLED/ACTIVE), mantendo o resto depois.
const activeFirst = <T extends { status?: string }>(arr: T[]): T[] =>
  [...arr].sort(
    (a, b) => (/ENABLED|ACTIVE/i.test(b.status || '') ? 1 : 0) - (/ENABLED|ACTIVE/i.test(a.status || '') ? 1 : 0),
  );

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
              <Icon name="list" /> Campanhas <span className="muted small">({sum.campaigns.length})</span> {loadingSum && <span className="muted small">atualizando…</span>}
            </h3>
            <div className="camp-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Campanha</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {activeFirst(sum.campaigns).map((c, i) => (
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
  const [sum, setSum] = useState<Awaited<ReturnType<typeof api.adsGoogleSummary>> | null>(null);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [convActions, setConvActions] = useState<{ id: string; name: string }[]>([]);
  const [devToken, setDevToken] = useState('');
  const [refresh, setRefresh] = useState('');
  const [secret, setSecret] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const load = () => api.adsGoogle().then(setCfg).catch(() => {});
  const loadSum = () => api.adsGoogleSummary().then(setSum).catch(() => {});
  const loadCustomers = () =>
    api
      .adsGoogleCustomers()
      .then((r) => setCustomers(r.customers || []))
      .catch(() => {});
  const loadConvActions = () =>
    api
      .adsGoogleConversionActions()
      .then((r) => setConvActions(r.actions || []))
      .catch(() => {});
  useEffect(() => {
    load();
    loadSum();
    loadCustomers();
    loadConvActions();
    const p = new URLSearchParams(window.location.search);
    const r = p.get('googleads');
    if (r) {
      setMsg(
        r === 'ok'
          ? { ok: true, text: 'Conta do Google conectada!' }
          : { ok: false, text: r === 'cancelado' ? 'Login cancelado.' : 'Não foi possível conectar. Tente novamente.' },
      );
      window.history.replaceState({}, '', window.location.pathname);
    }
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
      loadSum();
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    }
  };
  const connectGoogle = async () => {
    setConnecting(true);
    setMsg(null);
    try {
      const r = await api.adsGoogleOauthUrl();
      if (r.available && r.url) window.location.href = r.url;
      else setMsg({ ok: false, text: 'Login com o Google não está disponível neste servidor.' });
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    } finally {
      setConnecting(false);
    }
  };
  const disconnectGoogle = async () => {
    if (!confirm('Desconectar a conta do Google? O resumo para até reconectar.')) return;
    await api.adsGoogleDisconnect().catch(() => {});
    setCustomers([]);
    setMsg({ ok: true, text: 'Conta desconectada.' });
    load();
    loadSum();
  };
  const pickCustomer = async (id: string) => {
    const c = customers.find((x) => x.id === id);
    await api.adsGoogleSave({ customerId: id, customerName: c?.name || '' }).catch(() => {});
    setCfg((prev) => (prev ? { ...prev, customerId: id, customerName: c?.name || '' } : prev));
    loadSum();
    loadConvActions();
  };
  // MCC global: salva só o Customer ID (a conta do cliente dentro da MCC).
  // Se havia uma conexão pessoal (OAuth), remove para usar as credenciais da MCC.
  const saveClientAccount = async () => {
    if (!cfg) return;
    setMsg(null);
    try {
      if (cfg.connectedVia === 'oauth') await api.adsGoogleDisconnect().catch(() => {});
      await api.adsGoogleSave({ customerId: cfg.customerId.trim(), customerName: '' });
      setMsg({ ok: true, text: 'Conta do cliente salva.' });
      load();
      loadSum();
      loadConvActions();
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    }
  };
  const saveConv = async () => {
    if (!cfg) return;
    setMsg(null);
    try {
      const action = convActions.find((a) => a.id === cfg.conversionActionId);
      await api.adsGoogleSave({
        conversionsEnabled: cfg.conversionsEnabled,
        qualifiedStageId: cfg.qualifiedStageId,
        conversionActionId: cfg.conversionActionId,
        conversionName: action?.name || cfg.conversionName,
      });
      setMsg({ ok: true, text: 'Retorno de conversões salvo.' });
      load();
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    }
  };
  const testConv = async () => {
    setMsg(null);
    try {
      await api.adsGoogleTestConversion();
      setMsg({ ok: true, text: 'Conversão de teste enviada ao Google.' });
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
          <h1 className="h1">Google ADS</h1>
          <p className="sub">Conecte a conta do Google Ads do cliente e veja o resumo.</p>
        </div>
      </div>

      {/* Login direto com o Google (OAuth) — só quando NÃO há MCC global. */}
      {cfg.oauthAvailable && !cfg.globalReady && (
        <div className="card" style={{ marginBottom: 14 }}>
          {connected ? (
            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div className="row" style={{ gap: 10 }}>
                <span className="pill ok">
                  <Icon name="grid" size={14} /> Conectado
                </span>
                <div>
                  <b>{cfg.connectedEmail || 'Conta do Google'}</b>
                  <div className="muted small">{cfg.customerName ? `Conta: ${cfg.customerName}` : cfg.customerId || 'Escolha a conta'}</div>
                </div>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {customers.length > 1 && (
                  <select value={cfg.customerId} onChange={(e) => pickCustomer(e.target.value)} style={{ maxWidth: 260 }}>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                )}
                <button onClick={connectGoogle} disabled={connecting}>
                  Reconectar
                </button>
                <button className="danger-text" onClick={disconnectGoogle}>
                  Desconectar
                </button>
              </div>
            </div>
          ) : (
            <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
              <div>
                <h3 className="card-title" style={{ margin: 0 }}>
                  <Icon name="grid" /> Conectar com o Google
                </h3>
                <span className="muted small">Faça login com a conta do Google do cliente — sem colar refresh token.</span>
              </div>
              <button className="primary" onClick={connectGoogle} disabled={connecting}>
                <Icon name="grid" size={16} /> {connecting ? 'Abrindo…' : 'Entrar com o Google'}
              </button>
            </div>
          )}
          {connected && !cfg.developerTokenReady && (
            <div className="alert" style={{ marginTop: 10 }}>
              Login feito, mas o <b>developer token</b> do Google Ads ainda não está configurado no servidor — o resumo fica
              indisponível até o admin definir <code>GOOGLE_ADS_DEVELOPER_TOKEN</code>.
            </div>
          )}
        </div>
      )}

      {/* MCC global no servidor: você só digita o Customer ID da conta do cliente. */}
      {cfg.globalReady && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
            <div>
              <h3 className="card-title" style={{ margin: 0 }}>
                <Icon name="grid" /> Conta do cliente (na sua MCC)
              </h3>
              <span className="muted small">
                As credenciais da MCC já estão no servidor — informe só o <b>Customer ID</b> da conta deste cliente dentro da MCC.
              </span>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                value={cfg.customerId}
                onChange={(e) => setCfg({ ...cfg, customerId: e.target.value })}
                placeholder="123-456-7890"
                style={{ maxWidth: 200 }}
              />
              <button className="primary" onClick={saveClientAccount} disabled={!cfg.customerId.trim()}>
                Salvar
              </button>
            </div>
          </div>
          {cfg.connectedVia === 'oauth' && (
            <span className="muted small" style={{ marginTop: 8, display: 'block' }}>
              Há uma conexão pessoal ({cfg.connectedEmail}) ativa — ao salvar, ela é removida e passa a usar as credenciais da MCC.
            </span>
          )}
        </div>
      )}

      {/* Resumo da conta */}
      <div className="kpis">
        <Kpi label="Investimento (30d)" value={sum?.configured && sum.spend != null ? BRL(sum.spend) : '—'} hint="últimos 30 dias" icon="grid" />
        <Kpi label="Conversões" value={sum?.configured && sum.conversions != null ? NUM(Math.round(sum.conversions)) : '—'} hint="resultados" icon="users" />
        <Kpi label="Cliques" value={sum?.configured && sum.clicks != null ? NUM(sum.clicks) : '—'} hint="no anúncio" icon="right" />
        <Kpi label="Impressões" value={sum?.configured && sum.impressions != null ? NUM(sum.impressions) : '—'} hint="alcance" icon="grid" />
        <Kpi label="CPC" value={sum?.configured && sum.cpc != null ? BRL(sum.cpc) : '—'} hint="custo por clique" icon="crm" />
      </div>
      {sum?.error && <div className="alert" style={{ marginTop: 12 }}>{sum.error}</div>}

      <div className="grid2" style={{ marginTop: 14 }}>
        {sum?.configured && sum.campaigns && (
          <div className="card">
            <h3 className="card-title">
              <Icon name="list" /> Campanhas <span className="muted small">({sum.campaigns.length})</span>
            </h3>
            <div className="camp-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Campanha</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {activeFirst(sum.campaigns).map((c, i) => (
                    <tr key={i}>
                      <td>{c.name}</td>
                      <td>
                        <span className={`pill ${/ENABLED/i.test(c.status) ? 'ok' : ''}`}>{c.status}</span>
                      </td>
                    </tr>
                  ))}
                  {sum.campaigns.length === 0 && (
                    <tr>
                      <td colSpan={2} className="muted">Nenhuma campanha nos últimos 30 dias.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Retorno de conversões (lead qualificado → Google Ads) */}
        <div className="card stack">
          <h3 className="card-title">
            <Icon name="crm" /> Retorno de leads qualificados
          </h3>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={cfg.conversionsEnabled}
              onChange={(e) => setCfg({ ...cfg, conversionsEnabled: e.target.checked })}
              style={{ width: 16, flex: 'none' }}
            />
            Enviar conversão ao Google quando o lead chega na etapa qualificada
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
              <span>Ação de conversão</span>
              {convActions.length > 0 ? (
                <select value={cfg.conversionActionId} onChange={(e) => setCfg({ ...cfg, conversionActionId: e.target.value })}>
                  <option value="">Selecione…</option>
                  {convActions.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={cfg.conversionActionId}
                  onChange={(e) => setCfg({ ...cfg, conversionActionId: e.target.value })}
                  placeholder="ID da ação de conversão"
                />
              )}
            </div>
          </div>
          <span className="muted small">
            Usa <b>Enhanced Conversions for Leads</b> (telefone com hash) — a ação de conversão precisa estar criada na conta do
            Google Ads e habilitada para esse uso. Sem gclid, a atribuição é por dados do lead.
          </span>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="primary" onClick={saveConv}>
              Salvar
            </button>
            <button onClick={testConv}>Testar conversão</button>
            {msg && <span className={`small ${msg.ok ? 'ok-text' : 'late-text'}`}>{msg.text}</span>}
          </div>
        </div>

        {/* Modo manual (credenciais) — fallback quando não há OAuth nem MCC global. */}
        {(!cfg.oauthAvailable && !cfg.globalReady) || showAdvanced ? (
          <div className="card stack">
            <h3 className="card-title">
              <Icon name="settings" /> Credenciais do Google Ads (manual)
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
        ) : null}
      </div>

      <div className="row" style={{ gap: 12, marginTop: 10, alignItems: 'center' }}>
        {(cfg.oauthAvailable || cfg.globalReady) && (
          <button
            className="small"
            style={{ padding: 0, background: 'none', border: 0, color: 'var(--brand, #2563eb)', cursor: 'pointer' }}
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? '− Ocultar modo manual (credenciais)' : '+ Modo manual (colar credenciais)'}
          </button>
        )}
        {msg && !showAdvanced && <span className={`small ${msg.ok ? 'ok-text' : 'late-text'}`}>{msg.text}</span>}
      </div>
    </div>
  );
}

/* ===================== Meta ADS — Detalhamento ===================== */
const PRESETS: { id: string; label: string }[] = [
  { id: 'today', label: 'Hoje' },
  { id: 'yesterday', label: 'Ontem' },
  { id: 'last_7d', label: '7 dias' },
  { id: 'last_30d', label: '30 dias' },
  { id: 'this_month', label: 'Este mês' },
  { id: 'maximum', label: 'Máximo' },
];
const isLive = (s?: string) => /ACTIVE|ENABLED/i.test(s || '');

function MetricCells({ n }: { n: { spend: number; impressions: number; clicks: number; leads: number; cpc: number } }) {
  const cpl = n.leads ? n.spend / n.leads : 0;
  return (
    <>
      <td className="num col-lead">{NUM(n.leads)}</td>
      <td className="num col-cpl">{cpl ? BRL(cpl) : '—'}</td>
      <td className="num col-cost">{BRL(n.spend)}</td>
      <td className="num">{NUM(n.impressions)}</td>
      <td className="num">{NUM(n.clicks)}</td>
      <td className="num">{n.cpc ? BRL(n.cpc) : '—'}</td>
    </>
  );
}

function BreakdownView({
  fetcher,
  title,
  midLabel,
  hint,
}: {
  fetcher: (preset: string) => Promise<{ configured: boolean; error?: string; campaigns?: import('../api').MetaAdNode[] }>;
  title: string;
  midLabel: string;
  hint: string;
}) {
  const [preset, setPreset] = useState('last_30d');
  const [data, setData] = useState<Awaited<ReturnType<typeof fetcher>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const load = (p = preset) => {
    setLoading(true);
    fetcher(p)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load(preset); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const campaigns = data?.campaigns ?? [];

  return (
    <div className="page" style={{ paddingTop: 10 }}>
      <div className="page-head">
        <div>
          <h2 className="h1" style={{ fontSize: 18 }}>{title}</h2>
          <p className="sub">Campanhas, {midLabel.toLowerCase()}s e anúncios com métricas. Em cache ~5 min para não sobrecarregar a API.</p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select value={preset} onChange={(e) => setPreset(e.target.value)} style={{ maxWidth: 160 }}>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <button onClick={() => load(preset)} disabled={loading}>
            <Icon name="refresh" size={14} /> {loading ? 'Atualizando…' : 'Atualizar'}
          </button>
        </div>
      </div>

      {data && !data.configured && <div className="alert">{hint}</div>}
      {data?.error && <div className="alert">{data.error}</div>}

      {data?.configured && (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table className="table tree-table">
            <thead>
              <tr>
                <th>Campanha / {midLabel} / Anúncio</th>
                <th>Status</th>
                <th className="num col-lead">Leads</th>
                <th className="num col-cpl">Custo/Lead</th>
                <th className="num col-cost">Custo</th>
                <th className="num">Impressões</th>
                <th className="num">Cliques</th>
                <th className="num">CPC</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((camp) => {
                const cOpen = open.has(camp.id);
                return (
                  <FragmentRows key={camp.id}>
                    <tr className="tree-row lvl-camp" onClick={() => toggle(camp.id)}>
                      <td>
                        <span className="tree-name">
                          <Icon name={cOpen ? 'chev' : 'right'} size={13} />
                          <b>{camp.name}</b>
                        </span>
                      </td>
                      <td>
                        <span className={`pill ${isLive(camp.status) ? 'ok' : ''}`}>{camp.status || '—'}</span>
                      </td>
                      <MetricCells n={camp} />
                    </tr>
                    {cOpen &&
                      (camp.adsets ?? []).map((adset) => {
                        const aOpen = open.has(adset.id);
                        return (
                          <FragmentRows key={adset.id}>
                            <tr className="tree-row lvl-adset" onClick={() => toggle(adset.id)}>
                              <td>
                                <span className="tree-name" style={{ paddingLeft: 20 }}>
                                  <Icon name={aOpen ? 'chev' : 'right'} size={12} />
                                  {adset.name}
                                </span>
                              </td>
                              <td>
                                <span className={`pill ${isLive(adset.status) ? 'ok' : ''}`}>{adset.status || '—'}</span>
                              </td>
                              <MetricCells n={adset} />
                            </tr>
                            {aOpen &&
                              (adset.ads ?? []).map((ad) => (
                                <tr key={ad.id} className="tree-row lvl-ad">
                                  <td>
                                    <span className="tree-name" style={{ paddingLeft: 42 }}>
                                      <Icon name="doc" size={12} /> {ad.name}
                                    </span>
                                  </td>
                                  <td>
                                    <span className={`pill ${isLive(ad.status) ? 'ok' : ''}`}>{ad.status || '—'}</span>
                                  </td>
                                  <MetricCells n={ad} />
                                </tr>
                              ))}
                          </FragmentRows>
                        );
                      })}
                  </FragmentRows>
                );
              })}
              {campaigns.length === 0 && !loading && (
                <tr>
                  <td colSpan={8} className="muted">Nenhum dado no período.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Agrupa linhas sem adicionar nós ao DOM (tabela).
function FragmentRows({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/* ===================== Marketing (Meta + Google) ===================== */
export function Marketing() {
  const [net, setNet] = useState<'meta' | 'google'>(() => ((localStorage.getItem('lawhub.mkt.net') as 'meta' | 'google') || 'meta'));
  const [view, setView] = useState<'resumo' | 'detalhes'>('resumo');
  const pickNet = (n: 'meta' | 'google') => {
    setNet(n);
    localStorage.setItem('lawhub.mkt.net', n);
  };

  return (
    <>
      <div className="mkt-bar">
        <div className="segmented">
          <button className={net === 'meta' ? 'active' : ''} onClick={() => pickNet('meta')}>
            <Icon name="share" size={15} /> Meta
          </button>
          <button className={net === 'google' ? 'active' : ''} onClick={() => pickNet('google')}>
            <Icon name="grid" size={15} /> Google
          </button>
        </div>
        <div className="segmented">
          <button className={view === 'resumo' ? 'active' : ''} onClick={() => setView('resumo')}>
            Resumo
          </button>
          <button className={view === 'detalhes' ? 'active' : ''} onClick={() => setView('detalhes')}>
            Detalhamento
          </button>
        </div>
      </div>

      {net === 'meta' && view === 'resumo' && <MetaAds />}
      {net === 'meta' && view === 'detalhes' && (
        <BreakdownView
          fetcher={(p) => api.adsMetaBreakdown(p)}
          title="Meta · Detalhamento"
          midLabel="Conjunto"
          hint="Conecte a conta em Meta · Resumo primeiro (login com o Meta ou token)."
        />
      )}
      {net === 'google' && view === 'resumo' && <GoogleAds />}
      {net === 'google' && view === 'detalhes' && (
        <BreakdownView
          fetcher={(p) => api.adsGoogleBreakdown(p)}
          title="Google · Detalhamento"
          midLabel="Grupo"
          hint="Conecte a conta em Google · Resumo primeiro (login com o Google)."
        />
      )}
    </>
  );
}
