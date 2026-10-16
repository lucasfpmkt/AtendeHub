import { useEffect, useRef, useState } from 'react';
import { api, type Conversation, type Message } from '../api';
import { socket } from '../socket';

export function Inbox({ connected }: { connected: boolean }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const active = conversations.find((c) => c.id === activeId) ?? null;

  const loadConversations = () =>
    api.conversations().then((list) => {
      setConversations(list);
      setActiveId((id) => id ?? list[0]?.id ?? null);
    });

  useEffect(() => {
    loadConversations();
    const onNew = (e: { conversationId: string; message: Message }) => {
      loadConversations();
      setActiveId((cur) => {
        if (cur === e.conversationId) {
          setMessages((m) => [...m, e.message]);
        }
        return cur;
      });
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
    if (activeId) api.messages(activeId).then(setMessages);
  }, [activeId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    if (!activeId || !text.trim()) return;
    const body = text;
    setText('');
    const msg = await api.send(activeId, body).catch((e) => {
      alert(e.message);
      return null;
    });
    if (msg) setMessages((m) => [...m, msg]);
  };

  const draft = async () => {
    if (!activeId) return;
    setAiBusy(true);
    try {
      const { text: suggestion } = await api.draft(activeId);
      setText(suggestion);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setAiBusy(false);
    }
  };

  const toggleAi = async () => {
    if (!active) return;
    const updated = await api.toggleAi(active.id, !active.aiEnabled);
    setConversations((cs) =>
      cs.map((c) => (c.id === updated.id ? { ...c, aiEnabled: updated.aiEnabled } : c)),
    );
  };

  return (
    <div className="inbox">
      <div className="conv-list">
        {conversations.length === 0 && (
          <div className="conv-item muted">Nenhuma conversa ainda.</div>
        )}
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`conv-item ${c.id === activeId ? 'active' : ''}`}
            onClick={() => setActiveId(c.id)}
          >
            <div className="name">{c.contact.name || c.contact.phone}</div>
            <div className="preview">{c.messages?.[0]?.body ?? '—'}</div>
          </div>
        ))}
      </div>

      <div className="chat">
        {active ? (
          <>
            <div className="chat-header">
              <div>
                <strong>{active.contact.name || active.contact.phone}</strong>
                <div className="muted" style={{ fontSize: 12 }}>
                  {active.contact.phone}
                </div>
              </div>
              <label className="toggle">
                <input type="checkbox" checked={active.aiEnabled} onChange={toggleAi} />
                Auto-resposta IA
              </label>
            </div>

            <div className="msgs">
              {messages.map((m) => (
                <div key={m.id} className={`bubble ${m.direction}`}>
                  {m.body}
                  <div className="by">
                    {m.author === 'ai' ? '🤖 IA' : m.author === 'agent' ? 'Você' : 'Cliente'}
                  </div>
                </div>
              ))}
              <div ref={endRef} />
            </div>

            <div className="composer">
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()}
                placeholder={connected ? 'Escreva uma mensagem…' : 'Conecte o WhatsApp para enviar'}
                disabled={!connected}
              />
              <button onClick={draft} disabled={aiBusy} title="Sugerir resposta com IA">
                {aiBusy ? '…' : '🤖'}
              </button>
              <button className="primary" onClick={send} disabled={!connected}>
                Enviar
              </button>
            </div>
          </>
        ) : (
          <div className="page muted">Selecione uma conversa.</div>
        )}
      </div>
    </div>
  );
}
