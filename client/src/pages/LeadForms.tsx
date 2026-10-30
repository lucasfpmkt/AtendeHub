import { useEffect, useState } from 'react';
import { api, type LeadFormsConfig } from '../api';
import { Icon } from '../icons';
import { Switch } from './Agents';

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

const phoneFmt = (d: string) => {
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) {
    const rest = d.slice(4);
    return `(${d.slice(2, 4)}) ${rest.slice(0, rest.length - 4)}-${rest.slice(-4)}`;
  }
  return d ? `+${d}` : '—';
};

const EXAMPLE = `{
  "nome": "Maria Souza",
  "telefone": "11999990000",
  "email": "maria@email.com",
  "campanha": "BPC LOAS",
  "formulario": "Formulário BPC",
  "Qual o seu problema?": "Benefício negado pelo INSS"
}`;

/** Formulários do Meta (Lead Ads) e entrada externa → contatos e negócios no CRM. */
export function LeadForms() {
  const [cfg, setCfg] = useState<LeadFormsConfig | null>(null);
  const [pages, setPages] = useState<{ id: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState('');
  const [showSetup, setShowSetup] = useState(false);

  const load = () => api.leadForms().then(setCfg);
  useEffect(() => {
    load().catch((e) => setMsg({ ok: false, text: (e as Error).message }));
  }, []);
  useEffect(() => {
    if (cfg?.metaConnected && cfg.scopesOk && pages === null) {
      api
        .leadFormPages()
        .then((r) => setPages(r.pages))
        .catch((e) => {
          setPages([]);
          setMsg({ ok: false, text: (e as Error).message });
        });
    }
  }, [cfg, pages]);

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setMsg(null);
    try {
      const text = await fn();
      await load();
      if (text) setMsg({ ok: true, text });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy('');
    }
  };

  const save = (data: Parameters<typeof api.updateLeadForms>[0], okText?: string) =>
    run('save', async () => {
      const r = await api.updateLeadForms(data);
      if (r.warning) throw new Error(r.warning);
      return okText;
    });

  const connect = async () => {
    const r = await api.adsMetaOauthUrl();
    if (r.available && r.url) window.location.href = r.url;
    else setMsg({ ok: false, text: 'O login com o Meta não está configurado no servidor (FB_APP_ID / FB_APP_SECRET).' });
  };

  const copy = (text: string, key: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(''), 1500);
    });
  };

  if (!cfg) return <div className="page muted">{msg?.text ?? 'Carregando…'}</div>;

  const funnel = cfg.funnels.find((f) => f.id === cfg.funnelId) ?? cfg.funnels[0];
  const ready = cfg.metaConnected && cfg.scopesOk;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h1">Formulários de lead</h1>
          <p className="sub">Cada formulário preenchido nos anúncios do Facebook e Instagram vira contato e negócio no CRM, sem duplicar.</p>
        </div>
      </div>

      {msg && <div className={`lf-msg ${msg.ok ? '' : 'bad'}`}>{msg.text}</div>}

      {/* 1. Conexão */}
      <div className="card lf-card">
        <div className="lf-step">1</div>
        <div className="lf-body">
          <h3>Conexão com o Meta</h3>
          {!cfg.metaConnected ? (
            <>
              <p className="muted small">Entre com a conta do Facebook que administra a página do escritório.</p>
              <button className="primary" onClick={connect} disabled={!cfg.oauthAvailable}>
                <Icon name="share" size={15} /> Conectar com o Meta
              </button>
            </>
          ) : !cfg.scopesOk ? (
            <>
              <p className="lf-warn">
                Conectado{cfg.metaName ? ` como ${cfg.metaName}` : ''}, mas falta liberar a permissão de formulários. Clique em reconectar e
                aceite todas as permissões (páginas e leads).
              </p>
              <button className="primary" onClick={connect}>
                <Icon name="refresh" size={15} /> Reconectar com o Meta
              </button>
            </>
          ) : (
            <p className="row" style={{ gap: 8 }}>
              <span className="pill ok">
                <Icon name="check" size={13} /> Conectado
              </span>
              <span className="muted small">{cfg.metaName || 'Conta do Meta'} · permissões de formulário liberadas</span>
            </p>
          )}
        </div>
      </div>

      {/* 2. Página e destino */}
      <div className={`card lf-card ${ready ? '' : 'lf-off'}`}>
        <div className="lf-step">2</div>
        <div className="lf-body">
          <div className="lf-top">
            <h3>Página e destino no CRM</h3>
            <div className="row" style={{ gap: 10 }}>
              <span className="small muted">{cfg.enabled ? 'Recebendo leads' : 'Desligado'}</span>
              <Switch
                on={cfg.enabled}
                label="Receber leads de formulário"
                onChange={(v) => {
                  if (v && !cfg.pageId) return setMsg({ ok: false, text: 'Escolha a página do Facebook antes de ligar.' });
                  save({ enabled: v }, v ? 'Pronto! Os novos leads de formulário entram no CRM automaticamente.' : 'Captação desligada.');
                }}
              />
            </div>
          </div>

          <div className="lf-grid">
            <label className="field-sm">
              <span>Página do Facebook</span>
              <select
                value={cfg.pageId}
                disabled={!ready || busy !== ''}
                onChange={(e) => e.target.value && save({ pageId: e.target.value }, 'Página conectada aos formulários.')}
              >
                <option value="">{pages === null && ready ? 'Carregando páginas…' : 'Escolha a página'}</option>
                {cfg.pageId && !pages?.some((p) => p.id === cfg.pageId) && <option value={cfg.pageId}>{cfg.pageName}</option>}
                {(pages ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-sm">
              <span>Funil</span>
              <select value={funnel?.id ?? ''} onChange={(e) => save({ funnelId: e.target.value, stageId: '' })}>
                {cfg.funnels.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-sm">
              <span>Etapa de entrada</span>
              <select value={cfg.stageId} onChange={(e) => save({ funnelId: funnel?.id ?? '', stageId: e.target.value })}>
                <option value="">Primeira etapa{funnel?.stages[0] ? ` (${funnel.stages[0].name})` : ''}</option>
                {(funnel?.stages ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="lf-row">
            <Switch on={cfg.notify} onChange={(v) => save({ notify: v })} label="Avisar no WhatsApp" />
            <div>
              <b>Avisar no WhatsApp do escritório</b>
              <div className="muted small">Manda nome, telefone e respostas do lead para o mesmo número do aviso de lead qualificado.</div>
            </div>
          </div>

          <div className="lf-actions">
            <button
              onClick={() =>
                run('sync', async () => {
                  const r = await api.syncLeadForms();
                  return r.created ? `${r.created} lead(s) novo(s) importado(s) dos últimos 7 dias.` : `Nenhum lead novo (${r.found} encontrado(s) nos últimos 7 dias, todos já estavam no CRM).`;
                })
              }
              disabled={!cfg.pageId || busy !== ''}
            >
              <Icon name="refresh" size={15} /> {busy === 'sync' ? 'Buscando…' : 'Buscar leads dos últimos 7 dias'}
            </button>
            <span className="muted small">
              Última verificação: {fmt(cfg.lastPollAt)} · o LawHub confere sozinho a cada 10 minutos
            </span>
          </div>
          {cfg.lastError && <div className="lf-warn small">Último erro do Meta: {cfg.lastError}</div>}
        </div>
      </div>

      {/* Leads recebidos */}
      <div className="card lf-list">
        <h3>Últimos leads recebidos</h3>
        {cfg.entries.length === 0 ? (
          <p className="muted small" style={{ padding: '10px 0 4px' }}>
            Nenhum lead de formulário ainda. Quando chegar, ele aparece aqui e no CRM.
          </p>
        ) : (
          cfg.entries.map((e) => (
            <div key={e.id} className="lf-entry">
              <button type="button" className="lf-entry-main" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                <span className="avatar">{(e.name || '?')[0].toUpperCase()}</span>
                <span className="lf-who">
                  <b>{e.name || 'Sem nome'}</b>
                  <span className="muted small">
                    {phoneFmt(e.phone)}
                    {e.formName ? ` · ${e.formName}` : ''}
                    {e.campaign ? ` · ${e.campaign}` : ''}
                  </span>
                </span>
                <span className="pill">{e.source === 'meta' ? 'Meta' : 'Externo'}</span>
                <span className="muted small lf-when">{fmt(e.createdAt)}</span>
              </button>
              {open === e.id && (
                <div className="lf-answers">
                  {e.email && (
                    <div>
                      <span>E-mail</span>
                      <b>{e.email}</b>
                    </div>
                  )}
                  {e.answers.map((a, i) => (
                    <div key={i}>
                      <span>{a.q}</span>
                      <b>{a.a}</b>
                    </div>
                  ))}
                  {!e.email && e.answers.length === 0 && <div className="muted small">Sem outras respostas.</div>}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Zapier / Make / site */}
      <div className="card lf-card">
        <div className="lf-step">
          <Icon name="link" size={15} />
        </div>
        <div className="lf-body">
          <h3>Zapier, Make ou formulário do site</h3>
          <p className="muted small">
            Funciona hoje, sem depender da aprovação do Meta. No Zapier/Make, use "Facebook Lead Ads → Novo lead" e a ação "Webhook → POST"
            (JSON) para este endereço. Serve também para o formulário do site.
          </p>
          <div className="lf-copy">
            <code>{cfg.hookUrl}</code>
            <button className="soft" onClick={() => copy(cfg.hookUrl, 'hook')}>
              <Icon name="copy" size={14} /> {copied === 'hook' ? 'Copiado' : 'Copiar'}
            </button>
          </div>
          <details className="lf-details">
            <summary>Exemplo do que enviar</summary>
            <pre>{EXAMPLE}</pre>
            <p className="muted small">
              Nome, telefone e e-mail são reconhecidos em português ou inglês (nome/name, telefone/phone, email). Os demais campos viram as
              respostas do lead. Envio repetido do mesmo lead não duplica.
            </p>
          </details>
          <button
            className="danger-text soft"
            onClick={() => {
              if (confirm('Gerar um novo endereço? O atual para de funcionar e será preciso atualizar no Zapier/Make.'))
                run('rotate', async () => {
                  await api.rotateLeadHook();
                  return 'Novo endereço gerado.';
                });
            }}
          >
            Gerar novo endereço
          </button>
        </div>
      </div>

      {/* Configuração única do app */}
      <div className="card lf-list">
        <button type="button" className="lf-setup-toggle" onClick={() => setShowSetup(!showSetup)} aria-expanded={showSetup}>
          <span>
            <b>Aviso instantâneo e liberação no Meta</b>
            <span className="muted small"> · configuração feita uma vez</span>
          </span>
          <Icon name="chev" size={16} />
        </button>
        {showSetup && (
          <div className="lf-setup">
            <p className="small">
              Sem isto os leads chegam pela verificação a cada 10 minutos. Com isto, chegam em segundos.
            </p>
            <ol className="small">
              <li>
                No <b>painel do app do Meta</b> (developers.facebook.com), em <b>Webhooks</b>, escolha <b>Page</b>, clique em <b>Assinar</b>{' '}
                e informe:
                <div className="lf-copy">
                  <code>{cfg.webhookUrl}</code>
                  <button className="soft" onClick={() => copy(cfg.webhookUrl, 'wh')}>
                    {copied === 'wh' ? 'Copiado' : 'Copiar URL'}
                  </button>
                </div>
                <div className="lf-copy">
                  <code>{cfg.verifyToken}</code>
                  <button className="soft" onClick={() => copy(cfg.verifyToken, 'vt')}>
                    {copied === 'vt' ? 'Copiado' : 'Copiar token'}
                  </button>
                </div>
                Depois marque o campo <b>leadgen</b>.
              </li>
              <li>
                Para páginas de clientes (fora da sua empresa), o Meta exige <b>Verificação da empresa</b> e <b>Análise do app</b> das
                permissões <code>leads_retrieval</code>, <code>pages_manage_metadata</code>, <code>pages_show_list</code>,{' '}
                <code>pages_read_engagement</code> e <code>pages_manage_ads</code>.
              </li>
              <li>
                Em cada página: <b>Configurações do negócio › Integrações › Acesso aos leads</b>, libere o app do LawHub (ou deixe sem
                restrição).
              </li>
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
