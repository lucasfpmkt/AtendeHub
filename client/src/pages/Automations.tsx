import { useEffect, useState } from 'react';
import { api, type KeywordRule, type QuickReply } from '../api';
import { Icon } from '../icons';
import { Switch } from './Agents';

type Sec = 'quick' | 'keywords';

export function Automations() {
  const [sec, setSec] = useState<Sec>('quick');
  return (
    <div className="split">
      <aside className="subnav">
        <h2>Automações</h2>
        <p className="sub">Mensagens que saem sozinhas ou com um atalho.</p>
        <div className="subnav-grp">Mensagens</div>
        <button className={sec === 'quick' ? 'active' : ''} onClick={() => setSec('quick')}>
          <Icon name="chat" size={16} /> Mensagens rápidas
        </button>
        <div className="subnav-grp">Gatilhos</div>
        <button className={sec === 'keywords' ? 'active' : ''} onClick={() => setSec('keywords')}>
          <Icon name="zap" size={16} /> Automação por palavras
        </button>
      </aside>
      <div className="split-main">{sec === 'quick' ? <QuickReplies /> : <Keywords />}</div>
    </div>
  );
}

function QuickReplies() {
  const [items, setItems] = useState<QuickReply[]>([]);
  const [shortcut, setShortcut] = useState('/');
  const [text, setText] = useState('');
  const load = () => api.quickReplies().then(setItems);
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h1">Mensagens rápidas</h1>
          <p className="sub">No chat, digite o atalho (ex.: /docs) para inserir o texto pronto.</p>
        </div>
      </div>
      <form
        className="card stack-sm"
        style={{ marginBottom: 14 }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (shortcut.trim().length < 2 || !text.trim()) return;
          await api.addQuickReply(shortcut, text);
          setShortcut('/');
          setText('');
          load();
        }}
      >
        <div className="row">
          <input className="mono" value={shortcut} onChange={(e) => setShortcut(e.target.value)} style={{ maxWidth: 160 }} aria-label="Atalho" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Texto da mensagem" aria-label="Texto" />
          <button className="primary">
            <Icon name="plus" /> Adicionar
          </button>
        </div>
      </form>
      <div className="card flush">
        <table className="table">
          <thead>
            <tr>
              <th>Atalho</th>
              <th>Texto</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  Nenhuma mensagem rápida cadastrada.
                </td>
              </tr>
            )}
            {items.map((x) => (
              <tr key={x.id}>
                <td className="mono accent">{x.shortcut}</td>
                <td>{x.text}</td>
                <td style={{ textAlign: 'right' }}>
                  <button
                    className="icon-btn"
                    aria-label="Excluir mensagem rápida"
                    onClick={async () => {
                      await api.deleteQuickReply(x.id);
                      load();
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Keywords() {
  const [items, setItems] = useState<KeywordRule[]>([]);
  const [keyword, setKeyword] = useState('');
  const [reply, setReply] = useState('');
  const load = () => api.keywordRules().then(setItems);
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h1">Automação por palavras</h1>
          <p className="sub">
            Quando a mensagem do lead contém a palavra, a resposta sai na hora. Só vale para conversas sem agente IA
            atendendo.
          </p>
        </div>
      </div>
      <form
        className="card stack-sm"
        style={{ marginBottom: 14 }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!keyword.trim() || !reply.trim()) return;
          await api.addKeywordRule(keyword, reply);
          setKeyword('');
          setReply('');
          load();
        }}
      >
        <div className="row">
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="Palavra-chave (ex.: horário)" style={{ maxWidth: 220 }} aria-label="Palavra-chave" />
          <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Resposta automática" aria-label="Resposta" />
          <button className="primary">
            <Icon name="plus" /> Adicionar
          </button>
        </div>
      </form>
      <div className="card flush">
        <table className="table">
          <thead>
            <tr>
              <th>Palavra-chave</th>
              <th>Resposta</th>
              <th>Ativa</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Nenhuma regra cadastrada.
                </td>
              </tr>
            )}
            {items.map((x) => (
              <tr key={x.id}>
                <td>
                  <span className="pill primary">{x.keyword}</span>
                </td>
                <td>{x.reply}</td>
                <td>
                  <Switch
                    on={x.active}
                    label="Regra ativa"
                    onChange={async (v) => {
                      await api.updateKeywordRule(x.id, { active: v });
                      load();
                    }}
                  />
                </td>
                <td style={{ textAlign: 'right' }}>
                  <button
                    className="icon-btn"
                    aria-label="Excluir regra"
                    onClick={async () => {
                      await api.deleteKeywordRule(x.id);
                      load();
                    }}
                  >
                    <Icon name="trash" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
