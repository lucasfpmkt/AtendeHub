import { useEffect, useState } from 'react';
import { api, type CalEvent, type DashboardData } from '../api';
import { Icon } from '../icons';
import type { Tab } from '../App';

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function Home({ go, connected, userName }: { go: (t: Tab) => void; connected: boolean; userName: string }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    api.dashboard(7).then(setData);
    const end = new Date();
    end.setDate(end.getDate() + 14);
    api.events(iso(new Date()), iso(end)).then((es) => setEvents(es.slice(0, 5)));
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const hr = now.getHours();
  const greet = hr < 12 ? 'Bom dia' : hr < 18 ? 'Boa tarde' : 'Boa noite';
  const t = data?.totals;
  const today = data?.perDay.at(-1)?.count ?? 0;
  const clock = `${now
    .toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short' })
    .replace(/\./g, '')
    .toUpperCase()} · ${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;

  const shortcuts: { tab: Tab; icon: string; title: string; desc: string }[] = [
    { tab: 'inbox', icon: 'chat', title: 'Conversas', desc: 'Responda os leads do WhatsApp' },
    { tab: 'agents', icon: 'bot', title: 'LawHub IA', desc: 'Roteiro, regras e gatilhos' },
    { tab: 'pipeline', icon: 'crm', title: 'CRM', desc: 'Mova os leads entre etapas' },
    { tab: 'agenda', icon: 'cal', title: 'Agendas', desc: 'Reuniões da semana' },
  ];

  return (
    <div className="page">
      <div className="hero">
        <div className="clock">{clock}</div>
        <h1>
          {greet},
          <br />
          <em>{userName || 'equipe'}.</em>
        </h1>
        <p className="sub" style={{ maxWidth: '62ch', fontSize: 14 }}>
          {data
            ? `Hoje chegaram ${today} contato${today === 1 ? '' : 's'} novo${today === 1 ? '' : 's'}. Há ${t?.unread ?? 0} mensage${t?.unread === 1 ? 'm' : 'ns'} não lida${t?.unread === 1 ? '' : 's'} e ${t?.tasksOpen ?? 0} tarefa${t?.tasksOpen === 1 ? '' : 's'} em aberto.`
            : 'Carregando o resumo do dia…'}
        </p>
      </div>

      {!connected && (
        <div className="promo">
          <span>
            <div className="eyebrow">WhatsApp desconectado</div>
            <span className="muted small">Os agentes só respondem com o número conectado.</span>
          </span>
          <button className="primary" onClick={() => go('connect')}>
            Conectar agora <Icon name="right" size={16} />
          </button>
        </div>
      )}

      <div className="kpis">
        <Kpi icon="chat" label="Conversas abertas" value={t?.openConversations} hint="em atendimento" />
        <Kpi icon="bot" label="Com agente IA" value={t?.aiConversations} hint="IA respondendo" />
        <Kpi icon="inbox" label="Não lidas" value={t?.unread} hint="aguardando a equipe" />
        <Kpi icon="users" label="Novos contatos" value={t?.newContacts} hint="últimos 7 dias" />
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
                <span className="when">
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

export function Kpi({ label, value, hint, icon }: { label: string; value?: number | string; hint: string; icon?: string }) {
  return (
    <div className="card kpi">
      <span className="kpi-head">
        {icon && (
          <span className="kpi-ico">
            <Icon name={icon} size={16} />
          </span>
        )}
        <span className="kpi-label">{label}</span>
      </span>
      <span className="kpi-value">{value ?? '—'}</span>
      <span className="kpi-hint">{hint}</span>
    </div>
  );
}
