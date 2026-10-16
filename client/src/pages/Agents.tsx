import { useEffect, useState } from 'react';
import { api, type Agent } from '../api';

const DELAYS = [5, 10, 15, 20, 30, 45, 60];

const emptyAgent = (): Partial<Agent> => ({
  name: '',
  type: 'theme',
  description: '',
  script: '',
  triggers: '',
  delaySeconds: 15,
  active: true,
});

export function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [connected, setConnected] = useState(false);
  const [editing, setEditing] = useState<Partial<Agent> | null>(null);

  const load = () =>
    api.agents().then((r) => {
      setAgents(r.agents);
      setConnected(r.providerConnected);
    });

  useEffect(() => {
    load();
  }, []);

  const toggle = async (a: Agent) => {
    await api.updateAgent(a.id, { active: !a.active });
    load();
  };

  const triage = agents.filter((a) => a.type === 'triage' && a.active);
  const themes = agents.filter((a) => a.type === 'theme' && a.active);
  const inactive = agents.filter((a) => !a.active);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h1">Agentes IA</h1>
          <p className="sub">Crie um agente com um roteiro de atendimento e deixe a IA conduzir pelo WhatsApp.</p>
        </div>
        <button className="primary" onClick={() => setEditing(emptyAgent())}>
          + Novo agente
        </button>
      </div>

      {!connected && (
        <div className="banner">
          <span>⚠️</span>
          <span>
            A IA ainda não está conectada. Defina a variável <code>ANTHROPIC_API_KEY</code> no
            Easypanel para os agentes responderem de verdade. Você já pode criar e configurar os
            agentes agora.
          </span>
        </div>
      )}

      <AgentGroup
        label={<>Triagem <b>— recebe toda conversa e direciona</b></>}
        agents={triage}
        onEdit={setEditing}
        onToggle={toggle}
        emptyText="Nenhum agente de triagem ativo. Crie um do tipo Triagem para rotear os atendimentos."
      />
      <AgentGroup
        label={<>Agentes de tema <b>— recebem a transferência</b></>}
        agents={themes}
        onEdit={setEditing}
        onToggle={toggle}
        emptyText="Nenhum agente de tema ativo ainda."
      />
      {inactive.length > 0 && (
        <AgentGroup label={<>Inativos</>} agents={inactive} onEdit={setEditing} onToggle={toggle} />
      )}

      {editing && (
        <AgentEditor
          initial={editing}
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

function AgentGroup({
  label,
  agents,
  onEdit,
  onToggle,
  emptyText,
}: {
  label: React.ReactNode;
  agents: Agent[];
  onEdit: (a: Agent) => void;
  onToggle: (a: Agent) => void;
  emptyText?: string;
}) {
  return (
    <div className="agent-group">
      <p className="label">{label}</p>
      {agents.length === 0 ? (
        emptyText ? <p className="muted" style={{ fontSize: 13.5 }}>{emptyText}</p> : null
      ) : (
        <div className="agent-list">
          {agents.map((a) => {
            const triggers = a.triggers.split(/[,;\n]/).map((t) => t.trim()).filter(Boolean);
            return (
              <div className="agent-card" key={a.id}>
                <div className="ava">{a.type === 'triage' ? '🧭' : '🤖'}</div>
                <div className="info" onClick={() => onEdit(a)} style={{ cursor: 'pointer' }}>
                  <div className="nm">{a.name}</div>
                  <div className="ds">{a.description || (a.type === 'triage' ? 'Agente de triagem' : 'Sem descrição')}</div>
                </div>
                <div className="trig">{triggers.length} {triggers.length === 1 ? 'gatilho' : 'gatilhos'}</div>
                <button onClick={() => onEdit(a)}>Editar</button>
                <button
                  className={`switch ${a.active ? 'on' : ''}`}
                  title={a.active ? 'Ativo' : 'Inativo'}
                  onClick={() => onToggle(a)}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AgentEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: Partial<Agent>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [a, setA] = useState<Partial<Agent>>(initial);
  const [busy, setBusy] = useState(false);
  const isEdit = Boolean(initial.id);
  const set = (patch: Partial<Agent>) => setA((cur) => ({ ...cur, ...patch }));

  const save = async () => {
    if (!a.name?.trim()) return;
    setBusy(true);
    try {
      if (isEdit) await api.updateAgent(a.id!, a);
      else await api.addAgent(a);
      onSaved();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (isEdit && confirm(`Excluir o agente "${a.name}"?`)) {
      await api.deleteAgent(a.id!);
      onSaved();
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>{isEdit ? 'Editar agente' : 'Novo agente'}</h3>

        <div className="row" style={{ alignItems: 'stretch' }}>
          <div className="field" style={{ flex: 2 }}>
            <label>Nome do agente</label>
            <input value={a.name ?? ''} onChange={(e) => set({ name: e.target.value })} autoFocus placeholder="Ex.: Perícia Negada" />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Tipo</label>
            <select value={a.type} onChange={(e) => set({ type: e.target.value as Agent['type'] })}>
              <option value="triage">Triagem</option>
              <option value="theme">Tema</option>
            </select>
          </div>
        </div>

        <div className="field">
          <label>Descrição do tema {a.type === 'theme' && '(a triagem usa isso para decidir)'}</label>
          <input
            value={a.description ?? ''}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="Ex.: Casos de perícia do INSS negada (auxílio-doença, invalidez)"
          />
        </div>

        <div className="field">
          <label>Palavras-gatilho (separadas por vírgula)</label>
          <input
            value={a.triggers ?? ''}
            onChange={(e) => set({ triggers: e.target.value })}
            placeholder="perícia negada, auxílio-doença negado, benefício indeferido"
          />
        </div>

        <div className="field">
          <label>Delay de resposta — tempo que o agente aguarda o cliente terminar de digitar</label>
          <div className="chips">
            {DELAYS.map((d) => (
              <button
                key={d}
                className={a.delaySeconds === d ? 'active' : ''}
                onClick={() => set({ delaySeconds: d })}
              >
                {d}s
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Diretório — o roteiro que o agente segue no atendimento</label>
          <textarea
            className="script-area"
            value={a.script ?? ''}
            onChange={(e) => set({ script: e.target.value })}
            placeholder="Cole aqui o roteiro completo do atendimento (persona, etapas, regras, mensagens…)."
          />
        </div>

        <label className="toggle" style={{ marginTop: 4 }}>
          <input type="checkbox" checked={a.active ?? true} onChange={(e) => set({ active: e.target.checked })} />
          Agente ativo
        </label>

        <div className="modal-actions">
          {isEdit && (
            <button className="ghost" style={{ color: 'var(--primary)', marginRight: 'auto' }} onClick={remove}>
              Excluir
            </button>
          )}
          <button className="ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary" onClick={save} disabled={busy}>
            {busy ? 'Salvando…' : 'Salvar agente'}
          </button>
        </div>
      </div>
    </div>
  );
}
