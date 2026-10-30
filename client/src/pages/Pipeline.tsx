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
import { socket } from '../socket';
import { Switch } from './Agents';

const AV = ['#3b82f6', '#8b5cf6', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899', '#64748b'];
const avatarColor = (s: string) => AV[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % AV.length];

const BRL = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const STAGE_COLORS = ['#64748b', '#f59e0b', '#3b82f6', '#16a34a', '#b71312', '#8b5cf6', '#06b6d4', '#ec4899'];

export function Pipeline({ onOpenConversation }: { onOpenConversation?: (contactId: string) => void }) {
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
  const [editStage, setEditStage] = useState<Stage | null>(null);
  const [fuOpen, setFuOpen] = useState(false);
  const [fuOn, setFuOn] = useState<boolean | null>(null);
  useEffect(() => {
    api.followupsConfig().then((c) => setFuOn(c.enabled)).catch(() => setFuOn(null));
  }, []);

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

  // Atualiza o quadro em tempo real quando a IA (ou outra ação) mexe no CRM.
  useEffect(() => {
    const onCrm = () => {
      const id = localStorage.getItem('lawhub.funnel');
      if (id) loadBoard(id);
    };
    socket.on('crm:update', onCrm);
    return () => {
      socket.off('crm:update', onCrm);
    };
  }, []);

  const refresh = () => activeId && loadBoard(activeId);

  const addFunnel = async () => {
    const name = prompt('Nome do novo funil:');
    if (!name) return;
    const f = await api.addFunnel(name);
    await loadFunnels();
    setActiveId(f.id);
  };
  const renameFunnel = async (f: Funnel) => {
    const name = prompt('Novo nome do funil:', f.name);
    if (!name || !name.trim() || name.trim() === f.name) return;
    await api.renameFunnel(f.id, name.trim());
    await loadFunnels();
  };
  const deleteFunnel = async (f: Funnel) => {
    if (funnels.length <= 1) {
      alert('Mantenha ao menos um funil. Crie outro antes de apagar este.');
      return;
    }
    if (!confirm(`Apagar o funil "${f.name}"? Todas as etapas e negócios dele serão apagados. Esta ação não pode ser desfeita.`)) return;
    await api.deleteFunnel(f.id);
    const fs = await api.funnels();
    setFunnels(fs);
    setActiveId((cur) => (cur === f.id || !cur ? fs[0]?.id ?? null : cur));
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
            <span className="funnel-name">{f.name}</span>
            <span className="funnel-actions">
              <button
                className="icon-btn"
                title="Renomear funil"
                aria-label="Renomear funil"
                onClick={(e) => {
                  e.stopPropagation();
                  renameFunnel(f);
                }}
              >
                <Icon name="pen" size={13} />
              </button>
              <button
                className="icon-btn"
                title="Apagar funil"
                aria-label="Apagar funil"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteFunnel(f);
                }}
              >
                <Icon name="trash" size={13} />
              </button>
            </span>
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
            <button onClick={() => setFuOpen(true)} disabled={!board} title="Follow-ups automáticos por etapa">
              <Icon name="clock" size={16} /> Follow-ups
              <span className={`fu-dot ${fuOn ? 'on' : ''}`} aria-label={fuOn ? 'ligados' : 'desligados'} />
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
                onOpenConversation={onOpenConversation}
                onEditStage={() => setEditStage(stage)}
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
          tags={tags}
          onClose={() => setStageModalOpen(false)}
          onSave={async ({ name, color, followupMinutes, followupMessage, autoTag }) => {
            const s = await api.addStage(activeId!, name, color);
            if (followupMinutes > 0 || autoTag) await api.updateStage(s.id, { followupMinutes, followupMessage, autoTag });
            setStageModalOpen(false);
            refresh();
          }}
        />
      )}
      {fuOpen && board && (
        <FollowupsModal
          board={board}
          onClose={() => setFuOpen(false)}
          onEnabled={setFuOn}
          onSaved={() => {
            setFuOpen(false);
            refresh();
          }}
        />
      )}
      {editStage && (
        <StageModal
          stage={editStage}
          tags={tags}
          onClose={() => setEditStage(null)}
          onSave={async (data) => {
            await api.updateStage(editStage.id, data);
            setEditStage(null);
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
  onOpenConversation,
  onEditStage,
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
  onOpenConversation?: (contactId: string) => void;
  onEditStage: () => void;
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
        {stage.followupMinutes > 0 && (
          <span className="count" title={`Follow-up após ${stage.followupMinutes} min`} style={{ color: '#ea580c' }}>
            <Icon name="clock" size={13} />
          </span>
        )}
        <button
          className="icon-btn"
          title="Follow-up automático desta etapa"
          aria-label="Follow-up da etapa"
          onClick={(e) => {
            e.stopPropagation();
            onEditStage();
          }}
        >
          <Icon name="clock" size={15} />
        </button>
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
              {d.agentName && (
                <span title="Agente de IA da conversa">
                  <Icon name="bot" size={13} /> {d.agentName}
                </span>
              )}
              {d.contact &&
                (onOpenConversation ? (
                  <button
                    className="pill wa as-btn"
                    title="Abrir conversa"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (d.contact) onOpenConversation(d.contact.id);
                    }}
                  >
                    <Icon name="chat" size={12} /> Abrir conversa
                  </button>
                ) : (
                  <span className="pill wa">WA</span>
                ))}
            </div>
            {(() => {
              // Etiquetas do contato (onde a IA grava) + etiquetas do negócio, sem repetir.
              // A etapa já é a coluna do card, então não repete o nome dela como etiqueta.
              const seen = new Set<string>([stage.name.trim().toLowerCase()]);
              const all: string[] = [];
              for (const raw of `${d.contact?.tags ?? ''},${d.tags ?? ''}`.split(',')) {
                const t = raw.trim();
                if (t && !seen.has(t.toLowerCase())) {
                  seen.add(t.toLowerCase());
                  all.push(t);
                }
              }
              if (all.length === 0) return null;
              return (
                <div className="tags">
                  {all.map((t) => (
                    <span className="tag" key={t}>
                      <span className="swatch" style={{ background: tagColor.get(t.toLowerCase()) ?? '#16a34a' }} />
                      {t}
                    </span>
                  ))}
                </div>
              );
            })()}
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
  stage,
  tags,
  onClose,
  onSave,
}: {
  stage?: Stage | null;
  tags: Tag[];
  onClose: () => void;
  onSave: (data: { name: string; color: string; followupMinutes: number; followupMessage: string; autoTag: string }) => void;
}) {
  const editing = Boolean(stage);
  const [name, setName] = useState(stage?.name ?? '');
  const [color, setColor] = useState(stage?.color ?? STAGE_COLORS[0]);
  const [fupOn, setFupOn] = useState((stage?.followupMinutes ?? 0) > 0);
  const [fupMin, setFupMin] = useState(String(stage?.followupMinutes || 60));
  const [fupMsg, setFupMsg] = useState(stage?.followupMessage ?? '');
  const [autoTag, setAutoTag] = useState(stage?.autoTag ?? '');
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{editing ? `Etapa “${stage!.name}”` : 'Nova etapa'}</h3>
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

        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={fupOn} onChange={(e) => setFupOn(e.target.checked)} style={{ width: 16, flex: 'none' }} />
            Follow-up automático nesta etapa
          </label>
          <span className="muted small">Se o lead ficar parado aqui pelo tempo abaixo, o LawHub envia a mensagem pelo WhatsApp (uma vez por etapa).</span>
        </div>
        {fupOn && (
          <>
            <div className="field">
              <label>Enviar após (minutos)</label>
              <input
                type="number"
                min={1}
                value={fupMin}
                onChange={(e) => setFupMin(e.target.value)}
                placeholder="60"
                style={{ maxWidth: 160 }}
              />
            </div>
            <div className="field">
              <label>Mensagem do follow-up</label>
              <textarea
                rows={3}
                value={fupMsg}
                onChange={(e) => setFupMsg(e.target.value)}
                placeholder="Ex.: Oi! Ainda quer seguir com a análise do seu caso? Fico à disposição."
              />
            </div>
          </>
        )}

        <div className="field">
          <label>Etiqueta automática ao entrar nesta etapa</label>
          <select value={autoTag} onChange={(e) => setAutoTag(e.target.value)}>
            <option value="">Nenhuma</option>
            {tags.map((t) => (
              <option key={t.id} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
          <span className="muted small">A IA aplica essa etiqueta ao lead assim que ele chega aqui (ex.: "Qualificado").</span>
        </div>

        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            className="primary"
            onClick={() => {
              if (!name.trim()) return;
              const minutes = fupOn ? Math.max(1, Number(fupMin) || 0) : 0;
              onSave({ name: name.trim(), color, followupMinutes: minutes, followupMessage: fupOn ? fupMsg : '', autoTag });
            }}
          >
            {editing ? 'Salvar etapa' : 'Criar etapa'}
          </button>
        </div>
      </div>
    </div>
  );
}

type Unit = 'min' | 'h' | 'd';
const UNIT_MIN: Record<Unit, number> = { min: 1, h: 60, d: 1440 };
const splitMinutes = (m: number): { n: number; unit: Unit } =>
  m > 0 && m % 1440 === 0 ? { n: m / 1440, unit: 'd' } : m > 0 && m % 60 === 0 ? { n: m / 60, unit: 'h' } : { n: m || 24, unit: m ? 'min' : 'h' };

interface FuRow {
  id: string;
  name: string;
  color: string;
  on: boolean;
  n: number;
  unit: Unit;
  message: string;
  orig: { minutes: number; message: string };
}

/** Follow-ups automáticos: chave geral do cliente + tempo/mensagem por etapa (a IA sugere, o usuário aprova). */
function FollowupsModal({
  board,
  onClose,
  onSaved,
  onEnabled,
}: {
  board: Board;
  onClose: () => void;
  onSaved: () => void;
  onEnabled: (on: boolean) => void;
}) {
  const [cfg, setCfg] = useState<{ enabled: boolean; since: string | null } | null>(null);
  const [rows, setRows] = useState<FuRow[]>(() =>
    board.stages.map((st) => {
      const { n, unit } = splitMinutes(st.followupMinutes);
      return {
        id: st.id,
        name: st.name,
        color: st.color,
        on: st.followupMinutes > 0,
        n,
        unit,
        message: st.followupMessage,
        orig: { minutes: st.followupMinutes, message: st.followupMessage },
      };
    }),
  );
  const [busy, setBusy] = useState<'' | 'ai' | 'save' | 'switch'>('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    api.followupsConfig().then(setCfg).catch((e) => setErr((e as Error).message));
  }, []);

  const patch = (id: string, p: Partial<FuRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));

  const toggle = async (on: boolean) => {
    setBusy('switch');
    setErr('');
    try {
      const c = await api.setFollowups(on);
      setCfg(c);
      onEnabled(c.enabled);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const suggest = async () => {
    setBusy('ai');
    setErr('');
    setNote('');
    try {
      const sug = await api.suggestFollowups(board.funnel.id);
      const by = new Map(sug.map((x) => [x.stageId, x]));
      setRows((rs) =>
        rs.map((r) => {
          const x = by.get(r.id);
          if (!x) return r;
          if (!x.minutes) return { ...r, on: false };
          const { n, unit } = splitMinutes(x.minutes);
          return { ...r, on: true, n, unit, message: x.message };
        }),
      );
      setNote('Sugestões da IA preenchidas. Revise e ajuste antes de salvar — nada é salvo sem você confirmar.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    const bad = rows.find((r) => r.on && (!r.message.trim() || !(r.n > 0)));
    if (bad) {
      setErr(`Etapa "${bad.name}": defina o tempo e a mensagem, ou desligue o follow-up dela.`);
      return;
    }
    setBusy('save');
    setErr('');
    try {
      for (const r of rows) {
        const minutes = r.on ? Math.round(r.n * UNIT_MIN[r.unit]) : 0;
        const message = r.on ? r.message.trim() : r.orig.message;
        if (minutes !== r.orig.minutes || message !== r.orig.message)
          await api.updateStage(r.id, { followupMinutes: minutes, followupMessage: message });
      }
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      setBusy('');
    }
  };

  const since = cfg?.since
    ? new Date(cfg.since).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>Follow-ups automáticos · {board.funnel.name}</h3>

        <div className="fu-head">
          <Switch on={!!cfg?.enabled} onChange={(v) => busy === '' && toggle(v)} label="Ligar follow-ups automáticos deste cliente" />
          <div>
            <b>{cfg == null ? 'Carregando…' : cfg.enabled ? 'Ligados para este cliente' : 'Desligados para este cliente'}</b>
            <div className="muted small">
              {cfg?.enabled && since ? `Valem para leads que entraram na etapa desde ${since}.` : 'Nenhuma mensagem automática é enviada enquanto estiver desligado.'}
            </div>
          </div>
        </div>

        <ul className="fu-rules muted">
          <li>Só envia se o lead não respondeu depois da última mensagem do escritório.</li>
          <li>Só para leads que chegaram na etapa depois de ligar — nada retroativo.</li>
          <li>Só em horário comercial (seg–sáb, 8h–20h). Use {'{nome}'} para o primeiro nome do lead.</li>
        </ul>

        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 14 }}>Mensagem por etapa</b>
          <button className="soft" onClick={suggest} disabled={busy !== ''}>
            <Icon name="sparkle" size={14} /> {busy === 'ai' ? 'A IA está escrevendo…' : 'Sugerir com IA'}
          </button>
        </div>
        {note && <div className="muted small" style={{ marginBottom: 10 }}>{note}</div>}

        {rows.map((r) => (
          <div key={r.id} className={`fu-stage ${r.on ? '' : 'off'}`}>
            <div className="fu-stage-top">
              <div className="row" style={{ gap: 8 }}>
                <Switch on={r.on} onChange={(v) => patch(r.id, { on: v })} label={`Follow-up da etapa ${r.name}`} />
                <span className="stage-dot" style={{ width: 8, height: 8, borderRadius: 99, background: r.color, display: 'inline-block' }} />
                <b>{r.name}</b>
              </div>
              {r.on && (
                <label className="fu-wait">
                  enviar após
                  <input
                    type="number"
                    min={1}
                    value={r.n}
                    onChange={(e) => patch(r.id, { n: Number(e.target.value) })}
                  />
                  <select value={r.unit} onChange={(e) => patch(r.id, { unit: e.target.value as Unit })}>
                    <option value="min">minutos</option>
                    <option value="h">horas</option>
                    <option value="d">dias</option>
                  </select>
                  sem resposta
                </label>
              )}
            </div>
            {r.on && (
              <textarea
                value={r.message}
                placeholder="Ex.: Oi {nome}, conseguiu ver a mensagem anterior? Fico à disposição para tirar suas dúvidas."
                onChange={(e) => patch(r.id, { message: e.target.value })}
              />
            )}
          </div>
        ))}

        {err && <div className="att-msg bad" style={{ marginTop: 10 }}>{err}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" onClick={save} disabled={busy !== ''}>
            {busy === 'save' ? 'Salvando…' : 'Salvar etapas'}
          </button>
        </div>
      </div>
    </div>
  );
}
