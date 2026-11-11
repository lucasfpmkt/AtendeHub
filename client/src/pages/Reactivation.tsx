import { useEffect, useState } from 'react';
import { api, type ReactivationItem, type ReactivationJob } from '../api';
import { Icon } from '../icons';

const STATUS: Record<ReactivationItem['status'], { label: string; cls: string }> = {
  pending: { label: 'vai enviar', cls: 'ok' },
  sent: { label: 'enviada', cls: 'ok' },
  excluded: { label: 'fora da lista', cls: 'warn' },
  skipped: { label: 'pulada', cls: 'warn' },
  failed: { label: 'falhou', cls: 'late' },
};

const fmt = (d?: string | null) => (d ? new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '');

/**
 * Reativação de leads antigos: a IA escreve uma mensagem personalizada para cada lead
 * parado; a equipe revisa e o envio sai aos poucos, em horário comercial.
 */
export function Reactivation({ connected }: { connected: boolean }) {
  const [job, setJob] = useState<ReactivationJob | null>(null);
  // Etapas de TODOS os funis do cliente (a página de campanhas carrega só o primeiro).
  const [stages, setStages] = useState<{ id: string; name: string; funnelName: string }[]>([]);
  const [stageIds, setStageIds] = useState<string[]>([]);
  const [minDays, setMinDays] = useState(3);
  const [maxDays, setMaxDays] = useState(90);
  const [limit, setLimit] = useState(50);
  const [perHour, setPerHour] = useState(20);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = () => api.reactivation().then((r) => setJob(r.job)).catch(() => {});
  useEffect(() => {
    load();
    api.stages().then(setStages).catch(() => {});
  }, []);
  // Enquanto gera ou envia, atualiza sozinho.
  useEffect(() => {
    if (!job || !['generating', 'running'].includes(job.status)) return;
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [job?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr('');
    try {
      await fn();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const gerar = () =>
    run(async () => {
      const r = await api.reactivationCreate({ stageIds, minDays, maxDays, limit });
      setJob(r.job);
    });

  const saveText = (it: ReactivationItem) =>
    run(async () => {
      const text = drafts[it.id];
      if (text === undefined || text === it.text) return;
      await api.reactivationItem(it.id, { text });
      await load();
    });

  const toggle = (it: ReactivationItem) =>
    run(async () => {
      await api.reactivationItem(it.id, { status: it.status === 'pending' ? 'excluded' : 'pending', text: drafts[it.id] });
      await load();
    });

  const act = (action: 'start' | 'pause' | 'cancel') =>
    run(async () => {
      if (action === 'start' && !confirm(`Enviar ${job!.counts.pending} mensagens, ${perHour} por hora, em horário comercial (seg–sáb, 8h–20h)?`)) return;
      if (action === 'cancel' && !confirm('Descartar esta reativação? O que já foi enviado continua enviado.')) return;
      const r = await api.reactivationAction(job!.id, action, perHour);
      setJob(r.job);
    });

  const editable = job && ['draft', 'paused'].includes(job.status);
  const pipelineStages = stages.filter((s) => !/perdid|fechad|ganh|desqualific|assinad|cliente|sem interesse|n[aã]o tem interesse/i.test(s.name));

  return (
    <div className="card stack" style={{ marginBottom: 14 }}>
      <h3 className="card-title">
        <Icon name="refresh" /> Reativar leads antigos
      </h3>
      <p className="muted small">
        Para quem conversou e esfriou. A IA lê a conversa de cada lead e escreve uma mensagem só para ele, citando o que ele contou e
        terminando com uma pergunta fácil. Ela pula robôs de empresa e quem já disse que não quer. Você revisa tudo antes, e o envio sai
        aos poucos em horário comercial. Quem responder volta para a IA. Quem disser que não tem interesse vai para Perdido.
      </p>

      {!job && (
        <>
          <div className="field-sm">
            <span>Etapas do funil (nenhuma marcada = todas as etapas em andamento)</span>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {pipelineStages.map((s) => (
                <label key={s.id} className={`chip ${stageIds.includes(s.id) ? 'on' : ''}`} style={{ cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={stageIds.includes(s.id)}
                    onChange={(e) => setStageIds((v) => (e.target.checked ? [...v, s.id] : v.filter((x) => x !== s.id)))}
                    style={{ marginRight: 4 }}
                  />
                  {s.name}
                  {s.funnelName ? <span className="muted"> · {s.funnelName}</span> : null}
                </label>
              ))}
            </div>
          </div>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <label className="field-sm" style={{ width: 150 }}>
              <span>Parado há pelo menos</span>
              <input type="number" min={1} value={minDays} onChange={(e) => setMinDays(Number(e.target.value))} /> dias
            </label>
            <label className="field-sm" style={{ width: 150 }}>
              <span>e no máximo</span>
              <input type="number" min={2} value={maxDays} onChange={(e) => setMaxDays(Number(e.target.value))} /> dias
            </label>
            <label className="field-sm" style={{ width: 150 }}>
              <span>Até quantos leads</span>
              <input type="number" min={1} max={200} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
            </label>
          </div>
          <div>
            <button className="primary" onClick={gerar} disabled={busy}>
              <Icon name="sparkle" /> Gerar mensagens para revisar
            </button>
          </div>
        </>
      )}

      {job && (
        <>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className={`pill ${job.status === 'running' ? 'ok' : job.status === 'generating' ? 'warn' : ''}`}>
              {
                {
                  generating: `Escrevendo as mensagens… (${job.items.length} prontas)`,
                  draft: 'Pronta para revisar',
                  running: `Enviando · ${job.perHour}/hora`,
                  paused: 'Pausada',
                  done: 'Concluída',
                  canceled: 'Cancelada',
                }[job.status]
              }
            </span>
            <span className="muted small">
              {job.counts.sent} enviadas · {job.counts.pending} na fila · {job.counts.excluded} fora da lista
              {job.counts.skipped ? ` · ${job.counts.skipped} puladas` : ''}
              {job.counts.failed ? ` · ${job.counts.failed} falharam` : ''}
            </span>
          </div>

          {editable && (
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <label className="field-sm" style={{ width: 160 }}>
                <span>Mensagens por hora</span>
                <input type="number" min={5} max={40} value={perHour} onChange={(e) => setPerHour(Number(e.target.value))} />
              </label>
              <button className="primary" onClick={() => act('start')} disabled={busy || !connected || job.counts.pending === 0}>
                <Icon name="send" /> {job.status === 'paused' ? 'Retomar envio' : 'Iniciar envio'}
              </button>
              <button onClick={() => act('cancel')} disabled={busy}>
                Descartar
              </button>
              {!connected && <span className="late-text small">Conecte o WhatsApp para enviar.</span>}
            </div>
          )}
          {job.status === 'running' && (
            <div className="row" style={{ gap: 8 }}>
              <button onClick={() => act('pause')} disabled={busy}>
                Pausar
              </button>
            </div>
          )}
          {['done', 'generating'].includes(job.status) && (
            <div className="row" style={{ gap: 8 }}>
              <button onClick={() => act('cancel')} disabled={busy}>
                {job.status === 'done' ? 'Nova reativação' : 'Cancelar'}
              </button>
            </div>
          )}

          <div className="stack" style={{ gap: 8, maxHeight: 620, overflowY: 'auto' }}>
            {job.items.map((it) => (
              <div key={it.id} className="card" style={{ padding: 10, opacity: it.status === 'excluded' ? 0.65 : 1 }}>
                <div className="row between" style={{ gap: 8 }}>
                  <b>{it.name}</b>
                  <span className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <span className="muted small">parado desde {fmt(it.lastActivity)}</span>
                    <span className={`pill ${STATUS[it.status].cls}`}>{STATUS[it.status].label}</span>
                  </span>
                </div>
                {it.context && <div className="muted small">{it.context}</div>}
                {it.note && <div className="small late-text">{it.note}</div>}
                {editable && ['pending', 'excluded'].includes(it.status) ? (
                  <>
                    <textarea
                      rows={3}
                      value={drafts[it.id] ?? it.text}
                      onChange={(e) => setDrafts((d) => ({ ...d, [it.id]: e.target.value }))}
                      onBlur={() => saveText(it)}
                      style={{ width: '100%', marginTop: 6 }}
                    />
                    <div className="row" style={{ gap: 8, marginTop: 4 }}>
                      <button className="sm" onClick={() => toggle(it)} disabled={busy}>
                        {it.status === 'pending' ? 'Tirar da lista' : 'Incluir na lista'}
                      </button>
                    </div>
                  </>
                ) : (
                  it.text && <div style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{it.text}</div>
                )}
              </div>
            ))}
            {job.status === 'generating' && job.items.length === 0 && <div className="muted small">Lendo as conversas… isso leva alguns segundos por lead.</div>}
            {job.status !== 'generating' && job.items.length === 0 && <div className="muted small">Nenhum lead parado com esses filtros.</div>}
          </div>
        </>
      )}
      {err && <div className="alert">{err}</div>}
    </div>
  );
}
