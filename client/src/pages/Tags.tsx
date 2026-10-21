import { useEffect, useState } from 'react';
import { api, type Tag } from '../api';
import { Icon } from '../icons';

const COLORS = ['#b71312', '#dc2626', '#ea580c', '#eab308', '#16a34a', '#14b8a6', '#0891b2', '#2563eb', '#6366f1', '#a855f7', '#db2777', '#64748b'];

export function Tags() {
  const [tags, setTags] = useState<Tag[]>([]);
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[4]);
  const [editing, setEditing] = useState<Tag | null>(null);

  const load = () => api.tags().then(setTags).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const add = async () => {
    if (!name.trim()) return;
    await api.addTag(name.trim(), color);
    setName('');
    load();
  };
  const saveEdit = async () => {
    if (!editing) return;
    await api.updateTag(editing.id, { name: editing.name, color: editing.color });
    setEditing(null);
    load();
  };
  const remove = async (t: Tag) => {
    if (!confirm(`Excluir a etiqueta "${t.name}"? Ela some do catálogo (contatos já marcados mantêm o texto).`)) return;
    await api.deleteTag(t.id);
    load();
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h1">Etiquetas</h1>
          <p className="sub">Organize os contatos com etiquetas coloridas. A IA pode aplicá-las automaticamente.</p>
        </div>
      </div>

      <div className="grid2">
        <div className="card stack">
          <h3 className="card-title">
            <Icon name="tag" /> Nova etiqueta
          </h3>
          <div className="field-sm">
            <span>Nome</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Qualificado" onKeyDown={(e) => e.key === 'Enter' && add()} />
          </div>
          <div className="field-sm">
            <span>Cor</span>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  aria-label={c}
                  style={{ width: 28, height: 28, padding: 0, borderRadius: '50%', background: c, border: color === c ? '3px solid var(--text)' : '2px solid var(--border)' }}
                />
              ))}
            </div>
          </div>
          <div className="row">
            <button className="primary" onClick={add} disabled={!name.trim()}>
              <Icon name="plus" size={16} /> Criar etiqueta
            </button>
          </div>
          <span className="muted small">
            Dica: crie uma etiqueta <b>Qualificado</b> com uma cor marcante e vincule-a à etapa qualificada (no CRM, botão de
            relógio da etapa → "Etiqueta automática"). A IA aplica sozinha quando o lead chega lá.
          </span>
        </div>

        <div className="card">
          <h3 className="card-title">
            <Icon name="tag" /> Etiquetas ({tags.length})
          </h3>
          <table className="table">
            <thead>
              <tr>
                <th>Etiqueta</th>
                <th>Cor</th>
                <th style={{ textAlign: 'right' }}></th>
              </tr>
            </thead>
            <tbody>
              {tags.map((t) => (
                <tr key={t.id}>
                  <td>
                    <span className="tag">
                      <span className="swatch" style={{ background: t.color }} />
                      {t.name}
                    </span>
                  </td>
                  <td className="mono muted">{t.color}</td>
                  <td>
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <button className="sm" onClick={() => setEditing(t)}>
                        Editar
                      </button>
                      <button className="sm danger-text" onClick={() => remove(t)}>
                        Excluir
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {tags.length === 0 && (
                <tr>
                  <td colSpan={3} className="muted">
                    Nenhuma etiqueta ainda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Editar etiqueta</h3>
            <div className="field">
              <label>Nome</label>
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div className="field">
              <label>Cor</label>
              <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
                {COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setEditing({ ...editing, color: c })}
                    aria-label={c}
                    style={{ width: 28, height: 28, padding: 0, borderRadius: '50%', background: c, border: editing.color === c ? '3px solid var(--text)' : '2px solid var(--border)' }}
                  />
                ))}
              </div>
            </div>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setEditing(null)}>
                Cancelar
              </button>
              <button className="primary" onClick={saveEdit}>
                Salvar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
