import { useEffect, useState } from 'react';
import { api, type CalEvent, type DashboardData } from '../api';
import { Icon } from '../icons';
import type { Tab } from '../App';

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function Home({ go, connected }: { go: (t: Tab) => void; connected: boolean }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const now = new Date();

  useEffect(() => {
    api.dashboard(7).then(setData);
    const end = new Date();
    end.setDate(end.getDate() + 14);
    api.events(iso(now), iso(end)).then((es) => setEvents(es.slice(0, 5)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hr = now.getHours();
  const greet = hr < 12 ? 'Bom dia' : hr < 18 ? 'Boa tarde' : 'Boa noite';
  const t = data?.totals;
  const today = data?.perDay.at(-1)?.count ?? 0;

  const shortcuts: { tab: Tab; icon: string; title: string; desc: string }[] = [
    { tab: 'inbox', icon: 'chat', title: 'Conversas', desc: 'Responda os leads do WhatsApp' },
    { tab: 'agents', icon: 'bot', title: 'Agentes IA', desc: 'Roteiro, regras e gatilhos' },
    { tab: 'pipeline', icon: 'crm', title: 'Funil', desc: 'Mova os leads entre etapas' },
    { tab: 'agenda', icon: 'cal', title: 'Agenda', desc: 'Reuniões da semana' },
  ];

  return (
    <div className="page">
      <div className="hero">
        <div className="clock mono">
          {now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' }).toUpperCase()}
        </div>
        <h1>
          {greet}, <em>equipe.</em>
        </h1>
        <p className="sub" style={{ maxWidth: '62ch' }}>
          {data
            ? `Hoje chegaram ${today} contato${today === 1 ? '' : 's'} novo${today === 1 ? '' : 's'}, há ${t?.unread ?? 0} mensage${t?.unread === 1 ? 'm' : 'ns'} não lida${t?.unread === 1 ? '' : 's'} e ${t?.tasksOpen ?? 0} tarefa${t?.tasksOpen === 1 ? '' : 's'} em aberto.`
            : 'Carregando o resumo do dia…'}
        </p>
      </div>

      {!connected && (
        <div className="banner">
          <span>
            <strong>WhatsApp desconectado.</strong> Os agentes só respondem com o número conectado.
          </span>
          <button className="primary sm" onClick={() => go('connect')}>
            Conectar agora
          </button>
        </div>
      )}

      <div className="kpis">
        <Kpi label="Conversas abertas" value={t?.openConversations} hint="em atendimento" />
        <Kpi label="Com agente IA" value={t?.aiConversations} hint="IA respondendo" />
        <Kpi label="Não lidas" value={t?.unread} hint="aguardando a equipe" />
        <Kpi label="Novos contatos" value={t?.newContacts} hint="últimos 7 dias" />
      </div>

      <div className="grid2">
        <div className="card">
          <h3 className="card-title">
            <Icon name="zap" /> Atalhos
          </h3>
          <div className="shortcuts">
            {shortcuts.map((s) => (
              <button key={s.tab} className="shortcut" onClick={() => go(s.tab)}>
                <span className="sc-ico">
                  <Icon name={s.icon} />
                </span>
                <b>{s.title}</b>
                <small>{s.desc}</small>
              </button>
            ))}
          </div>
        </div>
        <div className="card">
          <h3 className="card-title">
            <Icon name="cal" /> Próximos compromissos
          </h3>
          {events.length === 0 ? (
            <div className="empty">
              <strong>Agenda livre</strong>
              <span>Nenhum compromisso nos próximos 14 dias.</span>
            </div>
          ) : (
            events.map((e) => (
              <div key={e.id} className="agenda-row">
                <span className="mono when">
                  {e.date.slice(8, 10)}/{e.date.slice(5, 7)} {e.start}
                </span>
                <span>{e.title}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function Kpi({ label, value, hint }: { label: string; value?: number | string; hint: string }) {
  return (
    <div className="card kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value ?? '—'}</span>
      <span className="kpi-hint">{hint}</span>
    </div>
  );
}
