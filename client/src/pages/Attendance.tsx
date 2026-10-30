import { useEffect, useMemo, useState } from 'react';
import { api, type AttendanceConfig, type AttendanceReviewItem, type AttendanceSummary } from '../api';
import { Icon } from '../icons';
import { Switch } from './Agents';

/** Minutos em horário comercial → texto curto ("8 min", "2h 10min"). */
export function fmtMin(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return '—';
  const m = Math.round(n);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}min` : `${h}h`;
}

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

const VERDICT: Record<string, { label: string; cls: string }> = {
  bom: { label: 'Bom', cls: 'good' },
  regular: { label: 'Regular', cls: 'mid' },
  ruim: { label: 'Ruim', cls: 'bad' },
};
const SPEED: Record<string, { label: string; cls: string }> = {
  rapido: { label: 'Rápido', cls: 'good' },
  ok: { label: 'Dentro do esperado', cls: 'mid' },
  lento: { label: 'Lento', cls: 'bad' },
};

type Filter = 'todos' | 'ruim' | 'lento' | 'aguardando';

export function Attendance() {
  const [cfg, setCfg] = useState<AttendanceConfig | null>(null);
  const [data, setData] = useState<{ summary: AttendanceSummary; items: AttendanceReviewItem[] } | null>(null);
  const [finals, setFinals] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('todos');

  const load = async () => {
    const [c, r] = await Promise.all([api.attendanceConfig(), api.attendanceReviews()]);
    setCfg(c);
    setFinals(c.finalStages);
    setDirty(false);
    setData(r);
  };
  useEffect(() => {
    load().catch((e) => setMsg({ text: (e as Error).message, bad: true }));
  }, []);

  const toggle = async (on: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      // Ao ligar, já grava as etapas finais exibidas (inclusive as sugeridas).
      await api.setAttendanceConfig(on ? { enabled: true, finalStages: finals } : { enabled: false });
      await load();
      setMsg({ text: on ? 'Análise ligada. Só entram leads de campanha que chegarem a partir de agora.' : 'Análise desligada.' });
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  };

  const saveFinals = async () => {
    setBusy(true);
    try {
      await api.setAttendanceConfig({ finalStages: finals });
      await load();
      setMsg({ text: 'Etapas finais salvas.' });
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    setMsg({ text: 'Analisando os atendimentos… pode levar alguns minutos.' });
    try {
      const r = await api.runAttendance();
      await load();
      setMsg({
        text:
          r.analyzed > 0
            ? `${r.analyzed} atendimento(s) analisado(s)${r.errors ? ` · ${r.errors} com erro` : ''}.`
            : 'Nada novo para analisar: ainda não há leads de campanha com resposta do advogado desde a ativação.',
        bad: r.errors > 0 && r.analyzed === 0,
      });
    } catch (e) {
      setMsg({ text: (e as Error).message, bad: true });
    } finally {
      setBusy(false);
    }
  };

  const items = useMemo(() => {
    const all = data?.items ?? [];
    if (filter === 'ruim') return all.filter((i) => i.verdict === 'ruim');
    if (filter === 'lento') return all.filter((i) => i.speed === 'lento');
    if (filter === 'aguardando') return all.filter((i) => typeof i.metrics.unansweredMin === 'number');
    return all;
  }, [data, filter]);

  if (!cfg) {
    return (
      <div className="page att">
        <div className="glass att-empty">{msg?.bad ? msg.text : 'Carregando…'}</div>
      </div>
    );
  }

  const s = data?.summary;
  const funnels = [...new Set(cfg.stages.map((st) => st.funnelName))];

  return (
    <div className="page att">

      <header className="att-head">
        <div>
          <h1 className="h1">
            Análise de atendimento <span className="att-beta">teste</span>
          </h1>
          <p className="sub">
            A IA avalia como o advogado atende os leads de anúncio: rapidez, erros e o que faltou. Só entram leads que chegaram com
            uma frase-gatilho de algum roteiro de IA.
          </p>
        </div>
      </header>

      <section className="glass att-config">
        <div className="att-config-top">
          <div className="att-switch">
            <Switch on={cfg.enabled} onChange={(v) => !busy && toggle(v)} label="Ligar análise de atendimento" />
            <div>
              <b>{cfg.enabled ? 'Análise ligada' : 'Análise desligada'}</b>
              <div className="muted small">
                {cfg.enabled && cfg.since
                  ? `Analisando leads de campanha desde ${fmtDate(cfg.since)} · roda todo dia às 19h`
                  : 'Ligue para começar. Nada do histórico anterior é analisado.'}
              </div>
            </div>
          </div>
          <button className="primary" disabled={!cfg.enabled || busy} onClick={runNow}>
            <Icon name="sparkle" size={15} /> {busy ? 'Analisando…' : 'Analisar agora'}
          </button>
        </div>

        <div className="att-finals">
          <div className="att-label">
            Para de analisar quando o lead chega em
            {cfg.suggested && <span className="muted small"> · sugestão automática, confira</span>}
          </div>
          {cfg.stages.length === 0 ? (
            <div className="muted small">Crie um funil no CRM para escolher a etapa final.</div>
          ) : (
            funnels.map((f) => (
              <div key={f} className="att-chips">
                {funnels.length > 1 && <span className="att-funnel">{f}</span>}
                {cfg.stages
                  .filter((st) => st.funnelName === f)
                  .map((st) => {
                    const on = finals.includes(st.id);
                    return (
                      <button
                        key={st.id}
                        type="button"
                        className={`att-chip ${on ? 'on' : ''}`}
                        aria-pressed={on}
                        onClick={() => {
                          setFinals(on ? finals.filter((x) => x !== st.id) : [...finals, st.id]);
                          setDirty(true);
                        }}
                      >
                        {on && <Icon name="check" size={13} />} {st.name}
                      </button>
                    );
                  })}
              </div>
            ))
          )}
          {dirty && (
            <button className="soft" disabled={busy} onClick={saveFinals}>
              Salvar etapas finais
            </button>
          )}
        </div>
        {msg && <div className={`att-msg ${msg.bad ? 'bad' : ''}`}>{msg.text}</div>}
      </section>

      <section className="att-kpis">
        <Kpi label="Leads analisados" value={s ? String(s.leads) : '—'} />
        <Kpi
          label="Nota média"
          value={s?.avgScore != null ? s.avgScore.toFixed(1) : '—'}
          tone={s?.avgScore == null ? '' : s.avgScore >= 7 ? 'good' : s.avgScore >= 5 ? 'mid' : 'bad'}
        />
        <Kpi label="1ª resposta média" value={fmtMin(s?.avgFirstResponseMin)} hint="horário comercial" />
        <Kpi label="Atendimentos lentos" value={s ? String(s.slow) : '—'} tone={s?.slow ? 'bad' : ''} />
        <Kpi label="Avaliados como ruins" value={s ? String(s.bad) : '—'} tone={s?.bad ? 'bad' : ''} />
        <Kpi label="Lead esperando resposta" value={s ? String(s.waiting) : '—'} tone={s?.waiting ? 'mid' : ''} />
      </section>

      <section className="glass att-list">
        <div className="att-list-head">
          <h2>Atendimentos</h2>
          <div className="segmented">
            {(
              [
                ['todos', 'Todos'],
                ['ruim', 'Ruins'],
                ['lento', 'Lentos'],
                ['aguardando', 'Esperando'],
              ] as [Filter, string][]
            ).map(([id, label]) => (
              <button key={id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {items.length === 0 ? (
          <div className="att-empty-list muted">
            {data?.items.length
              ? 'Nenhum atendimento neste filtro.'
              : cfg.enabled
                ? 'Ainda não há atendimentos analisados. Assim que um lead de campanha for respondido pelo advogado, ele aparece aqui (análise diária às 19h ou em "Analisar agora").'
                : 'Ligue a análise acima para começar.'}
          </div>
        ) : (
          items.map((it) => (
            <Row key={it.id} it={it} open={open === it.id} onToggle={() => setOpen(open === it.id ? null : it.id)} />
          ))
        )}
      </section>
    </div>
  );
}

function Kpi({ label, value, hint, tone = '' }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className={`glass att-kpi ${tone}`}>
      <div className="att-kpi-label">{label}</div>
      <div className="att-kpi-value">{value}</div>
      {hint && <div className="att-kpi-hint">{hint}</div>}
    </div>
  );
}

function Row({ it, open, onToggle }: { it: AttendanceReviewItem; open: boolean; onToggle: () => void }) {
  const v = VERDICT[it.verdict] ?? { label: '—', cls: '' };
  const sp = SPEED[it.speed] ?? { label: '—', cls: '' };
  const m = it.metrics;
  const tone = it.score >= 7 ? 'good' : it.score >= 5 ? 'mid' : 'bad';
  return (
    <div className={`att-row ${open ? 'open' : ''}`}>
      <button type="button" className="att-row-main" onClick={onToggle} aria-expanded={open}>
        <span className={`att-score ${tone}`}>{it.score}</span>
        <span className="att-who">
          <b>{it.name}</b>
          <span className="muted small">
            {[it.campaign && `Roteiro: ${it.campaign}`, it.stage && `Etapa: ${it.stage}`].filter(Boolean).join(' · ') || it.phone}
          </span>
        </span>
        <span className="att-tags">
          <span className={`att-tag ${v.cls}`}>{v.label}</span>
          <span className={`att-tag ${sp.cls}`}>
            <Icon name="clock" size={12} /> {sp.label}
          </span>
          {typeof m.unansweredMin === 'number' && <span className="att-tag mid">Esperando {fmtMin(m.unansweredMin)}</span>}
          {it.final && <span className="att-tag">Concluído</span>}
        </span>
        <span className={`att-chev ${open ? 'up' : ''}`}>
          <Icon name="chev" size={16} />
        </span>
      </button>

      {open && (
        <div className="att-detail">
          {it.summary && <p className="att-summary">{it.summary}</p>}
          <div className="att-metrics">
            <Metric label="1ª resposta" value={fmtMin(m.firstResponseMin)} />
            <Metric label="Resposta média" value={fmtMin(m.avgResponseMin)} />
            <Metric label="Maior demora" value={fmtMin(m.maxResponseMin)} />
            <Metric label="Respostas lentas" value={String(m.slowReplies ?? 0)} />
            <Metric label="Msgs do lead / advogado" value={`${m.leadMsgs ?? 0} / ${m.humanMsgs ?? 0}`} />
          </div>
          <div className="att-cols">
            <List title="Pontos fortes" tone="good" items={it.strengths} />
            <List title="Erros" tone="bad" items={it.errors} />
            <List title="O que faltou" tone="mid" items={it.missing} />
          </div>
          {it.recommendation && (
            <div className="att-reco">
              <Icon name="sparkle" size={14} /> <span>{it.recommendation}</span>
            </div>
          )}
          <div className="muted small">Atualizado em {fmtDate(it.updatedAt)} · tempos contam só horário comercial (seg–sáb, 8h–20h)</div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="att-metric">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function List({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  return (
    <div className={`att-col ${tone}`}>
      <h4>{title}</h4>
      {items.length ? (
        <ul>
          {items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      ) : (
        <div className="muted small">Nada a apontar.</div>
      )}
    </div>
  );
}
