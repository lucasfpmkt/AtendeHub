import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Agent, type Conversation, type Message, type QuickReply, type Tag } from '../api';
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
// Carimbo completo da bolha: hoje mostra a hora; dias anteriores mostram data e hora.
const stamp = (iso: string) => {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })} ${time}`;
};

const initials = (s: string) =>
  s
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

export function Inbox({
  connected,
  focusContactId,
  onFocusConsumed,
}: {
  connected: boolean;
  focusContactId?: string | null;
  onFocusConsumed?: () => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [stages, setStages] = useState<{ id: string; name: string; color: string }[]>([]);
  const [tagCat, setTagCat] = useState<Tag[]>([]);
  const [quick, setQuick] = useState<QuickReply[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<Filter>('open');
  const [q, setQ] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [sendingFile, setSendingFile] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // Gravação de áudio (vira mensagem de voz no WhatsApp).
  const recRef = useRef<{ rec: MediaRecorder; chunks: Blob[]; stream: MediaStream; cancel: boolean } | null>(null);
  const [recSecs, setRecSecs] = useState<number | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const agentName = (id?: string | null) => agents.find((a) => a.id === id)?.name;
  const stageOf = (id?: string | null) => stages.find((s) => s.id === id);
  // Nomes de etapa (em minúsculo) — para não repetir a etapa como etiqueta.
  const stageNameSet = useMemo(() => new Set(stages.map((s) => s.name.trim().toLowerCase())), [stages]);
  const tagColor = useMemo(() => {
    const m = new Map<string, string>();
    tagCat.forEach((t) => m.set(t.name.toLowerCase(), t.color));
    return m;
  }, [tagCat]);
  const splitTags = (s?: string | null) =>
    (s ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

  const loadConversations = () => api.conversations().then(setConversations);

  // Veio do CRM pedindo para abrir a conversa de um contato.
  useEffect(() => {
    if (!focusContactId) return;
    const conv = conversations.find((c) => c.contact?.id === focusContactId);
    if (conv) {
      setFilter(conv.status === 'closed' ? 'closed' : 'open');
      setActiveId(conv.id);
      onFocusConsumed?.();
    }
  }, [focusContactId, conversations]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    loadConversations();
    api.agents().then((r) => setAgents(r.agents));
    api.stages().then(setStages).catch(() => {});
    api.tags().then(setTagCat).catch(() => {});
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
    if (taRef.current) taRef.current.style.height = '';
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

  const [schedOpen, setSchedOpen] = useState(false);
  const [schedList, setSchedList] = useState<{ id: string; body: string; sendAt: string }[]>([]);
  const [schedAt, setSchedAt] = useState('');
  const [schedBody, setSchedBody] = useState('');

  const openSched = async () => {
    if (!activeId) return;
    setSchedBody(text.trim());
    setSchedAt('');
    setSchedOpen(true);
    api.schedules(activeId).then(setSchedList).catch(() => {});
  };
  const saveSched = async () => {
    if (!activeId || !schedBody.trim() || !schedAt) return;
    try {
      await api.schedule(activeId, schedBody.trim(), new Date(schedAt).toISOString());
      setSchedBody('');
      setSchedAt('');
      api.schedules(activeId).then(setSchedList).catch(() => {});
    } catch (x) {
      setError((x as Error).message);
    }
  };
  const cancelSched = async (id: string) => {
    await api.cancelSchedule(id).catch(() => {});
    if (activeId) api.schedules(activeId).then(setSchedList).catch(() => {});
  };

  /** Envia um arquivo (anexo, colado, arrastado ou áudio gravado). O texto digitado vira legenda. */
  const sendFile = async (file: File, withCaption = true) => {
    if (!activeId) return;
    if (file.size > 30 * 1024 * 1024) {
      setError('Arquivo muito grande (máx. 30 MB).');
      return;
    }
    setError('');
    setSendingFile(true);
    try {
      const caption = withCaption ? text.trim() : '';
      const msg = await api.sendMedia(activeId, file, caption);
      if (caption) setText('');
      setMessages((m) => (m.some((x) => x.id === msg.id) ? m : [...m, msg]));
      loadConversations();
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setSendingFile(false);
    }
  };

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) await sendFile(file);
  };

  // Cola um print/imagem direto na caixa de texto.
  const onPaste = (e: React.ClipboardEvent) => {
    const file = Array.from(e.clipboardData.files)[0];
    if (file) {
      e.preventDefault();
      void sendFile(file);
    }
  };

  // Enter envia; Shift+Enter quebra a linha. A caixa cresce com o texto.
  const onComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };

  /* ---------------------------- gravação de áudio ---------------------------- */
  useEffect(() => {
    if (recSecs === null) return;
    const t = setInterval(() => setRecSecs((v) => (v === null ? v : v + 1)), 1000);
    return () => clearInterval(t);
  }, [recSecs === null]); // eslint-disable-line react-hooks/exhaustive-deps

  const startRec = async () => {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Este navegador não permite gravar áudio.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const state = { rec, chunks: [] as Blob[], stream, cancel: false };
      rec.ondataavailable = (ev) => ev.data.size && state.chunks.push(ev.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        recRef.current = null;
        setRecSecs(null);
        if (state.cancel || !state.chunks.length) return;
        const type = rec.mimeType || mime || 'audio/webm';
        const ext = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm';
        void sendFile(new File(state.chunks, `audio.${ext}`, { type: type.split(';')[0] }), false);
      };
      recRef.current = state;
      rec.start();
      setRecSecs(0);
    } catch {
      setError('Não foi possível usar o microfone. Libere o acesso ao microfone no navegador.');
    }
  };
  // Saiu da tela gravando: descarta e libera o microfone.
  useEffect(
    () => () => {
      const r = recRef.current;
      if (r) {
        r.cancel = true;
        r.rec.stop();
        r.stream.getTracks().forEach((t) => t.stop());
      }
    },
    [],
  );

  const stopRec = (cancel: boolean) => {
    const r = recRef.current;
    if (!r) return;
    r.cancel = cancel;
    r.rec.stop();
  };
  const fmtSecs = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;

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
                  {(() => {
                    const st = stageOf(c.contact.stageId);
                    // A etapa já aparece na pílula; não repete como etiqueta.
                    const cTags = splitTags(c.contact.tags).filter((t) => !stageNameSet.has(t.toLowerCase()));
                    const ag = agentName(c.assignedAgentId);
                    if (!st && cTags.length === 0 && !ag) return null;
                    return (
                      <span className="conv-meta">
                        {st && (
                          <span className="tag" style={{ background: `${st.color}22`, color: st.color }}>
                            <span className="swatch" style={{ background: st.color }} />
                            {st.name}
                          </span>
                        )}
                        {cTags.map((t) => (
                          <span className="tag" key={t}>
                            <span className="swatch" style={{ background: tagColor.get(t.toLowerCase()) ?? '#16a34a' }} />
                            {t}
                          </span>
                        ))}
                        {ag && (
                          <span className="tag">
                            <Icon name="bot" size={11} /> {ag}
                          </span>
                        )}
                      </span>
                    );
                  })()}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div
        className={`chat ${dragOver ? 'drag-over' : ''}`}
        onDragOver={(e) => {
          if (!activeId || !connected || !e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
        }}
        onDrop={(e) => {
          if (!dragOver) return;
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) void sendFile(file);
        }}
      >
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
                    {m.mediaId && <MediaBubble m={m} />}
                    {m.body && !isMediaLabel(m.body) && <div className="mtext">{m.body}</div>}
                    <div className="by">
                      {m.author === 'agent' ? 'Você · ' : ''}
                      {stamp(m.createdAt)}
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
                ref={fileRef}
                type="file"
                style={{ display: 'none' }}
                onChange={onPickFile}
                accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip"
              />
              {recSecs !== null ? (
                <>
                  <button type="button" onClick={() => stopRec(true)} title="Descartar gravação" aria-label="Descartar gravação">
                    <Icon name="trash" />
                  </button>
                  <div className="rec-live" role="status">
                    <span className="rec-dot" /> Gravando áudio · {fmtSecs(recSecs)}
                  </div>
                  <button type="button" className="primary" onClick={() => stopRec(false)} title="Parar e enviar o áudio" aria-label="Enviar áudio">
                    <Icon name="send" />
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={!connected || sendingFile}
                    title="Anexar foto, vídeo, áudio ou documento (também dá para colar ou arrastar o arquivo aqui)"
                    aria-label="Anexar arquivo"
                  >
                    {sendingFile ? '…' : <Icon name="clip" />}
                  </button>
                  <textarea
                    ref={taRef}
                    rows={1}
                    className="composer-input"
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      autoGrow(e.target);
                    }}
                    onKeyDown={onComposerKey}
                    onPaste={onPaste}
                    placeholder={
                      connected ? 'Mensagem (Enter envia · Shift+Enter quebra linha · / para respostas rápidas)' : 'Conecte o WhatsApp para enviar'
                    }
                    disabled={!connected}
                  />
                  <button type="button" onClick={startRec} disabled={!connected || sendingFile} title="Gravar áudio" aria-label="Gravar áudio">
                    <Icon name="mic" />
                  </button>
                  <button type="button" onClick={openSched} disabled={!connected} title="Agendar mensagem / lembrete" aria-label="Agendar mensagem">
                    <Icon name="clock" />
                  </button>
                  <button type="button" onClick={draft} disabled={aiBusy} title="Sugerir resposta com IA" aria-label="Sugerir resposta com IA">
                    {aiBusy ? '…' : <Icon name="sparkle" />}
                  </button>
                  <button className="primary" disabled={!connected} aria-label="Enviar">
                    <Icon name="send" />
                  </button>
                </>
              )}
            </form>

            {schedOpen && (
              <div className="modal-backdrop" onClick={() => setSchedOpen(false)}>
                <div className="modal" onClick={(e) => e.stopPropagation()}>
                  <h3>Agendar mensagem</h3>
                  <div className="field">
                    <label>Quando enviar</label>
                    <input type="datetime-local" value={schedAt} onChange={(e) => setSchedAt(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Mensagem</label>
                    <textarea rows={3} value={schedBody} onChange={(e) => setSchedBody(e.target.value)} placeholder="Ex.: Olá! Passando para lembrar da sua consulta amanhã às 15h." />
                  </div>
                  {schedList.length > 0 && (
                    <div className="field">
                      <label>Agendadas</label>
                      <div className="stack-sm">
                        {schedList.map((s) => (
                          <div key={s.id} className="row between small" style={{ gap: 8 }}>
                            <span>
                              <b>{new Date(s.sendAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</b> — {s.body.slice(0, 40)}
                              {s.body.length > 40 ? '…' : ''}
                            </span>
                            <button className="link" onClick={() => cancelSched(s.id)}>
                              cancelar
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="modal-actions">
                    <button className="ghost" onClick={() => setSchedOpen(false)}>
                      Fechar
                    </button>
                    <button className="primary" onClick={saveSched} disabled={!schedBody.trim() || !schedAt}>
                      Agendar
                    </button>
                  </div>
                </div>
              </div>
            )}
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

// Rótulos usados quando a mídia não tem legenda (para não exibi-los como texto).
const MEDIA_LABELS = ['📷 Imagem', '🎬 Vídeo', '🎤 Áudio', '📎 Documento', 'Figurinha', 'Arquivo'];
function isMediaLabel(body: string) {
  return MEDIA_LABELS.includes(body.trim());
}

function MediaBubble({ m }: { m: Message }) {
  const [failed, setFailed] = useState(false);
  if (!m.mediaId) return null;
  const url = api.mediaUrl(m.mediaId);

  if (failed) {
    return (
      <a className="media-doc media-missing" href={url} target="_blank" rel="noreferrer" title="Abrir / baixar">
        <Icon name="doc" size={16} /> {m.mediaName || 'Mídia indisponível'}
      </a>
    );
  }
  if (m.mediaType === 'image' || m.mediaType === 'sticker') {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="media-link">
        <img className="media-img" src={url} alt={m.body || 'imagem'} loading="lazy" onError={() => setFailed(true)} />
      </a>
    );
  }
  if (m.mediaType === 'video') return <video className="media-img" src={url} controls onError={() => setFailed(true)} />;
  if (m.mediaType === 'audio') return <audio className="media-audio" src={url} controls onError={() => setFailed(true)} />;
  return (
    <a className="media-doc" href={url} target="_blank" rel="noreferrer">
      <Icon name="doc" size={16} /> {m.mediaName || 'Documento'}
    </a>
  );
}
