import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Agent, type AgentHistoryItem } from '../api';
import { Icon } from '../icons';

const DELAYS = [5, 10, 15, 20, 30, 45, 60];

const splitTriggers = (raw: string) =>
  raw
    .split(/[,;\n]/)
    .map((t) => t.trim())
    .filter(Boolean);

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/["“”.,!?]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/* Modelos de roteiro no formato da Guimoo (◆ Passo / 🚩 Situação / 💬 Mensagem / ⚡ Ação). */
const MODELOS: { name: string; type: Agent['type']; description: string; script: string }[] = [
  {
    name: 'Triagem jurídica',
    type: 'triage',
    description: 'Recebe o lead, entende o caso e transfere para o especialista',
    script: `◆ Passo 1 — Recepção

🚩 Situação: o lead acabou de chegar no WhatsApp.

💬 Mensagem: “Olá, é um prazer falar com você! Aqui é do escritório [Nome do escritório].

Pode me contar um resumo do seu caso com algumas palavrinhas? Assim eu entendo qual advogado especialista do nosso time pode te atender melhor.”

◆ Passo 2 — Identificação e direcionamento

🚩 Situação: o cliente respondeu com um resumo da demanda.

✅ 1. Se mencionar isenção de imposto de renda por doença grave (isenção de IR, moléstia grave, IR na aposentadoria ou pensão):

💬 Responder com: “Fique tranquilo(a), agora você está no lugar certo. Vou te encaminhar para nossa analista especializada nesse tipo de caso, tá bom?”

⚡ Ação:
Transferir para agente: Isenção de IR por Doença

✅ 2. Se mencionar perícia negada no INSS (benefício negado, auxílio-doença negado, alta programada, considerado apto):

💬 Responder com: “Fique tranquilo(a): quando a perícia nega o benefício, isso não significa que você não tenha direito. Vou te encaminhar para nossa analista especializada, tá bom?”

⚡ Ação:
Transferir para agente: Perícia Negada

🟥 Se não se encaixar em nenhum caso acima:

💬 Responder com: “Obrigado por compartilhar. Vou analisar melhor o seu caso e ver qual especialista pode te ajudar.”

⚡ Ação:
Desativar: agente`,
  },
  {
    name: 'Especialista de tema',
    type: 'theme',
    description: 'Qualifica o caso de um tema específico e passa para a equipe',
    script: `◆ Passo 1 — Apresentação

🚩 Situação: o cliente foi transferido pela triagem.

💬 Mensagem: “Oi! Sou a analista responsável por esse tipo de caso. Vou te fazer algumas perguntas rápidas, combinado?”

◆ Passo 2 — Qualificação

Pergunte, uma de cada vez:
• Desde quando a situação acontece
• Se já fez algum pedido ao INSS ou à Receita e qual foi a resposta
• Se tem laudos e documentos recentes

◆ Passo 3 — Encaminhamento

💬 Mensagem: “Obrigado! Já passei tudo para o advogado responsável. Ele vai te chamar por aqui em breve.”

⚡ Ação:
Desativar: agente`,
  },
];

type Section = 'agents' | 'models';

/** Módulo "LawHub IA": submenu à esquerda (como na Guimoo) + conteúdo. */
export function AgentsModule({ number }: { number?: string }) {
  const [sec, setSec] = useState<Section>('agents');
  const [collapsed, setCollapsed] = useState(false);
  const [editing, setEditing] = useState(false);
  return (
    <div className={`split ${collapsed || editing ? 'collapsed' : ''}`}>
      <aside className="subnav">
        <div className="subnav-hero">
          <span className="ico">
            <Icon name="bot" />
          </span>
          <span>
            <b>LawHub IA</b>
            <small>{number ? `Conectado em +${number}` : 'Agentes de atendimento'}</small>
          </span>
        </div>
        <div className="subnav-grp">Agentes</div>
        <button className={sec === 'agents' ? 'active' : ''} onClick={() => setSec('agents')}>
          <Icon name="bot" size={17} /> Agentes
        </button>
        <button className={sec === 'models' ? 'active' : ''} onClick={() => setSec('models')}>
          <Icon name="doc" size={17} /> Modelos
        </button>
        <div className="subnav-sep" />
        <div className="subnav-grp">Como funciona</div>
        <p className="sub" style={{ padding: '0 10px', lineHeight: 1.5 }}>
          O agente principal atende a conversa nova. Ele transfere para um secundário com{' '}
          <code>⚡ Ação: Transferir para agente</code>.
        </p>
      </aside>
      <div className="split-main">
        {!editing && (
          <button className="collapse-btn" onClick={() => setCollapsed((v) => !v)} aria-label={collapsed ? 'Abrir menu' : 'Recolher menu'}>
            <Icon name={collapsed ? 'right' : 'left'} size={16} />
          </button>
        )}
        {sec === 'agents' ? (
          <Agents number={number} onEditingChange={setEditing} />
        ) : (
          <Models
            onUse={() => {
              setSec('agents');
            }}
          />
        )}
      </div>
    </div>
  );
}

/** Galeria de modelos de roteiro. */
function Models({ onUse }: { onUse: () => void }) {
  const [busy, setBusy] = useState<number | null>(null);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h1">Modelos</h1>
          <p className="sub">Comece um agente a partir de um roteiro pronto no formato Passo / Situação / Mensagem / Ação.</p>
        </div>
      </div>
      <div className="integ-grid">
        {MODELOS.map((m, i) => (
          <div key={m.name} className="card integ-card">
            <div className="row between">
              <span className="botmark">
                <Icon name="bot" />
              </span>
              <span className={`pill ${m.type === 'triage' ? 'primary' : 'ai'}`}>{m.type === 'triage' ? 'Principal' : 'Secundário'}</span>
            </div>
            <b>{m.name}</b>
            <span className="muted small">{m.description}</span>
            <div className="integ-foot row between">
              <span>{m.script.split('◆').length - 1} passos</span>
              <button
                className="soft"
                disabled={busy !== null}
                onClick={async () => {
                  setBusy(i);
                  await api.addAgent({
                    name: m.name,
                    type: m.type,
                    description: m.description,
                    script: m.script,
                    regras: REGRAS_PADRAO,
                    delaySeconds: 15,
                    active: false,
                  });
                  setBusy(null);
                  onUse();
                }}
              >
                <Icon name="plus" size={14} /> Usar modelo
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="hint" style={{ marginTop: 14 }}>
        O agente criado a partir de um modelo começa <b>inativo</b>, para você revisar o roteiro antes de ligar.
      </p>
    </div>
  );
}

const REGRAS_PADRAO =
  '📌 Faça 1 pergunta por mensagem.\n📌 Nunca diga que é uma IA.\n📌 Linguagem simples, no máximo 2 frases por mensagem.';

function Agents({ number, onEditingChange }: { number?: string; onEditingChange: (v: boolean) => void }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [connected, setConnected] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDel, setConfirmDel] = useState<Agent | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [linking, setLinking] = useState<Agent | null>(null);

  const load = () =>
    api.agents().then((r) => {
      setAgents(r.agents);
      setConnected(r.providerConnected);
    });

  useEffect(() => {
    load();
  }, []);

  useEffect(() => onEditingChange(Boolean(editingId)), [editingId, onEditingChange]);

  if (editingId) {
    return (
      <AgentEditor
        id={editingId}
        allAgents={agents}
        onClose={() => {
          setEditingId(null);
          load();
        }}
      />
    );
  }

  const triage = agents.filter((a) => a.active && a.type === 'triage');
  const themes = agents.filter((a) => a.active && a.type === 'theme');
  const inactive = agents.filter((a) => !a.active);

  const toggle = async (a: Agent) => {
    await api.updateAgent(a.id, { active: !a.active });
    load();
  };

  const Table = ({ list, kind }: { list: Agent[]; kind: 'triage' | 'theme' | 'inactive' }) => (
    <div className="card flush">
      <table className="table">
        <thead>
          <tr>
            <th>Agente</th>
            <th>Conexão</th>
            <th>Gatilhos</th>
            <th style={{ textAlign: 'right' }}>Ações</th>
          </tr>
        </thead>
        <tbody>
          {list.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                {kind === 'triage'
                  ? 'Nenhum agente principal ativo. Sem ele, a IA não atende conversas novas.'
                  : 'Nenhum agente aqui.'}
              </td>
            </tr>
          )}
          {list.map((a) => {
            const n = splitTriggers(a.triggers).length;
            return (
              <tr key={a.id} className="clickable" onClick={() => setEditingId(a.id)}>
                <td>
                  <span className="row" style={{ gap: 12 }}>
                    <span className={`botmark ${a.active ? '' : 'off'}`}>
                      <Icon name="bot" size={18} />
                    </span>
                    <span style={{ fontWeight: 500 }}>{a.name}</span>
                  </span>
                </td>
                <td>
                  {a.type === 'triage' && a.active ? (
                    <span className="conn">
                      <Icon name="wifi" size={14} /> {number ? `+${number}` : 'WhatsApp da conexão'}
                    </span>
                  ) : (
                    <em className="muted small">{a.active ? 'Recebe transferência' : 'Desligado'}</em>
                  )}
                </td>
                <td style={{ fontWeight: 500 }}>
                  {n} gatilho{n === 1 ? '' : 's'}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                  <span className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                    {a.active && (
                      <button className="soft" onClick={() => setLinking(a)}>
                        <Icon name="link" size={14} /> {a.type === 'triage' ? 'Conexão' : 'Vincular'}
                      </button>
                    )}
                    <button
                      className={`icon-btn ${a.active ? 'ok' : ''}`}
                      onClick={() => toggle(a)}
                      aria-label={a.active ? 'Desativar agente' : 'Ativar agente'}
                      title={a.active ? 'Desativar' : 'Ativar'}
                    >
                      <Icon name="power" />
                    </button>
                    <button className="icon-btn" onClick={() => setConfirmDel(a)} aria-label="Excluir agente" title="Excluir">
                      <Icon name="x" />
                    </button>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h1">Agentes IA</h1>
          <p className="sub">Crie um agente com roteiro de atendimento e vincule a uma conexão WhatsApp.</p>
        </div>
        <button className="primary" onClick={() => setCreating(true)}>
          <Icon name="plus" /> Novo agente
        </button>
      </div>

      {!connected && (
        <div className="banner">
          <span>
            A IA ainda não está conectada. Defina <code>ANTHROPIC_API_KEY</code> no servidor para os agentes responderem
            de verdade. Você já pode criar e testar os roteiros.
          </span>
        </div>
      )}

      <div className="sec-h">
        Agentes principais <small>({triage.length}) — com conexão vinculada</small>
      </div>
      <Table list={triage} kind="triage" />

      <div className="sec-h">
        Agentes secundários <small>({themes.length}) — recebem transferência</small>
      </div>
      <Table list={themes} kind="theme" />

      <button className="sec-toggle" onClick={() => setShowInactive((v) => !v)}>
        <Icon name={showInactive ? 'chev' : 'right'} size={14} /> Inativos <small className="muted">({inactive.length})</small>
      </button>
      {showInactive && <Table list={inactive} kind="inactive" />}

      {creating && (
        <NewAgentModal
          onClose={() => setCreating(false)}
          onCreated={(a) => {
            setCreating(false);
            load().then(() => setEditingId(a.id));
          }}
        />
      )}

      {linking && (
        <div className="modal-backdrop" onClick={() => setLinking(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            {linking.type === 'triage' ? (
              <>
                <h3>Conexão do agente</h3>
                <p className="muted">
                  <b>{linking.name}</b> é o agente principal: atende as conversas novas do WhatsApp{' '}
                  {number ? <span className="mono">+{number}</span> : '(nenhum número conectado agora)'}.
                </p>
                <div className="modal-actions">
                  <button className="primary" onClick={() => setLinking(null)}>
                    Entendi
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>Vincular “{linking.name}” à conexão?</h3>
                <p className="muted">
                  Ele passa a ser o agente principal e atende as conversas novas. O principal atual vira secundário e
                  continua recebendo transferências.
                </p>
                <div className="modal-actions">
                  <button onClick={() => setLinking(null)}>Cancelar</button>
                  <button
                    className="primary"
                    onClick={async () => {
                      for (const t of agents.filter((x) => x.type === 'triage' && x.id !== linking.id)) {
                        await api.updateAgent(t.id, { type: 'theme' });
                      }
                      await api.updateAgent(linking.id, { type: 'triage', active: true });
                      setLinking(null);
                      load();
                    }}
                  >
                    <Icon name="link" size={15} /> Vincular
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {confirmDel && (
        <div className="modal-backdrop" onClick={() => setConfirmDel(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Excluir “{confirmDel.name}”?</h3>
            <p className="muted">As conversas que ele conduz ficam sem agente. Essa ação não pode ser desfeita.</p>
            <div className="modal-actions">
              <button onClick={() => setConfirmDel(null)}>Cancelar</button>
              <button
                className="danger"
                onClick={async () => {
                  await api.deleteAgent(confirmDel.id);
                  setConfirmDel(null);
                  load();
                }}
              >
                Excluir
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NewAgentModal({ onClose, onCreated }: { onClose: () => void; onCreated: (a: Agent) => void }) {
  const [name, setName] = useState('');
  const [modelo, setModelo] = useState<number>(-1);
  const [type, setType] = useState<Agent['type']>('theme');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          let imported: Partial<Agent> = {};
          if (code.trim()) {
            try {
              imported = JSON.parse(code);
            } catch {
              setErr('O código colado não é válido. Copie de novo em Compartilhar, no agente de origem.');
              return;
            }
          }
          const m = MODELOS[modelo];
          onCreated(
            await api.addAgent({
              description: m?.description ?? '',
              script: m?.script ?? '',
              regras: REGRAS_PADRAO,
              delaySeconds: 15,
              ...imported,
              name: name.trim(),
              type,
              active: true,
            }),
          );
        }}
      >
        <h3>Novo agente</h3>
        <div className="field">
          <label htmlFor="na-name">Nome do agente</label>
          <input id="na-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: BPC Negado" />
        </div>
        <div className="field">
          <label htmlFor="na-type">Tipo</label>
          <select id="na-type" value={type} onChange={(e) => setType(e.target.value as Agent['type'])}>
            <option value="triage">Principal — atende a conversa nova e direciona</option>
            <option value="theme">Secundário — recebe transferência</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="na-model">Começar a partir de</label>
          <select
            id="na-model"
            value={modelo}
            onChange={(e) => {
              const i = Number(e.target.value);
              setModelo(i);
              if (MODELOS[i]) setType(MODELOS[i].type);
            }}
          >
            <option value={-1}>Roteiro em branco</option>
            {MODELOS.map((m, i) => (
              <option key={m.name} value={i}>
                Modelo: {m.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="na-code">Importar de outro agente (opcional)</label>
          <textarea
            id="na-code"
            rows={2}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Cole aqui o código copiado em Compartilhar"
            className="mono"
            style={{ fontSize: 12 }}
          />
        </div>
        {err && <div className="alert">{err}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancelar
          </button>
          <button className="primary">Criar e editar</button>
        </div>
      </form>
    </div>
  );
}

/* ========================================================================== */
/* Editor                                                                     */
/* ========================================================================== */

type EdTab = 'roteiro' | 'regras' | 'faq' | 'integ';
const FONT_SIZES = [13, 14.5, 16, 18];
type RightMode = 'config' | 'test' | 'copilot' | 'history';

function AgentEditor({ id, allAgents, onClose }: { id: string; allAgents: Agent[]; onClose: () => void }) {
  const [saved, setSaved] = useState<Agent | null>(null);
  const [a, setA] = useState<Agent | null>(null);
  const [tab, setTab] = useState<EdTab>('roteiro');
  const [right, setRight] = useState<RightMode>('config');
  const [open, setOpen] = useState<Record<string, boolean>>({ gat: true });
  const [trig, setTrig] = useState('');
  const [toast, setToast] = useState('');
  const [confirmClose, setConfirmClose] = useState(false);
  const [fs, setFs] = useState(() => Number(localStorage.getItem('lawhub.editorFont')) || 14.5);

  useEffect(() => {
    const found = allAgents.find((x) => x.id === id);
    if (found && !saved) {
      setSaved(found);
      setA(structuredClone(found));
    }
  }, [id, allAgents, saved]);

  const dirty = useMemo(() => a && saved && JSON.stringify(a) !== JSON.stringify(saved), [a, saved]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  if (!a) return <div className="page muted">Carregando agente…</div>;

  const set = <K extends keyof Agent>(k: K, v: Agent[K]) => setA({ ...a, [k]: v });
  const triggers = splitTriggers(a.triggers);
  const setTriggers = (list: string[]) => set('triggers', list.join(', '));

  const save = async () => {
    const x = await api.updateAgent(a.id, {
      name: a.name,
      type: a.type,
      description: a.description,
      script: a.script,
      triggers: a.triggers,
      regras: a.regras,
      faq: a.faq.filter((f) => f.q.trim()),
      signatureOn: a.signatureOn,
      signature: a.signature,
      active: a.active,
      delaySeconds: a.delaySeconds,
    });
    setSaved(x);
    setA(structuredClone(x));
    setToast('Agente salvo');
  };

  const addTrigger = () => {
    const v = trig.trim().replace(/[,;]/g, ' ');
    if (!v || triggers.includes(v)) return;
    setTriggers([...triggers, v]);
    setTrig('');
  };

  const acc = (k: string, icon: string, title: string, body: React.ReactNode) => (
    <div className={`card flush acc ${open[k] ? 'open' : ''}`}>
      <button className="acc-h" onClick={() => setOpen({ ...open, [k]: !open[k] })}>
        <Icon name={icon} /> {title}
        <span className="acc-chev">
          <Icon name="chev" size={16} />
        </span>
      </button>
      {open[k] && <div className="acc-b">{body}</div>}
    </div>
  );

  return (
    <div className="editor">
      <div className="ed-left">
        <div className="ed-bar">
          {(
            [
              ['roteiro', 'list', 'Roteiro'],
              ['regras', 'shield', 'Regras'],
              ['faq', 'help', 'FAQ'],
              ['integ', 'plug', 'Integrações'],
            ] as const
          ).map(([k, ic, l]) => (
            <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
              <Icon name={ic} size={16} /> {l}
            </button>
          ))}
          <div className="row" style={{ marginLeft: 'auto' }}>
            {dirty && <span className="muted small">Alterações não salvas</span>}
            <button className="primary sm" onClick={save} disabled={!dirty}>
              Salvar
            </button>
            <button className="sm danger-text" onClick={() => (dirty ? setConfirmClose(true) : onClose())}>
              <Icon name="x" size={14} /> Fechar
            </button>
          </div>
        </div>

        <div className="ed-body">
          {tab === 'roteiro' && (
            <>
              <div className="ed-tools">
                <p className="hint">
                  Dica: use <code>⚡ Ação: Transferir para agente: Nome</code> para passar a conversa a outro agente e{' '}
                  <code>⚡ Ação: Desativar: agente</code> para devolver à equipe.
                  {a.type === 'triage' &&
                    ' Sem essas ações, o sistema escolhe o agente secundário pelos gatilhos e pela descrição de cada um.'}
                </p>
                <div className="fs-ctl" role="group" aria-label="Tamanho da letra">
                  {FONT_SIZES.map((v, i) => (
                    <button
                      key={v}
                      className={fs === v ? 'active' : ''}
                      style={{ fontSize: 11 + i * 2 }}
                      onClick={() => {
                        setFs(v);
                        localStorage.setItem('lawhub.editorFont', String(v));
                      }}
                      aria-label={`Letra ${i + 1}`}
                    >
                      A
                    </button>
                  ))}
                </div>
              </div>
              <textarea
                className="script"
                style={{ fontSize: fs }}
                value={a.script}
                onChange={(e) => set('script', e.target.value)}
                spellCheck
              />
            </>
          )}
          {tab === 'regras' && (
            <>
              <p className="hint">
                Regras gerais de comportamento (tom de voz, o que nunca dizer, critérios de qualificação). Valem para a
                conversa inteira.
              </p>
              <textarea
                className="script short"
                style={{ fontSize: fs }}
                value={a.regras}
                onChange={(e) => set('regras', e.target.value)}
              />
            </>
          )}
          {tab === 'faq' && (
            <>
              <div className="row between" style={{ marginBottom: 12 }}>
                <p className="hint" style={{ margin: 0 }}>
                  Perguntas que o agente pode responder fora do fluxo do roteiro.
                </p>
                <button className="sm" onClick={() => set('faq', [...a.faq, { q: '', a: '' }])}>
                  <Icon name="plus" size={14} /> Adicionar pergunta
                </button>
              </div>
              {a.faq.length === 0 && (
                <div className="card empty">
                  <strong>Nenhuma pergunta cadastrada</strong>
                  <span>Adicione dúvidas comuns, como valor da consulta, endereço ou prazos.</span>
                </div>
              )}
              <div className="stack">
                {a.faq.map((f, i) => (
                  <div key={i} className="card stack-sm">
                    <div className="row">
                      <input
                        value={f.q}
                        placeholder="Pergunta"
                        style={{ fontWeight: 600 }}
                        onChange={(e) => set('faq', a.faq.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)))}
                      />
                      <button
                        className="icon-btn"
                        aria-label="Remover pergunta"
                        onClick={() => set('faq', a.faq.filter((_, j) => j !== i))}
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                    <textarea
                      rows={2}
                      value={f.a}
                      placeholder="Resposta"
                      onChange={(e) => set('faq', a.faq.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)))}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
          {tab === 'integ' && (
            <>
              <div className="eyebrow" style={{ color: 'var(--g-500)' }}>
                Integrações
              </div>
              <p className="hint">
                Conecte ferramentas uma vez e escolha o que <b>este agente</b> usa na conversa: assinatura de contrato,
                cobrança e agenda.
              </p>
              <div className="integ-grid">
                {[
                  ['Assinatura digital', 'ZapSign ou ClickSign: o agente gera o contrato e envia o link na conversa.', '#2563eb', 'Z'],
                  ['Cobranças', 'Pix e boleto gerados durante a conversa (Asaas).', '#0d9488', '$'],
                  ['Agenda', 'O agente consulta horários livres e marca a reunião em Agendas.', '#7c3aed', '◷'],
                ].map(([n, d, c, m]) => (
                  <div key={n} className="card integ-card">
                    <div className="row between">
                      <span className="integ-mark" style={{ background: c }}>
                        {m}
                      </span>
                      <span className="pill">Em breve</span>
                    </div>
                    <b>{n}</b>
                    <span className="muted small">{d}</span>
                    <div className="integ-foot">Ainda não disponível neste agente</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="ed-right">
        {right === 'config' && (
          <>
            <div className="duo">
              <button className="tile" onClick={() => setRight('copilot')}>
                <span className="botmark">
                  <Icon name="bot" />
                </span>
                <span>
                  <b>Copiloto</b>
                  <small>Melhore o roteiro com IA</small>
                </span>
              </button>
              <button className="tile" onClick={() => setRight('test')}>
                <span className="botmark">
                  <Icon name="sparkle" />
                </span>
                <span>
                  <b>Testar</b>
                  <small>Simule uma conversa</small>
                </span>
              </button>
            </div>
            <button className="tile" onClick={() => setRight('history')}>
              <span className="botmark">
                <Icon name="history" />
              </span>
              <span>
                <b>Histórico</b>
                <small>O que mudou e quando</small>
              </span>
            </button>

            <div className="card stack-sm">
              <div className="row">
                <span className="botmark">
                  <Icon name="bot" />
                </span>
                <input value={a.name} onChange={(e) => set('name', e.target.value)} style={{ fontWeight: 600 }} aria-label="Nome do agente" />
                <span className="agent-id">#{a.id.slice(-4).toUpperCase()}</span>
                <span className={`pill ${a.active ? 'ok' : ''}`}>{a.active ? 'Ativo' : 'Inativo'}</span>
              </div>
              <label className="field-sm">
                <span>Tipo</span>
                <select value={a.type} onChange={(e) => set('type', e.target.value as Agent['type'])}>
                  <option value="triage">Principal (atende a conversa nova)</option>
                  <option value="theme">Secundário (recebe transferência)</option>
                </select>
              </label>
              {a.type === 'theme' && (
                <label className="field-sm">
                  <span>Descrição do tema (a triagem usa para decidir)</span>
                  <input
                    value={a.description}
                    onChange={(e) => set('description', e.target.value)}
                    placeholder="Ex.: perícia do INSS negada, auxílio-doença"
                  />
                </label>
              )}
              <div className="soft stack-sm">
                <div className="row between">
                  <b className="small">Delay de resposta</b>
                  <span className="row" style={{ gap: 4 }}>
                    <input
                      className="mono"
                      type="number"
                      min={1}
                      max={300}
                      value={a.delaySeconds}
                      onChange={(e) => set('delaySeconds', Number(e.target.value) || 1)}
                      style={{ width: 70, padding: '4px 8px' }}
                      aria-label="Delay em segundos"
                    />
                    <span className="muted small">seg</span>
                  </span>
                </div>
                <span className="muted small">Tempo que o agente espera o lead terminar de digitar antes de responder.</span>
                <div className="seg">
                  {DELAYS.map((s) => (
                    <button key={s} className={a.delaySeconds === s ? 'active' : ''} onClick={() => set('delaySeconds', s)}>
                      {s}s
                    </button>
                  ))}
                </div>
              </div>
              <label className="row between">
                <span className="small" style={{ fontWeight: 600 }}>
                  Agente ativo
                </span>
                <Switch on={a.active} onChange={(v) => set('active', v)} label="Agente ativo" />
              </label>
            </div>

            {acc(
              'gat',
              'zap',
              `Gatilhos (${triggers.length})`,
              <>
                <form
                  className="row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addTrigger();
                  }}
                >
                  <input value={trig} onChange={(e) => setTrig(e.target.value)} placeholder="Digite um gatilho e tecle Enter" />
                  <button className="sm">
                    <Icon name="plus" size={14} /> Adicionar
                  </button>
                </form>
                <div className="trig-chips">
                  {triggers.map((t, i) => (
                    <span key={i} className="chip" title={t}>
                      <span>{t}</span>
                      <button aria-label="Remover gatilho" onClick={() => setTriggers(triggers.filter((_, j) => j !== i))}>
                        <Icon name="x" size={12} />
                      </button>
                    </span>
                  ))}
                </div>
                <span className="muted small">
                  {a.type === 'triage'
                    ? 'Com gatilhos, a triagem só assume conversas novas cuja mensagem contém um deles (ou um gatilho de agente de tema). Sem gatilhos, ela atende todas as conversas novas.'
                    : 'Quando a mensagem do cliente contém um destes textos, a triagem transfere para este agente.'}
                </span>
              </>,
            )}
            {acc(
              'sig',
              'pen',
              'Assinatura',
              <>
                <label className="row between">
                  <span className="small" style={{ fontWeight: 600 }}>
                    Assinar as mensagens do agente
                  </span>
                  <Switch on={a.signatureOn} onChange={(v) => set('signatureOn', v)} label="Assinar mensagens" />
                </label>
                <input value={a.signature} onChange={(e) => set('signature', e.target.value)} placeholder="— Equipe do escritório" />
              </>,
            )}
            {acc(
              'aud',
              'mic',
              'Áudio',
              <span className="muted small">
                Responder com áudio (voz) ainda não está disponível. Por enquanto o agente responde em texto.
              </span>,
            )}
            {acc(
              'shr',
              'share',
              'Compartilhar',
              <>
                <span className="muted small">
                  Copie a configuração e cole em “Importar de outro agente” ao criar um agente, em qualquer cliente.
                </span>
                <button
                  className="sm"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={async () => {
                    const code = JSON.stringify({
                      description: a.description,
                      script: a.script,
                      triggers: a.triggers,
                      regras: a.regras,
                      faq: a.faq,
                      delaySeconds: a.delaySeconds,
                      signatureOn: a.signatureOn,
                      signature: a.signature,
                    });
                    try {
                      await navigator.clipboard.writeText(code);
                      setToast('Configuração copiada');
                    } catch {
                      setToast('Não foi possível copiar automaticamente');
                    }
                  }}
                >
                  <Icon name="copy" size={14} /> Copiar configuração
                </button>
              </>,
            )}
          </>
        )}

        {right === 'test' && <TestPanel draft={a} allAgents={allAgents} onBack={() => setRight('config')} />}
        {right === 'copilot' && (
          <CopilotPanel
            script={a.script}
            onApply={(r) => {
              set('script', r);
              setTab('roteiro');
              setRight('config');
              setToast('Roteiro atualizado. Salve para manter.');
            }}
            onBack={() => setRight('config')}
          />
        )}
        {right === 'history' && <HistoryPanel id={a.id} onBack={() => setRight('config')} />}
      </div>

      {confirmClose && (
        <div className="modal-backdrop" onClick={() => setConfirmClose(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Sair sem salvar?</h3>
            <p className="muted">As alterações feitas neste agente serão descartadas.</p>
            <div className="modal-actions">
              <button onClick={() => setConfirmClose(false)}>Continuar editando</button>
              <button className="danger" onClick={onClose}>
                Descartar
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch ${on ? 'on' : ''}`}
      onClick={(e) => {
        e.preventDefault();
        onChange(!on);
      }}
    />
  );
}

/* ------------------------------- Testar ------------------------------- */

type TestMsg = { from: 'lead' | 'agent' | 'sys'; text: string; agentName?: string };

function TestPanel({ draft, allAgents, onBack }: { draft: Agent; allAgents: Agent[]; onBack: () => void }) {
  const [msgs, setMsgs] = useState<TestMsg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [currentId, setCurrentId] = useState(draft.id); // muda quando há transferência
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => endRef.current?.scrollIntoView({ block: 'end' }), [msgs, busy]);

  const current = currentId === draft.id ? draft : allAgents.find((x) => x.id === currentId) ?? draft;
  const gateTriggers =
    draft.type === 'triage' && splitTriggers(draft.triggers).length > 0
      ? [
          ...splitTriggers(draft.triggers),
          ...allAgents.filter((x) => x.active && x.type === 'theme').flatMap((x) => splitTriggers(x.triggers)),
        ]
      : [];

  const ask = async (agent: Agent, history: TestMsg[], hop = 0): Promise<void> => {
    const transcript = history
      .filter((m) => m.from !== 'sys')
      .map((m) => ({ from: m.from as 'lead' | 'agent', text: m.text }));
    setBusy(true);
    try {
      const { text: reply, action } = await api.testAgent(agent.id, agent.id === draft.id ? draft : {}, transcript);
      let next: TestMsg[] = reply ? [...history, { from: 'agent', text: reply, agentName: agent.name }] : history;
      if (action?.type === 'deactivate') {
        setMsgs([...next, { from: 'sys', text: 'Agente desativado pelo roteiro. A equipe assume a conversa.' }]);
      } else if (action?.type === 'transfer') {
        const target = allAgents.find((x) => x.active && norm(x.name) === norm(action.agentName));
        next = [
          ...next,
          {
            from: 'sys',
            text: target
              ? `Transferido para ${target.name}`
              : `O roteiro pediu transferência para “${action.agentName}”, mas esse agente não existe ou está inativo.`,
          },
        ];
        setMsgs(next);
        if (target && target.id !== agent.id && hop < 2) {
          setCurrentId(target.id);
          await ask(target, next, hop + 1);
        }
      } else {
        setMsgs(next);
      }
    } catch (e) {
      setMsgs([...history, { from: 'sys', text: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  };

  const send = async (value: string) => {
    const v = value.trim();
    if (!v || busy) return;
    setText('');
    const history: TestMsg[] = [...msgs, { from: 'lead', text: v }];
    setMsgs(history);
    const started = history.some((m) => m.from === 'agent');
    if (!started && gateTriggers.length > 0 && !gateTriggers.some((t) => norm(v).includes(norm(t)))) {
      setMsgs([...history, { from: 'sys', text: 'Nenhum gatilho na mensagem: no WhatsApp esta triagem não assumiria a conversa.' }]);
      return;
    }
    await ask(current, history);
  };

  const suggestions = splitTriggers(current.triggers);

  return (
    <>
      <div className="row between">
        <b className="row" style={{ gap: 6 }}>
          <Icon name="sparkle" /> Testar agente
        </b>
        <div className="row">
          <button
            className="sm"
            onClick={() => {
              setMsgs([]);
              setCurrentId(draft.id);
            }}
          >
            Reiniciar
          </button>
          <button className="icon-btn" onClick={onBack} aria-label="Voltar às configurações">
            <Icon name="x" />
          </button>
        </div>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Você é o lead. A simulação usa o roteiro, as regras e o FAQ atuais (mesmo sem salvar) e segue as ações de
        transferência. Nada é enviado pelo WhatsApp.
      </p>
      <div className="chatbox">
        <div className="msgs">
          {msgs.length === 0 && <div className="bubble sys">Envie a primeira mensagem como se fosse o lead.</div>}
          {msgs.map((m, i) =>
            m.from === 'sys' ? (
              <div key={i} className="bubble sys">
                {m.text}
              </div>
            ) : (
              <div key={i} className={`bubble ${m.from === 'lead' ? 'out' : 'in ai'}`}>
                {m.from === 'agent' && <div className="ai-name">{m.agentName}</div>}
                {m.text}
              </div>
            ),
          )}
          {busy && <div className="bubble in ai typing">digitando…</div>}
          <div ref={endRef} />
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send(text);
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Mensagem do lead" disabled={busy} />
          <button className="primary" disabled={busy} aria-label="Enviar">
            <Icon name="send" />
          </button>
        </form>
      </div>
      {suggestions.length > 0 && !msgs.some((m) => m.from === 'agent') && (
        <div className="trig-chips">
          {suggestions.map((t) => (
            <button key={t} className="chip" onClick={() => send(t)} title={t}>
              <span>{t}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/* ------------------------------ Copiloto ------------------------------ */

function CopilotPanel({ script, onApply, onBack }: { script: string; onApply: (r: string) => void; onBack: () => void }) {
  const [ask, setAsk] = useState('');
  const [out, setOut] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <>
      <div className="row between">
        <b className="row" style={{ gap: 6 }}>
          <Icon name="bot" /> Copiloto
        </b>
        <button className="icon-btn" onClick={onBack} aria-label="Voltar às configurações">
          <Icon name="x" />
        </button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Peça uma mudança no roteiro. O copiloto devolve uma nova versão para você revisar antes de aplicar.
      </p>
      <form
        className="stack-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ask.trim()) return;
          setBusy(true);
          setErr('');
          try {
            setOut((await api.copilot(script, ask)).script);
          } catch (x) {
            setErr((x as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <textarea
          rows={3}
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          placeholder="Ex.: adicione um passo para pedir o CPF antes de transferir"
        />
        <button className="primary" disabled={busy}>
          <Icon name="sparkle" /> {busy ? 'Gerando…' : 'Gerar sugestão'}
        </button>
      </form>
      {err && <div className="alert">{err}</div>}
      {out && (
        <>
          <pre className="card copilot-out">{out}</pre>
          <button className="primary" onClick={() => onApply(out)}>
            Aplicar ao roteiro
          </button>
        </>
      )}
    </>
  );
}

/* ------------------------------ Histórico ----------------------------- */

function HistoryPanel({ id, onBack }: { id: string; onBack: () => void }) {
  const [items, setItems] = useState<AgentHistoryItem[] | null>(null);
  useEffect(() => {
    api.agentHistory(id).then(setItems);
  }, [id]);
  return (
    <>
      <div className="row between">
        <b className="row" style={{ gap: 6 }}>
          <Icon name="history" /> Histórico
        </b>
        <button className="icon-btn" onClick={onBack} aria-label="Voltar às configurações">
          <Icon name="x" />
        </button>
      </div>
      <div className="card flush">
        {items === null && <div className="pad muted">Carregando…</div>}
        {items?.length === 0 && <div className="pad muted">Nenhuma alteração registrada.</div>}
        {items?.map((h) => (
          <div key={h.id} className="hist-row">
            <b>{h.action}</b>
            <span className="muted small mono">{fmtDateTime(h.createdAt)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
