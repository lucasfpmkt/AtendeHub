import { useEffect, useState } from 'react';
import { api, type AdminWorkspace } from '../api';
import { Icon } from '../icons';
import { Switch } from './Agents';

const fmt = (d?: string | null) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—');
const today = () => new Date().toISOString().slice(0, 10);
const WA: Record<string, [string, string]> = {
  connected: ['Conectado', 'ok'],
  qr: ['Aguardando QR', 'warn'],
  connecting: ['Conectando', 'warn'],
  disconnected: ['Desconectado', ''],
};

/** Área do administrador: todos os clientes, planos e acessos. */
export function Clients({ currentId }: { currentId: string }) {
  const [list, setList] = useState<AdminWorkspace[]>([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminWorkspace | null>(null);
  const [removing, setRemoving] = useState<AdminWorkspace | null>(null);
  const [q, setQ] = useState('');

  const load = () => api.adminWorkspaces().then(setList);
  useEffect(() => {
    load();
  }, []);

  const visible = list.filter((w) => !q || w.name.toLowerCase().includes(q.toLowerCase()) || String(w.code).includes(q));
  const activeCount = list.filter((w) => w.active && !(w.expiresAt && w.expiresAt < today())).length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h1">Clientes</h1>
          <p className="sub">
            {list.length} cliente{list.length === 1 ? '' : 's'} · {activeCount} com acesso liberado
          </p>
        </div>
        <div className="toolbar">
          <div className="conv-search" style={{ width: 240 }}>
            <Icon name="search" size={16} />
            <input placeholder="Buscar cliente" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <button className="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} /> Novo cliente
          </button>
        </div>
      </div>

      <div className="card flush">
        <table className="table">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Plano</th>
              <th>Vencimento</th>
              <th>WhatsApp</th>
              <th>Contatos</th>
              <th>Acesso</th>
              <th style={{ textAlign: 'right' }}>Ações</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  Nenhum cliente encontrado.
                </td>
              </tr>
            )}
            {visible.map((w) => {
              const expired = Boolean(w.expiresAt && w.expiresAt < today());
              const [waLabel, waCls] = WA[w.whatsapp] ?? WA.disconnected;
              return (
                <tr key={w.id}>
                  <td>
                    <span className="row" style={{ gap: 10 }}>
                      <span className="avatar gray">{w.name.trim()[0]?.toUpperCase()}</span>
                      <span>
                        <b style={{ fontWeight: 500 }}>{w.name}</b>
                        <span className="muted small" style={{ display: 'block' }}>
                          #{w.code} · {w.users.map((u) => u.email).join(', ') || 'sem login'}
                          {w.id === currentId && ' · aberto agora'}
                        </span>
                      </span>
                    </span>
                  </td>
                  <td>
                    <span className={`pill ${w.plan === 'TESTE' ? 'warn' : 'ok'}`}>{w.plan}</span>
                  </td>
                  <td className={`mono small ${expired ? 'late-text' : ''}`}>{fmt(w.expiresAt)}</td>
                  <td>
                    <span className={`pill ${waCls}`}>{waLabel}</span>
                  </td>
                  <td className="mono">{w.contacts}</td>
                  <td>
                    <Switch
                      on={w.active}
                      label={`Acesso de ${w.name}`}
                      onChange={async (v) => {
                        await api.adminUpdateWorkspace(w.id, { active: v });
                        load();
                      }}
                    />
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <span className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
                      <button className="sm" onClick={() => setEditing(w)}>
                        Editar
                      </button>
                      <button
                        className="icon-btn"
                        aria-label={`Excluir ${w.name}`}
                        title={
                          w.id === currentId
                            ? 'Abra outro cliente para excluir este'
                            : w.users.some((u) => u.role === 'admin')
                              ? 'Cliente do administrador não pode ser excluído'
                              : 'Excluir cliente'
                        }
                        disabled={w.id === currentId || w.users.some((u) => u.role === 'admin')}
                        onClick={() => setRemoving(w)}
                      >
                        <Icon name="trash" size={16} />
                      </button>
                      <button
                        className="sm"
                        disabled={w.id === currentId}
                        onClick={async () => {
                          await api.switchWorkspace(w.id);
                          sessionStorage.setItem('lawhub.pickedWorkspace', '1');
                          window.location.reload();
                        }}
                      >
                        Acessar <Icon name="right" size={14} />
                      </button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {removing && (
        <DeleteModal
          client={removing}
          onClose={() => setRemoving(null)}
          onDeleted={() => {
            setRemoving(null);
            load();
          }}
        />
      )}
      {creating && (
        <ClientModal
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            load();
          }}
        />
      )}
      {editing && (
        <ClientModal
          client={editing}
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

function ClientModal({ client, onClose, onSaved }: { client?: AdminWorkspace; onClose: () => void; onSaved: () => void }) {
  const isNew = !client;
  const [name, setName] = useState(client?.name ?? '');
  const [plan, setPlan] = useState(client?.plan ?? 'MENSAL');
  const [expiresAt, setExpiresAt] = useState(client?.expiresAt ?? '');
  const [userName, setUserName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [resetUser, setResetUser] = useState(client?.users.find((u) => u.role === 'user')?.id ?? client?.users[0]?.id ?? '');
  const [newPass, setNewPass] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      if (isNew) {
        await api.adminCreateWorkspace({ name, plan, expiresAt: expiresAt || null, userName, email, password });
      } else {
        await api.adminUpdateWorkspace(client.id, { name, plan, expiresAt: expiresAt || null });
        if (newPass) await api.adminSetPassword(resetUser, newPass);
      }
      onSaved();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>{isNew ? 'Novo cliente' : `Editar ${client.name}`}</h3>
        <div className="field">
          <label htmlFor="cl-name">Nome do cliente (escritório)</label>
          <input id="cl-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </div>
        <div className="duo">
          <div className="field">
            <label htmlFor="cl-plan">Plano</label>
            <select id="cl-plan" value={plan} onChange={(e) => setPlan(e.target.value)}>
              <option value="MENSAL">Mensal</option>
              <option value="CLIENTE">Cliente (sem vencimento)</option>
              <option value="TESTE">Teste</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="cl-exp">Vencimento</label>
            <input id="cl-exp" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </div>
        </div>

        {isNew ? (
          <>
            <div className="sec-h" style={{ marginTop: 6 }}>
              Login do cliente
            </div>
            <div className="field">
              <label htmlFor="cl-uname">Nome do responsável</label>
              <input id="cl-uname" value={userName} onChange={(e) => setUserName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="cl-email">E-mail de acesso</label>
              <input id="cl-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="cl-pass">Senha inicial</label>
              <input
                id="cl-pass"
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
              <span className="muted small">Envie ao cliente; ele pode trocar em Configurações.</span>
            </div>
          </>
        ) : (
          client.users.length > 0 && (
            <>
              <div className="sec-h" style={{ marginTop: 6 }}>
                Redefinir senha
              </div>
              <div className="duo">
                <div className="field">
                  <label htmlFor="cl-ruser">Usuário</label>
                  <select id="cl-ruser" value={resetUser} onChange={(e) => setResetUser(e.target.value)}>
                    {client.users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.email}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="cl-npass">Nova senha</label>
                  <input
                    id="cl-npass"
                    type="text"
                    value={newPass}
                    onChange={(e) => setNewPass(e.target.value)}
                    minLength={8}
                    placeholder="Deixe vazio para manter"
                  />
                </div>
              </div>
            </>
          )
        )}

        {err && <div className="alert">{err}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Salvando…' : isNew ? 'Criar cliente' : 'Salvar'}
          </button>
        </div>
      </form>
    </div>
  );
}

function DeleteModal({ client, onClose, onDeleted }: { client: AdminWorkspace; onClose: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const matches = typed.trim() === client.name;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!matches) return;
          setBusy(true);
          setErr('');
          try {
            await api.adminDeleteWorkspace(client.id, typed.trim());
            onDeleted();
          } catch (x) {
            setErr((x as Error).message);
            setBusy(false);
          }
        }}
      >
        <h3>Excluir {client.name}?</h3>
        <p className="muted">
          Isso apaga de vez os logins, o WhatsApp conectado, contatos ({client.contacts}), conversas, agentes, funis,
          tarefas e agenda deste cliente. Não dá para desfazer.
        </p>
        <p className="muted small" style={{ marginTop: 6 }}>
          Para manter os dados, prefira desligar o <b>Acesso</b>.
        </p>
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="del-name">
            Digite <b>{client.name}</b> para confirmar
          </label>
          <input id="del-name" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
        </div>
        {err && <div className="alert">{err}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button className="danger" disabled={!matches || busy}>
            {busy ? 'Excluindo…' : 'Excluir cliente'}
          </button>
        </div>
      </form>
    </div>
  );
}
