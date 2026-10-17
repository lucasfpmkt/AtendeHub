import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type Board,
  type Deal,
  type Funnel,
  type Stage,
  type Tag,
  type Contact,
} from '../api';
import { Icon } from '../icons';

const AV = ['#3b82f6', '#8b5cf6', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899', '#64748b'];
const avatarColor = (s: string) => AV[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % AV.length];

const BRL = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const STAGE_COLORS = ['#64748b', '#f59e0b', '#3b82f6', '#16a34a', '#b71312', '#8b5cf6', '#06b6d4', '#ec4899'];

export function Pipeline() {
  const [funnels, setFunnels] = useState<Funnel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(
    () => localStorage.getItem('lawhub.funnel') ?? null,
  );
  const [board, setBoard] = useState<Board | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [view, setView] = useState<'kanban' | 'list'>('kanban');
  const [dragDeal, setDragDeal] = useState<string | null>(null);
  const [dragStage, setDragStage] = useState<string | null>(null);
  const [dropStage, setDropStage] = useState<string | null>(null);
  const [dealModal, setDealModal] = useState<{ deal: Deal | null; stageId: string } | null>(null);
  const [stageModalOpen, setStageModalOpen] = useState(false);

  const tagColor = useMemo(() => {
    const m = new Map<string, string>();
    tags.forEach((t) => m.set(t.name.toLowerCase(), t.color));
    return m;
  }, [tags]);

  const loadFunnels = () =>
    api.funnels().then((fs) => {
      setFunnels(fs);
      setActiveId((cur) => cur ?? fs[0]?.id ?? null);
    });

  const loadBoard = (id: string) => api.board(id).then(setBoard);

  useEffect(() => {
    loadFunnels();
    api.tags().then(setTags);
    api.contacts().then(setContacts);
  }, []);

  useEffect(() => {
    if (activeId) {
      localStorage.setItem('lawhub.funnel', activeId);
      loadBoard(activeId);
    }
  }, [activeId]);

  const refresh = () => activeId && loadBoard(activeId);

  const addFunnel = async () => {
    const name = prompt('Nome do novo funil:');
    if (!name) return;
    const f = await api.addFunnel(name);
    await loadFunnels();
    setActiveId(f.id);
  };

  const onDrop = async (targetStageId: string) => {
    setDropStage(null);
    // Reordenar colunas: soltou o cabeçalho de uma etapa sobre outra.
    if (dragStage) {
      const src = dragStage;
      setDragStage(null);
      if (src !== targetStageId) await reorderStage(src, targetStageId);
      return;
    }
    // Mover negócio entre etapas.
    if (!dragDeal) return;
    const deal = dragDeal;
    setDragDeal(null);
    await api.updateDeal(deal, { stageId: targetStageId });
    refresh();
  };

  const reorderStage = async (sourceId: string, targetId: string) => {
    if (!board) return;
    const stages = [...board.stages];
    const from = stages.findIndex((s) => s.id === sourceId);
    const to = stages.findIndex((s) => s.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = stages.splice(from, 1);
    stages.splice(to, 0, moved);
    setBoard({ ...board, stages }); // atualização otimista (mostra na hora)
    await Promise.all(
      stages.map((s, i) => (s.order === i ? null : api.updateStage(s.id, { order: i }))),
    );
    refresh();
  };

  const exportCsv = async () => {
    if (!activeId) return;
    const blob = await api.exportFunnel(activeId);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${board?.funnel.name ?? 'funil'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const allDeals = board?.stages.flatMap((s) => s.deals.map((d) => ({ ...d, stageName: s.name }))) ?? [];

  return (
    <div className="funnel-layout">
      <aside className="funnel-side">
        <h4>FUNIS</h4>
        {funnels.map((f) => (
          <div
            key={f.id}
            className={`funnel-item ${f.id === activeId ? 'active' : ''}`}
            onClick={() => setActiveId(f.id)}
          >
            {f.name}
          </div>
        ))}
        <button className="ghost" style={{ width: '100%', marginTop: 8, justifyContent: 'flex-start' }} onClick={addFunnel}>
          <Icon name="plus" size={16} /> Novo funil
        </button>
      </aside>

      <div className="funnel-main">
        <div className="funnel-head">
          <div>
            <h1 className="h1">{board?.funnel.name ?? 'Funil'}</h1>
            <p className="sub">
              {allDeals.length} {allDeals.length === 1 ? 'negócio' : 'negócios'} ·{' '}
              {BRL(allDeals.reduce((s, d) => s + d.valueCents, 0))}
            </p>
          </div>
          <div className="toolbar">
            <div className="segmented">
              <button className={view === 'kanban' ? 'active' : ''} onClick={() => setView('kanban')}>
                Kanban
              </button>
              <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
                Lista
              </button>
            </div>
            <button onClick={exportCsv}>
              <Icon name="share" size={16} /> Exportar
            </button>
            <button onClick={() => setStageModalOpen(true)}>
              <Icon name="plus" size={16} /> Etapa
            </button>
            <button
              className="primary"
              onClick={() => setDealModal({ deal: null, stageId: board?.stages[0]?.id ?? '' })}
            >
              <Icon name="plus" size={16} /> Nova
            </button>
          </div>
        </div>

        {view === 'kanban' ? (
          <div className="board">
            {board?.stages.map((stage) => (
              <KanbanColumn
                key={stage.id}
                stage={stage}
                tagColor={tagColor}
                isDropTarget={dropStage === stage.id}
                onDragOverCol={() => setDropStage(stage.id)}
                onDrop={() => onDrop(stage.id)}
                onDragStartStage={() => setDragStage(stage.id)}
                onDragStartDeal={setDragDeal}
                onOpenDeal={(d) => setDealModal({ deal: d, stageId: stage.id })}
                onNewDeal={() => setDealModal({ deal: null, stageId: stage.id })}
                onDeleteStage={async () => {
                  if (confirm(`Excluir a etapa "${stage.name}"? Os negócios dela ficam sem etapa.`)) {
                    await api.deleteStage(stage.id);
                    refresh();
                  }
                }}
              />
            ))}
            {board && board.stages.length === 0 && (
              <p className="muted" style={{ padding: 20 }}>
                Esse funil ainda não tem etapas. Clique em "+ Etapa" para criar a primeira.
              </p>
            )}
          </div>
        ) : (
          <div style={{ padding: 22, overflow: 'auto' }}>
            <div className="card" style={{ padding: 0 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Negócio</th>
                    <th>Etapa</th>
                    <th>Contato</th>
                    <th>Valor</th>
                    <th>Origem</th>
                    <th>Responsável</th>
                  </tr>
                </thead>
                <tbody>
                  {allDeals.map((d) => (
                    <tr key={d.id} style={{ cursor: 'pointer' }} onClick={() => setDealModal({ deal: d, stageId: d.stageId ?? '' })}>
                      <td>{d.title}</td>
                      <td>{d.stageName}</td>
                      <td>{d.contact?.name || d.contact?.phone || '—'}</td>
                      <td>{BRL(d.valueCents)}</td>
                      <td>{d.source || '—'}</td>
                      <td>{d.responsavel || '—'}</td>
                    </tr>
                  ))}
                  {allDeals.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted">
                        Nenhum negócio ainda. Crie o primeiro em "+ Nova negociação".
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {dealModal && (
        <DealModal
          funnelId={activeId!}
          stages={board?.stages ?? []}
          contacts={contacts}
          initial={dealModal.deal}
          defaultStageId={dealModal.stageId}
          onClose={() => setDealModal(null)}
          onSaved={() => {
            setDealModal(null);
            refresh();
          }}
        />
      )}

      {stageModalOpen && (
        <StageModal
          onClose={() => setStageModalOpen(false)}
          onCreate={async (name, color) => {
            await api.addStage(activeId!, name, color);
            setStageModalOpen(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function KanbanColumn({
  stage,
  tagColor,
  isDropTarget,
  onDragOverCol,
  onDrop,
  onDragStartStage,
  onDragStartDeal,
  onOpenDeal,
  onNewDeal,
  onDeleteStage,
}: {
  stage: Stage;
  tagColor: Map<string, string>;
  isDropTarget: boolean;
  onDragOverCol: () => void;
  onDrop: () => void;
  onDragStartStage: () => void;
  onDragStartDeal: (id: string) => void;
  onOpenDeal: (d: Deal) => void;
  onNewDeal: () => void;
  onDeleteStage: () => void;
}) {
  const sum = stage.deals.reduce((s, d) => s + d.valueCents, 0);
  return (
    <div
      className={`column ${isDropTarget ? 'drop-target' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOverCol();
      }}
      onDrop={onDrop}
    >
      <div
        className="column-head"
        draggable
        onDragStart={(e) => {
          e.stopPropagation();
          onDragStartStage();
        }}
        title="Arraste para reordenar esta etapa"
        style={{ cursor: 'grab' }}
      >
        <span className="dot" style={{ background: stage.color }} />
        <span className="name">{stage.name}</span>
        <span className="count">{stage.deals.length}</span>
        {sum > 0 && <span className="sum">{BRL(sum)}</span>}
        <button className="icon-btn" title="Excluir etapa" aria-label="Excluir etapa" onClick={onDeleteStage}>
          <Icon name="x" size={15} />
        </button>
      </div>
      <div className="column-body">
        {stage.deals.map((d) => (
          <div
            key={d.id}
            className="deal"
            draggable
            onDragStart={() => onDragStartDeal(d.id)}
            onClick={() => onOpenDeal(d)}
          >
            <div className="deal-top">
              <span className="avatar" style={{ background: avatarColor(d.contact?.name || d.title) }}>
                {(d.contact?.name || d.title).trim()[0]?.toUpperCase() ?? '?'}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="title">
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.contact?.name || d.title}
                  </span>
                  <span className="value">{BRL(d.valueCents)}</span>
                </div>
                <div className="meta">
                  {d.contact?.phone && (
                    <span className="mono">
                      <Icon name="phone" size={12} /> +{d.contact.phone}
                    </span>
                  )}
                  {d.contact?.name && d.title !== d.contact.name && <span>{d.title}</span>}
                </div>
              </div>
            </div>
            <div className="deal-foot">
              <span>
                <Icon name="date" size={13} /> {new Date(d.createdAt).toLocaleDateString('pt-BR')}
              </span>
              <span>
                <Icon name="user" size={13} /> {d.responsavel || 'Sem responsável'}
              </span>
              {d.contact && <span className="pill wa">WA</span>}
            </div>
            {d.tags && (
              <div className="tags">
                {d.tags
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean)
                  .map((t) => (
                    <span className="tag" key={t}>
                      <span className="swatch" style={{ background: tagColor.get(t.toLowerCase()) ?? '#b71312' }} />
                      {t}
                    </span>
                  ))}
              </div>
            )}
          </div>
        ))}
        {stage.deals.length === 0 && <div className="empty-col">Arraste cards para cá</div>}
        <button className="ghost sm" onClick={onNewDeal}>
          <Icon name="plus" size={14} /> Negócio
        </button>
      </div>
    </div>
  );
}

function DealModal({
  funnelId,
  stages,
  contacts,
  initial,
  defaultStageId,
  onClose,
  onSaved,
}: {
  funnelId: string;
  stages: Stage[];
  contacts: Contact[];
  initial: Deal | null;
  defaultStageId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [value, setValue] = useState(initial ? (initial.valueCents / 100).toString() : '');
  const [stageId, setStageId] = useState(initial?.stageId ?? defaultStageId);
  const [contactId, setContactId] = useState(initial?.contact?.id ?? '');
  const [source, setSource] = useState(initial?.source ?? '');
  const [responsavel, setResponsavel] = useState(initial?.responsavel ?? '');
  const [tags, setTags] = useState(initial?.tags ?? '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!title.trim()) return;
    setBusy(true);
    const data = {
      title,
      valueCents: Math.round(parseFloat(value.replace(',', '.') || '0') * 100),
      stageId,
      contactId: contactId || null,
      source,
      responsavel,
      tags,
      funnelId,
    };
    try {
      if (initial) await api.updateDeal(initial.id, data as Partial<Deal>);
      else await api.addDeal(data as Partial<Deal> & { funnelId: string });
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!initial) return;
    if (confirm('Excluir esta negociação?')) {
      await api.deleteDeal(initial.id);
      onSaved();
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{initial ? 'Editar negociação' : 'Nova negociação'}</h3>
        <div className="field">
          <label>Título</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus placeholder="Ex.: Caso Rescisão - João" />
        </div>
        <div className="row" style={{ alignItems: 'stretch' }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Valor (R$)</label>
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="0,00" inputMode="decimal" />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Etapa</label>
            <select value={stageId} onChange={(e) => setStageId(e.target.value)}>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label>Contato</label>
          <select value={contactId} onChange={(e) => setContactId(e.target.value)}>
            <option value="">— sem contato —</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name || c.phone}
              </option>
            ))}
          </select>
        </div>
        <div className="row" style={{ alignItems: 'stretch' }}>
          <div className="field" style={{ flex: 1 }}>
            <label>Origem</label>
            <input value={source ?? ''} onChange={(e) => setSource(e.target.value)} placeholder="WhatsApp, Indicação…" />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Responsável</label>
            <input value={responsavel ?? ''} onChange={(e) => setResponsavel(e.target.value)} placeholder="Nome" />
          </div>
        </div>
        <div className="field">
          <label>Etiquetas (separadas por vírgula)</label>
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="Lead Qualificado, Urgente" />
        </div>
        <div className="modal-actions">
          {initial && (
            <button className="ghost" style={{ color: 'var(--primary)', marginRight: 'auto' }} onClick={remove}>
              Excluir
            </button>
          )}
          <button className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary" onClick={save} disabled={busy}>
            {busy ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
}

function StageModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, color: string) => void;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(STAGE_COLORS[0]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Nova etapa</h3>
        <div className="field">
          <label>Nome</label>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Ex.: Em negociação" />
        </div>
        <div className="field">
          <label>Cor</label>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {STAGE_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                style={{
                  width: 28,
                  height: 28,
                  padding: 0,
                  borderRadius: '50%',
                  background: c,
                  border: color === c ? '3px solid var(--text)' : '2px solid var(--border)',
                }}
                aria-label={c}
              />
            ))}
          </div>
        </div>
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary" onClick={() => name.trim() && onCreate(name, color)}>
            Criar etapa
          </button>
        </div>
      </div>
    </div>
  );
}
