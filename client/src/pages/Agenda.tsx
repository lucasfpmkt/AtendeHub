import { useEffect, useState } from 'react';
import { api, type CalEvent } from '../api';
import { Icon } from '../icons';

const DOW = ['DOM.', 'SEG.', 'TER.', 'QUA.', 'QUI.', 'SEX.', 'SÁB.'];
const MON = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const H0 = 7;
const H1 = 20;
const RH = 48; // altura de 1 hora em px
const HEAD = 52;

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const toH = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return h + m / 60;
};

type Mode = 'week' | 'month' | 'list';

export function Agenda() {
  const [mode, setMode] = useState<Mode>('week');
  const [ref, setRef] = useState(() => startOfDay(new Date()));
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [editing, setEditing] = useState<Partial<CalEvent> | null>(null);

  const today = startOfDay(new Date());
  const weekStart = addDays(ref, -ref.getDay());
  const monthStart = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const gridStart = addDays(monthStart, -monthStart.getDay());

  const range: [string, string] =
    mode === 'week'
      ? [iso(weekStart), iso(addDays(weekStart, 6))]
      : mode === 'month'
        ? [iso(gridStart), iso(addDays(gridStart, 41))]
        : [iso(today), iso(addDays(today, 90))];

  const load = () => api.events(range[0], range[1]).then(setEvents);
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range[0], range[1]]);

  const move = (dir: number) =>
    setRef(mode === 'month' ? new Date(ref.getFullYear(), ref.getMonth() + dir, 1) : addDays(ref, 7 * dir));

  const title =
    mode === 'week'
      ? `${weekStart.getDate()} – ${addDays(weekStart, 6).getDate()} de ${MON[addDays(weekStart, 6).getMonth()]} ${addDays(weekStart, 6).getFullYear()}`
      : mode === 'month'
        ? `${MON[ref.getMonth()]} ${ref.getFullYear()}`
        : 'Próximos 90 dias';

  const now = new Date();
  const todayIdx = Math.round((today.getTime() - weekStart.getTime()) / 864e5);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h1">{title}</h1>
          <p className="sub">Clique num horário vazio para marcar uma reunião.</p>
        </div>
        <div className="toolbar">
          <div className="segmented">
            {(
              [
                ['week', 'Semana'],
                ['month', 'Mês'],
                ['list', 'Lista'],
              ] as const
            ).map(([k, l]) => (
              <button key={k} className={mode === k ? 'active' : ''} onClick={() => setMode(k)}>
                {l}
              </button>
            ))}
          </div>
          {mode !== 'list' && (
            <>
              <button className="icon-btn" onClick={() => move(-1)} aria-label="Anterior">
                <Icon name="left" />
              </button>
              <button className="sm" onClick={() => setRef(today)}>
                Hoje
              </button>
              <button className="icon-btn" onClick={() => move(1)} aria-label="Próximo">
                <Icon name="right" />
              </button>
            </>
          )}
          <button className="primary" onClick={() => setEditing({ date: iso(today), start: '09:00', end: '10:00', kind: 'meet' })}>
            <Icon name="plus" /> Nova reunião
          </button>
        </div>
      </div>

      {mode === 'week' && (
        <div className="card flush cal-scroll">
          <div className="cal-grid" style={{ height: HEAD + (H1 - H0) * RH }}>
            <div className="cal-corner" />
            {Array.from({ length: 7 }, (_, i) => {
              const d = addDays(weekStart, i);
              return (
                <div key={i} className={`cal-dh ${iso(d) === iso(today) ? 'today' : ''}`}>
                  {DOW[i]}
                  <b>{d.getDate()}</b>
                </div>
              );
            })}
            {Array.from({ length: H1 - H0 }, (_, r) => (
              <Row key={r} hour={H0 + r} weekStart={weekStart} onPick={(date, start) => setEditing({ date, start, end: `${pad(H0 + r + 1)}:00`, kind: 'meet' })} />
            ))}
            {events.map((e) => {
              const di = Math.round((new Date(`${e.date}T00:00`).getTime() - weekStart.getTime()) / 864e5);
              if (di < 0 || di > 6) return null;
              const top = HEAD + (toH(e.start) - H0) * RH;
              const height = Math.max(22, (toH(e.end) - toH(e.start)) * RH - 3);
              return (
                <button
                  key={e.id}
                  className={`ev ${e.kind}`}
                  style={{
                    top,
                    height,
                    left: `calc(56px + (100% - 56px) / 7 * ${di} + 3px)`,
                    width: 'calc((100% - 56px) / 7 - 6px)',
                  }}
                  onClick={() => setEditing(e)}
                >
                  {e.title}
                  <span className="mono">
                    {e.start}–{e.end}
                  </span>
                </button>
              );
            })}
            {todayIdx >= 0 && todayIdx < 7 && now.getHours() >= H0 && now.getHours() < H1 && (
              <div
                className="now-line"
                style={{
                  top: HEAD + (now.getHours() + now.getMinutes() / 60 - H0) * RH,
                  left: `calc(56px + (100% - 56px) / 7 * ${todayIdx})`,
                  width: 'calc((100% - 56px) / 7)',
                }}
              />
            )}
          </div>
        </div>
      )}

      {mode === 'month' && (
        <div className="card flush month">
          {DOW.map((d) => (
            <div key={d} className="month-dh">
              {d}
            </div>
          ))}
          {Array.from({ length: 42 }, (_, i) => {
            const d = addDays(gridStart, i);
            const k = iso(d);
            return (
              <div
                key={k}
                className={`month-d ${d.getMonth() !== ref.getMonth() ? 'dim' : ''}`}
                onClick={() => setEditing({ date: k, start: '09:00', end: '10:00', kind: 'meet' })}
              >
                <span className={k === iso(today) ? 'today-num' : ''}>{d.getDate()}</span>
                {events
                  .filter((e) => e.date === k)
                  .map((e) => (
                    <button
                      key={e.id}
                      className={`month-ev ${e.kind}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setEditing(e);
                      }}
                    >
                      {e.start} {e.title}
                    </button>
                  ))}
              </div>
            );
          })}
        </div>
      )}

      {mode === 'list' && (
        <div className="card flush">
          <table className="table">
            <thead>
              <tr>
                <th>Data</th>
                <th>Horário</th>
                <th>Compromisso</th>
                <th>Tipo</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    Nenhum compromisso marcado.
                  </td>
                </tr>
              )}
              {events.map((e) => (
                <tr key={e.id} className="clickable" onClick={() => setEditing(e)}>
                  <td className="mono">
                    {e.date.slice(8, 10)}/{e.date.slice(5, 7)}/{e.date.slice(0, 4)}
                  </td>
                  <td className="mono">
                    {e.start}–{e.end}
                  </td>
                  <td>
                    <strong>{e.title}</strong>
                  </td>
                  <td>
                    <span className={`pill ${e.kind === 'int' ? 'ai' : 'primary'}`}>{e.kind === 'int' ? 'Interna' : 'Com cliente'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <EventModal
          event={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function Row({ hour, weekStart, onPick }: { hour: number; weekStart: Date; onPick: (date: string, start: string) => void }) {
  return (
    <>
      <div className="cal-h mono">{pad(hour)}:00</div>
      {Array.from({ length: 7 }, (_, i) => (
        <div
          key={i}
          className="cal-cell"
          role="button"
          tabIndex={0}
          aria-label={`Marcar ${pad(hour)}:00`}
          onClick={() => onPick(iso(addDays(weekStart, i)), `${pad(hour)}:00`)}
          onKeyDown={(e) => e.key === 'Enter' && onPick(iso(addDays(weekStart, i)), `${pad(hour)}:00`)}
        />
      ))}
    </>
  );
}

function EventModal({ event, onClose, onSaved }: { event: Partial<CalEvent>; onClose: () => void; onSaved: () => void }) {
  const [e, setE] = useState<Partial<CalEvent>>(event);
  const [err, setErr] = useState('');
  const isNew = !event.id;
  const set = (k: keyof CalEvent, v: string) => setE({ ...e, [k]: v });
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        onClick={(ev) => ev.stopPropagation()}
        onSubmit={async (ev) => {
          ev.preventDefault();
          if ((e.end ?? '') <= (e.start ?? '')) return setErr('O horário de fim precisa ser depois do início.');
          try {
            if (isNew) await api.addEvent(e);
            else await api.updateEvent(event.id!, e);
            onSaved();
          } catch (x) {
            setErr((x as Error).message);
          }
        }}
      >
        <h3>{isNew ? 'Nova reunião' : 'Editar compromisso'}</h3>
        <div className="field">
          <label htmlFor="ev-title">Título</label>
          <input id="ev-title" autoFocus required value={e.title ?? ''} onChange={(x) => set('title', x.target.value)} placeholder="Consulta — nome do cliente" />
        </div>
        <div className="field">
          <label htmlFor="ev-date">Data</label>
          <input id="ev-date" type="date" required value={e.date ?? ''} onChange={(x) => set('date', x.target.value)} />
        </div>
        <div className="duo">
          <div className="field">
            <label htmlFor="ev-start">Início</label>
            <input id="ev-start" type="time" required value={e.start ?? ''} onChange={(x) => set('start', x.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="ev-end">Fim</label>
            <input id="ev-end" type="time" required value={e.end ?? ''} onChange={(x) => set('end', x.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="ev-kind">Tipo</label>
          <select id="ev-kind" value={e.kind ?? 'meet'} onChange={(x) => set('kind', x.target.value)}>
            <option value="meet">Com cliente</option>
            <option value="int">Interna</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="ev-notes">Anotações</label>
          <textarea id="ev-notes" rows={2} value={e.notes ?? ''} onChange={(x) => set('notes', x.target.value)} />
        </div>
        {err && <div className="alert">{err}</div>}
        <div className="modal-actions">
          {!isNew && (
            <button
              type="button"
              className="danger-text"
              style={{ marginRight: 'auto' }}
              onClick={async () => {
                await api.deleteEvent(event.id!);
                onSaved();
              }}
            >
              <Icon name="trash" size={14} /> Excluir
            </button>
          )}
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary">{isNew ? 'Marcar' : 'Salvar'}</button>
        </div>
      </form>
    </div>
  );
}
