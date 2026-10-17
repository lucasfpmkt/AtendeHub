import { useEffect, useState } from 'react';
import { api, type Task } from '../api';
import { Icon } from '../icons';

const STATUS: Record<Task['status'], { label: string; cls: string; next: Task['status'] }> = {
  todo: { label: 'A fazer', cls: 'warn', next: 'doing' },
  doing: { label: 'Em andamento', cls: 'primary', next: 'done' },
  done: { label: 'Concluída', cls: 'ok', next: 'todo' },
};
const PRIO: Record<string, string> = { Alta: 'danger', Média: 'warn', Baixa: '' };

const today = () => new Date().toISOString().slice(0, 10);
const fmt = (d?: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—');

export function Tasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<'list' | 'kanban'>('list');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | Task['status']>('');
  const [modal, setModal] = useState(false);

  const load = () => api.tasks().then(setTasks);
  useEffect(() => {
    load();
  }, []);

  const cycle = async (t: Task) => {
    await api.updateTask(t.id, { status: STATUS[t.status].next });
    load();
  };

  const list = tasks.filter(
    (t) => (!q || t.title.toLowerCase().includes(q.toLowerCase())) && (!status || t.status === status),
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h1">Tarefas</h1>
          <p className="sub">
            {tasks.filter((t) => t.status !== 'done').length} em aberto · clique no status para avançar
          </p>
        </div>
        <div className="toolbar">
          <div className="segmented">
            <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
              Lista
            </button>
            <button className={view === 'kanban' ? 'active' : ''} onClick={() => setView('kanban')}>
              Kanban
            </button>
          </div>
          <button className="primary" onClick={() => setModal(true)}>
            <Icon name="plus" /> Nova tarefa
          </button>
        </div>
      </div>

      <div className="toolbar" style={{ marginBottom: 14 }}>
        <input placeholder="Buscar tarefas…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
        <select value={status} onChange={(e) => setStatus(e.target.value as Task['status'] | '')} style={{ width: 'auto' }} aria-label="Status">
          <option value="">Todos os status</option>
          {Object.entries(STATUS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      </div>

      {view === 'list' ? (
        <div className="card flush">
          <table className="table">
            <thead>
              <tr>
                <th>Tarefa</th>
                <th>Responsável</th>
                <th>Prazo</th>
                <th>Prioridade</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty">
                      <strong>Nenhuma tarefa aqui ainda</strong>
                      <span>Crie a primeira tarefa para organizar o trabalho da equipe.</span>
                    </div>
                  </td>
                </tr>
              )}
              {list.map((t) => {
                const late = t.status !== 'done' && t.dueDate && t.dueDate < today();
                return (
                  <tr key={t.id}>
                    <td className={t.status === 'done' ? 'done' : ''}>
                      <strong>{t.title}</strong>
                    </td>
                    <td>{t.responsavel || '—'}</td>
                    <td className={`mono ${late ? 'late' : ''}`}>{fmt(t.dueDate)}</td>
                    <td>
                      <span className={`pill ${PRIO[t.priority]}`}>{t.priority}</span>
                    </td>
                    <td>
                      <button className={`pill ${STATUS[t.status].cls}`} onClick={() => cycle(t)}>
                        {STATUS[t.status].label}
                      </button>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="icon-btn"
                        aria-label="Excluir tarefa"
                        onClick={async () => {
                          await api.deleteTask(t.id);
                          load();
                        }}
                      >
                        <Icon name="trash" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="board flat">
          {(Object.keys(STATUS) as Task['status'][]).map((k) => {
            const col = list.filter((t) => t.status === k);
            return (
              <div key={k} className="column">
                <div className="column-head">
                  <span className="name">{STATUS[k].label}</span>
                  <span className="count">{col.length}</span>
                </div>
                <div className="column-body">
                  {col.length === 0 && <div className="empty-col">Nada por aqui</div>}
                  {col.map((t) => (
                    <div key={t.id} className="deal" style={{ cursor: 'default' }}>
                      <div className="title">{t.title}</div>
                      <div className="meta">
                        <span>{t.responsavel || 'Sem responsável'}</span>
                        <span className="mono">{fmt(t.dueDate)}</span>
                      </div>
                      <div className="row between" style={{ marginTop: 8 }}>
                        <span className={`pill ${PRIO[t.priority]}`}>{t.priority}</span>
                        <button className="sm" onClick={() => cycle(t)}>
                          {k === 'done' ? 'Reabrir' : 'Avançar'} <Icon name="right" size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {modal && <TaskModal onClose={() => setModal(false)} onSaved={() => { setModal(false); load(); }} />}
    </div>
  );
}

function TaskModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [responsavel, setResp] = useState('');
  const [dueDate, setDue] = useState(today());
  const [priority, setPrio] = useState<Task['priority']>('Média');
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim()) return;
          await api.addTask({ title: title.trim(), responsavel: responsavel || null, dueDate, priority });
          onSaved();
        }}
      >
        <h3>Nova tarefa</h3>
        <div className="field">
          <label htmlFor="t-title">Título</label>
          <input id="t-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Enviar contrato para o cliente" />
        </div>
        <div className="field">
          <label htmlFor="t-resp">Responsável</label>
          <input id="t-resp" value={responsavel} onChange={(e) => setResp(e.target.value)} placeholder="Nome de quem vai fazer" />
        </div>
        <div className="duo">
          <div className="field">
            <label htmlFor="t-due">Prazo</label>
            <input id="t-due" type="date" value={dueDate} onChange={(e) => setDue(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="t-prio">Prioridade</label>
            <select id="t-prio" value={priority} onChange={(e) => setPrio(e.target.value as Task['priority'])}>
              <option>Alta</option>
              <option>Média</option>
              <option>Baixa</option>
            </select>
          </div>
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary">Criar tarefa</button>
        </div>
      </form>
    </div>
  );
}
