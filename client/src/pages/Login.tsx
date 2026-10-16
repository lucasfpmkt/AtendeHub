import { useState } from 'react';
import { login } from '../api';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(password);
      onSuccess();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        height: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--bg)',
      }}
    >
      <form className="card" style={{ width: 340 }} onSubmit={submit}>
        <div className="brand" style={{ marginBottom: 16 }}>
          Atende<span>Hub</span>
        </div>
        <label className="muted">Senha de acesso</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoFocus
          style={{ margin: '8px 0 12px' }}
        />
        {error && (
          <div style={{ color: '#f87171', fontSize: 13, marginBottom: 12 }}>
            {error}
          </div>
        )}
        <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
