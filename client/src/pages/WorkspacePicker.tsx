import { useEffect, useMemo, useState } from 'react';
import { api, type AdminWorkspace } from '../api';
import { Icon } from '../icons';

const fmt = (d?: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');
const today = () => new Date().toISOString().slice(0, 10);

/** "Selecionar workspace": o admin escolhe qual cliente abrir. */
export function WorkspacePicker({ currentId, onClose }: { currentId: string; onClose?: () => void }) {
  const [list, setList] = useState<AdminWorkspace[] | null>(null);
  const [selected, setSelected] = useState(currentId);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.adminWorkspaces().then(setList);
  }, []);

  const visible = useMemo(
    () => (list ?? []).filter((w) => !q || w.name.toLowerCase().includes(q.toLowerCase()) || String(w.code).includes(q)),
    [list, q],
  );

  const open = async () => {
    setBusy(true);
    await api.switchWorkspace(selected);
    sessionStorage.setItem('lawhub.pickedWorkspace', '1');
    // Recarrega para trocar dados, tempo real e WhatsApp para o cliente escolhido.
    window.location.reload();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <span className="picker-ico">
            <Icon name="building" size={20} />
          </span>
          <div style={{ flex: 1 }}>
            <h3>Selecionar workspace</h3>
            <p className="sub">Escolha qual CRM acessar</p>
          </div>
          {onClose && (
            <button className="icon-btn" onClick={onClose} aria-label="Fechar">
              <Icon name="x" />
            </button>
          )}
        </div>
        {(list?.length ?? 0) > 5 && (
          <div className="conv-search" style={{ margin: '0 20px 10px' }}>
            <Icon name="search" size={16} />
            <input placeholder="Buscar cliente ou número" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        )}
        <div className="picker-list" role="radiogroup" aria-label="Clientes">
          {list === null && <div className="muted pad">Carregando clientes…</div>}
          {visible.map((w) => {
            const expired = w.expiresAt && w.expiresAt < today();
            return (
              <button
                key={w.id}
                role="radio"
                aria-checked={selected === w.id}
                className={`picker-item ${selected === w.id ? 'active' : ''}`}
                onClick={() => setSelected(w.id)}
                onDoubleClick={open}
              >
                <span className="picker-body">
                  <b>{w.name}</b>
                  <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <span className="pill mono">#{w.code}</span>
                    <span className={`pill ${w.plan === 'TESTE' ? 'warn' : 'ok'}`}>{w.plan}</span>
                    {!w.active && <span className="pill danger">INATIVO</span>}
                    {w.expiresAt && (
                      <span className={`small ${expired ? 'late-text' : 'muted'}`}>
                        <Icon name="clock" size={13} /> até {fmt(w.expiresAt)}
                      </span>
                    )}
                  </span>
                </span>
                <span className="radio" />
              </button>
            );
          })}
        </div>
        <div className="modal-actions picker-foot">
          {onClose && <button onClick={onClose}>Cancelar</button>}
          <button className="primary" onClick={open} disabled={busy || !selected}>
            {busy ? 'Abrindo…' : 'Acessar CRM'}
          </button>
        </div>
      </div>
    </div>
  );
}
