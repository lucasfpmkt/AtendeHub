import { useEffect, useState } from 'react';
import { api, type DashboardData } from '../api';
import { Icon } from '../icons';
import { Kpi } from './Home';

const BRL = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtMin = (min: number | null) => (min == null ? '—' : min >= 60 ? `${(min / 60).toFixed(1)}h` : `${min} min`);

export function Dashboard() {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<DashboardData | null>(null);
  const [funnelId, setFunnelId] = useState<string>('');

  useEffect(() => {
    api.dashboard(days).then((d) => {
      setData(d);
      setFunnelId((cur) => cur || d.funnels[0]?.id || '');
    });
  }, [days]);

  if (!data) return <div className="page muted">Carregando…</div>;
  const t = data.totals;
  const funnel = data.funnels.find((f) => f.id === funnelId) ?? data.funnels[0];
  const funnelTotal = funnel?.stages.reduce((s, x) => s + x.deals, 0) ?? 0;
  const total = data.perDay.reduce((s, d) => s + d.count, 0);
  const peak = Math.max(0, ...data.perDay.map((d) => d.count));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h1">Dashboard</h1>
          <p className="sub">Entrada de contatos, atendimento e funil.</p>
        </div>
        <div className="segmented">
          {[7, 15, 30].map((d) => (
            <button key={d} className={days === d ? 'active' : ''} onClick={() => setDays(d)}>
              {d} dias
            </button>
          ))}
        </div>
      </div>

      <div className="kpis">
        <Kpi label="Novos contatos" value={total} hint={`média ${(total / days).toFixed(1)}/dia`} />
        <Kpi label="Conversas abertas" value={t.openConversations} hint={`${t.aiConversations} com IA`} />
        <Kpi label="Mensagens recebidas" value={data.messages.in} hint={`${data.messages.out} enviadas`} />
        <Kpi label="1ª resposta" value={fmtMin(data.firstResponseMin)} hint="tempo médio" />
        <Kpi label="Conversão" value={`${data.conversion.rate}%`} hint={`${data.conversion.won}/${data.conversion.total} negócios`} />
        <Kpi label="Negócios" value={t.deals} hint={BRL(t.pipelineCents)} />
      </div>

      {/* Comparativo: o que chegou de fato no WhatsApp x o que o Meta contabilizou. */}
      <div className="kpis" style={{ marginTop: 12 }}>
        <Kpi
          label="Conversas no WhatsApp"
          value={data.whatsappConversations}
          hint="chegaram de fato no período"
          icon="chat"
          accent="#16a34a"
        />
        <Kpi
          label="Atribuídas pelo Meta Ads"
          value={data.metaResults ?? '—'}
          hint={data.metaResults == null ? 'Meta Ads não configurado' : 'resultados contados pela Meta'}
          icon="share"
          accent="#2563eb"
        />
      </div>

      <div className="grid2">
        <div className="card">
          <h3 className="card-title">
            <Icon name="users" /> Novos contatos por dia
          </h3>
          <LineChart points={data.perDay} />
        </div>
        <div className="card">
          <div className="row between" style={{ marginBottom: 10 }}>
            <h3 className="card-title" style={{ margin: 0 }}>
              <Icon name="crm" /> Funil
            </h3>
            <select value={funnel?.id ?? ''} onChange={(e) => setFunnelId(e.target.value)} style={{ width: 'auto' }} aria-label="Funil">
              {data.funnels.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          {funnel?.stages.map((s) => (
            <div key={s.id} className="fun-row">
              <div className="row between small">
                <span className="row" style={{ gap: 7 }}>
                  <span className="dot" style={{ background: s.color }} />
                  {s.name}
                </span>
                <span className="mono">{s.deals}</span>
              </div>
              <div className="bar">
                <i style={{ width: `${funnelTotal ? (s.deals / funnelTotal) * 100 : 0}%`, background: s.color }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3 className="card-title">
          <Icon name="share" /> Leads por origem
        </h3>
        {data.bySource.length === 0 && <p className="muted small">Sem negócios ainda.</p>}
        {(() => {
          const max = Math.max(1, ...data.bySource.map((s) => s.count));
          return data.bySource.map((s) => (
            <div key={s.source} className="fun-row">
              <div className="row between small">
                <span>{s.source}</span>
                <span className="mono">{s.count}</span>
              </div>
              <div className="bar">
                <i style={{ width: `${(s.count / max) * 100}%`, background: 'var(--p-600)' }} />
              </div>
            </div>
          ));
        })()}
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3 className="card-title">
          <Icon name="bot" /> Agentes IA
        </h3>
        <table className="table">
          <thead>
            <tr>
              <th>Agente</th>
              <th>Tipo</th>
              <th>Conversas em andamento</th>
            </tr>
          </thead>
          <tbody>
            {data.agents.map((a) => (
              <tr key={a.id}>
                <td>{a.name}</td>
                <td>
                  <span className={`pill ${!a.active ? '' : a.type === 'triage' ? 'primary' : 'ai'}`}>
                    {!a.active ? 'Inativo' : a.type === 'triage' ? 'Triagem' : 'Tema'}
                  </span>
                </td>
                <td className="mono">{a.conversations}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LineChart({ points }: { points: { date: string; count: number }[] }) {
  const W = 640;
  const H = 220;
  const pl = 34;
  const pr = 14;
  const pt = 14;
  const pb = 28;
  const max = Math.max(4, ...points.map((p) => p.count));
  const n = Math.max(1, points.length - 1);
  const x = (i: number) => pl + (i * (W - pl - pr)) / n;
  const y = (v: number) => pt + (H - pt - pb) * (1 - v / max);
  const line = points.map((p, i) => `${x(i)},${y(p.count)}`).join(' ');
  const ticks = [0, Math.round(max / 2), max];
  const every = Math.ceil(points.length / 8);
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Novos contatos por dia">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pl} x2={W - pr} y1={y(t)} y2={y(t)} stroke="var(--border)" />
          <text x={pl - 8} y={y(t) + 4} textAnchor="end">
            {t}
          </text>
        </g>
      ))}
      <polygon points={`${x(0)},${y(0)} ${line} ${x(points.length - 1)},${y(0)}`} fill="var(--primary)" opacity={0.1} />
      <polyline points={line} fill="none" stroke="var(--primary)" strokeWidth={2.5} strokeLinejoin="round" />
      {points.map((p, i) => (
        <g key={p.date}>
          <circle
            cx={x(i)}
            cy={y(p.count)}
            r={i === points.length - 1 ? 5 : 3}
            fill={i === points.length - 1 ? 'var(--primary)' : 'var(--surface)'}
            stroke="var(--primary)"
            strokeWidth={2}
          >
            <title>
              {p.date.slice(8, 10)}/{p.date.slice(5, 7)}: {p.count}
            </title>
          </circle>
          {i % every === 0 && (
            <text x={x(i)} y={H - 8} textAnchor="middle">
              {p.date.slice(8, 10)}/{p.date.slice(5, 7)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
