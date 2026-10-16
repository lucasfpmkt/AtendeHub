import { useEffect, useState } from 'react';
import { api } from '../api';

export function Settings() {
  const [systemPrompt, setSystemPrompt] = useState('');
  const [autoReply, setAutoReply] = useState(false);
  const [connected, setConnected] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.aiConfig().then((c) => {
      setSystemPrompt(c.systemPrompt);
      setAutoReply(c.autoReply);
      setConnected(c.providerConnected);
    });
  }, []);

  const save = async () => {
    await api.updateAiConfig({ systemPrompt, autoReply });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="page">
      <h1 className="h1">IA & Ajustes</h1>

      <div className="card" style={{ maxWidth: 640 }}>
        <div className="muted" style={{ marginBottom: 12 }}>
          Provedor de IA:{' '}
          {connected ? (
            <span style={{ color: 'var(--accent)' }}>conectado ✅</span>
          ) : (
            <>
              não configurado — defina <code>ANTHROPIC_API_KEY</code> no{' '}
              <code>.env</code> do servidor. (A UI funciona mesmo assim, com
              rascunhos de exemplo.)
            </>
          )}
        </div>

        <label className="muted">Instrução base do assistente</label>
        <textarea
          rows={5}
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          style={{ marginBottom: 12 }}
        />

        <label className="toggle" style={{ marginBottom: 16 }}>
          <input
            type="checkbox"
            checked={autoReply}
            onChange={(e) => setAutoReply(e.target.checked)}
          />
          Padrão de auto-resposta para novas conversas
        </label>

        <div className="row">
          <button className="primary" onClick={save}>
            Salvar
          </button>
          {saved && <span className="muted">salvo ✓</span>}
        </div>
      </div>
    </div>
  );
}
