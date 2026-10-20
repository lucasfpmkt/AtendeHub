import { useEffect, useState } from 'react';
import { api, type Contact } from '../api';

export function Contacts() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Contact | null>(null);

  const load = () => api.contacts(q).then(setContacts);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const save = async () => {
    if (!editing) return;
    await api.updateContact(editing.id, {
      name: editing.name,
      notes: editing.notes,
      tags: editing.tags,
    });
    setEditing(null);
    load();
  };

  const exportData = async (c: Contact) => {
    const blob = await api.exportContact(c.id);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dados-${c.phone || c.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const erase = async (c: Contact) => {
    if (!confirm(`Apagar TODOS os dados de ${c.name || c.phone}? Isso remove o contato, conversas, mensagens e mídia. Não dá para desfazer.`))
      return;
    await api.eraseContact(c.id);
    load();
  };

  return (
    <div className="page">
      <h1 className="h1">Contatos (CRM)</h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <input
          placeholder="Buscar por nome ou telefone…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ maxWidth: 320 }}
        />
      </div>

      <div className="card">
        <table className="table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Telefone</th>
              <th>Tags</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id}>
                <td>{c.name || <span className="muted">sem nome</span>}</td>
                <td>{c.phone}</td>
                <td>
                  {c.tags
                    ? c.tags.split(',').filter(Boolean).map((t) => (
                        <span className="tag" key={t}>
                          {t.trim()}
                        </span>
                      ))
                    : '—'}
                </td>
                <td>
                  <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                    <button onClick={() => setEditing(c)}>Editar</button>
                    <button className="soft" title="Exportar dados (LGPD)" onClick={() => exportData(c)}>
                      Exportar
                    </button>
                    <button className="danger-text" title="Apagar dados do titular (LGPD)" onClick={() => erase(c)}>
                      Excluir
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {contacts.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Nenhum contato. Eles aparecem aqui automaticamente quando
                  alguém manda mensagem.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <div className="card" style={{ marginTop: 16, maxWidth: 480 }}>
          <h3>Editar contato</h3>
          <label className="muted">Nome</label>
          <input
            value={editing.name ?? ''}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            style={{ marginBottom: 10 }}
          />
          <label className="muted">Tags (separadas por vírgula)</label>
          <input
            value={editing.tags ?? ''}
            onChange={(e) => setEditing({ ...editing, tags: e.target.value })}
            style={{ marginBottom: 10 }}
          />
          <label className="muted">Anotações</label>
          <textarea
            rows={3}
            value={editing.notes ?? ''}
            onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
            style={{ marginBottom: 10 }}
          />
          <div className="row">
            <button className="primary" onClick={save}>
              Salvar
            </button>
            <button onClick={() => setEditing(null)}>Cancelar</button>
          </div>
        </div>
      )}
    </div>
  );
}
