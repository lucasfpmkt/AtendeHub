import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Agent, type Conversation, type Message, type QuickReply } from '../api';
import { socket } from '../socket';
import { Icon } from '../icons';

type Filter = 'open' | 'ai' | 'unread' | 'closed';

const FILTERS: { id: Filter; label: string; test: (c: Conversation) => boolean }[] = [
  { id: 'open', label: 'Geral', test: (c) => c.status !== 'closed' },
  { id: 'ai', label: 'IA', test: (c) => c.status !== 'closed' && c.aiEnabled },
  { id: 'unread', label: 'Não lidas', test: (c) => (c.unread ?? 0) > 0 },
  { id: 'closed', label: 'Fechadas', test: (c) => c.status === 'closed' },
];

const hm = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
};

const initials = (s: string) =>
  s
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

export function Inbox({ connected }: { connected: boolean }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [quick, setQuick] = useState<QuickReply[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<Filter>('open');
  const [q, setQ] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const agentName = (id?: string | null) => agents.find((a) => a.id === id)?.name;

  const loadConversations = () => api.conversations().then(setConversations);

  useEffect(() => {
    loadConversations();
    api.agents().then((r) => setAgents(r.agents));
    api.quickReplies().then(setQuick);
    const onNew = (e: { conversationId: string; message: Message }) => {
      loadConversations();
      if (activeRef.current === e.conversationId) {
        setMessages((m) => (m.some((x) => x.id === e.message.id) ? m : [...m, e.message]));
        if (e.message.direction === 'in') api.markRead(e.conversationId);
      }
    };
    socket.on('message:new', onNew);
    socket.on('conversation:update', loadConversations);
    return () => {
      socket.off('message:new', onNew);
      socket.off('conversation:update', loadConversations);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activeId) return;
    setError('');
    api.messages(activeId).then(setMessages);
    api.markRead(activeId).then(loadConversations);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages]);

  const visible = useMemo(() => {
    const f = FILTERS.find((x) => x.id === filter)!;
    const term = q.trim().toLowerCase();
    return conversations
      .filter(f.test)
      .filter((c) => !term || (c.contact.name ?? '').toLowerCase().includes(term) || c.contact.phone.includes(term));
  }, [conversations, filter, q]);

  const send = async () => {
    if (!activeId || !text.trim()) return;
    let body = text.trim();
    const qr = quick.find((x) => x.shortcut === body);
    if (qr) body = qr.text;
    setText('');
    setError('');
    try {
      // O servidor pausa a IA desta conversa quando a equipe responde.
      const msg = await api.send(activeId, body);
      setMessages((m) => (m.some((x) => x.id === msg.id) ? m : [...m, msg]));
      loadConversations();
    } catch (e) {
      setText(body);
      setError((e as Error).message);
    }
  };

  const draft = async () => {
    if (!activeId) return;
    setAiBusy(true);
    try {
      const { text: suggestion } = await api.draft(activeId);
      setText(suggestion);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAiBusy(false);
    }
  };

  const patch = async (data: { status?: string; assignedAgentId?: string | null; aiEnabled?: boolean }) => {
    if (!active) return;
    await api.setConversation(active.id, data);
    loadConversations();
  };

  const quickMatches = text.startsWith('/') ? quick.filter((x) => x.shortcut.startsWith(text.trim())) : [];

  return (
    <div className={`inbox ${active ? 'has-active' : ''}`}>
      <div className="conv-list">
        <div className="conv-search">
          <Icon name="search" size={16} />
          <input placeholder="Pesquisar nome ou telefone" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="conv-tabs">
          {FILTERS.map((f) => (
            <button key={f.id} className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>
              {f.label}
              <small>{conversations.filter(f.test).length}</small>
            </button>
          ))}
        </div>
        <div className="conv-scroll">
          {visible.length === 0 && (
            <div className="empty">
              <strong>Nenhuma conversa</strong>
              <span>Não há conversas nesta categoria.</span>
            </div>
          )}
          {visible.map((c) => {
            const name = c.contact.name || c.contact.phone;
            const last = c.messages?.[0];
            return (
              <button key={c.id} className={`conv-item ${c.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(c.id)}>
                <span className="avatar">{initials(name)}</span>
                <span className="conv-body">
                  <span className="conv-top">
                    <span className="name">{name}</span>
                    {c.aiEnabled && <span className="pill ai">IA</span>}
                    <span className="time">{hm(c.lastMessageAt)}</span>
                  </span>
                  <span className="conv-top">
                    <span className="preview">
                      {last && last.direction === 'out' ? (last.author === 'ai' ? 'IA: ' : 'Você: ') : ''}
                      {last?.body ?? '—'}
                    </span>
                    {(c.unread ?? 0) > 0 && <span className="badge">{c.unread}</span>}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="chat">
        {active ? (
          <>
            <div className="chat-header">
              <button className="icon-btn back" onClick={() => setActiveId(null)} aria-label="Voltar à lista">
                <Icon name="left" />
              </button>
              <span className="avatar">{initials(active.contact.name || active.contact.phone)}</span>
              <div style={{ minWidth: 0 }}>
                <strong>{active.contact.name || active.contact.phone}</strong>
                <div className="muted mono small">{active.contact.phone}</div>
              </div>
              <div className="row chat-actions">
                <select
                  value={active.assignedAgentId ?? ''}
                  onChange={(e) => patch({ assignedAgentId: e.target.value || null })}
                  aria-label="Agente da conversa"
                  className="agent-select"
                >
                  <option value="">Sem agente</option>
                  {agents
                    .filter((a) => a.active)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                </select>
                <button
                  className={`sm ${active.aiEnabled ? 'ai-on' : ''}`}
                  onClick={() => patch({ aiEnabled: !active.aiEnabled })}
                  title="Liga/desliga a resposta automática nesta conversa"
                >
                  <Icon name="bot" size={14} /> {active.aiEnabled ? 'IA atendendo' : 'Devolver para IA'}
                </button>
                <button className="sm" onClick={() => patch({ status: active.status === 'closed' ? 'open' : 'closed' })}>
                  {active.status === 'closed' ? 'Reabrir' : 'Finalizar'}
                </button>
              </div>
            </div>

            <div className="msgs">
              {messages.map((m) =>
                m.author === 'system' ? (
                  <div key={m.id} className="bubble sys">
                    {m.body}
                  </div>
                ) : (
                  <div key={m.id} className={`bubble ${m.direction} ${m.author === 'ai' ? 'ai' : ''}`}>
                    {m.author === 'ai' && <div className="ai-name">{agentName(active.assignedAgentId) ?? 'IA'}</div>}
                    {m.body}
                    <div className="by">
                      {m.author === 'agent' ? 'Você · ' : ''}
                      {hm(m.createdAt)}
                    </div>
                  </div>
                ),
              )}
              <div ref={endRef} />
            </div>

            {error && (
              <div className="alert" style={{ margin: '0 14px' }}>
                {error}
              </div>
            )}
            {quickMatches.length > 0 && (
              <div className="quick-pop">
                {quickMatches.map((x) => (
                  <button key={x.id} onClick={() => setText(x.text)}>
                    <b className="mono">{x.shortcut}</b> <span>{x.text}</span>
                  </button>
                ))}
              </div>
            )}
            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                send();
              }}
            >
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={connected ? 'Escreva uma mensagem ou / para mensagens rápidas' : 'Conecte o WhatsApp para enviar'}
                disabled={!connected}
              />
              <button type="button" onClick={draft} disabled={aiBusy} title="Sugerir resposta com IA" aria-label="Sugerir resposta com IA">
                {aiBusy ? '…' : <Icon name="sparkle" />}
              </button>
              <button className="primary" disabled={!connected} aria-label="Enviar">
                <Icon name="send" />
              </button>
            </form>
          </>
        ) : (
          <div className="empty center">
            <span className="empty-ico">
              <Icon name="chat" size={26} />
            </span>
            <strong>Selecione uma conversa</strong>
            <span>Escolha uma conversa da lista para ver e enviar mensagens.</span>
          </div>
        )}
      </div>
    </div>
  );
}
