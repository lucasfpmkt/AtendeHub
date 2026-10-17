import { useEffect, useState } from 'react';
import { authOptions, login, signup, type SessionUser, type WorkspaceInfo } from '../api';

type Mode = 'login' | 'signup';

export function Login({ onSuccess }: { onSuccess: (r: { user: SessionUser; workspace: WorkspaceInfo }) => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [allowSignup, setAllowSignup] = useState(false);
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authOptions().then((o) => setAllowSignup(o.allowSignup));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = mode === 'login' ? await login(email, password) : await signup({ name, company, email, password });
      onSuccess(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    setError('');
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <img src="/logo.png" alt="" />
          <span className="wordmark">
            Law<b>Hub</b>
          </span>
        </div>
        <div>
          <h1 className="auth-title">{mode === 'login' ? 'Entrar na sua conta' : 'Criar conta'}</h1>
          <p className="sub">
            {mode === 'login'
              ? 'Use o e-mail e a senha do seu escritório.'
              : 'Cadastre seu escritório. Você começa com 7 dias de teste.'}
          </p>
        </div>

        {mode === 'signup' && (
          <>
            <div className="field">
              <label htmlFor="su-name">Seu nome</label>
              <input id="su-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            </div>
            <div className="field">
              <label htmlFor="su-company">Nome do escritório</label>
              <input
                id="su-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                autoComplete="organization"
                placeholder="Ex.: Silva Advocacia"
                required
              />
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="au-email">{mode === 'login' ? 'E-mail ou usuário' : 'E-mail'}</label>
          <input
            id="au-email"
            type={mode === 'login' ? 'text' : 'email'}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </div>
        <div className="field">
          <label htmlFor="au-pass">Senha</label>
          <div className="pass-wrap">
            <input
              id="au-pass"
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={mode === 'signup' ? 8 : undefined}
              required
            />
            <button type="button" className="ghost sm" onClick={() => setShow((v) => !v)}>
              {show ? 'Ocultar' : 'Mostrar'}
            </button>
          </div>
          {mode === 'signup' && <span className="muted small">Pelo menos 8 caracteres.</span>}
        </div>

        {error && <div className="alert">{error}</div>}

        <button className="primary block" type="submit" disabled={busy}>
          {busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : 'Criar conta'}
        </button>

        {allowSignup && (
          <p className="auth-switch">
            {mode === 'login' ? (
              <>
                Ainda não tem conta?{' '}
                <button type="button" className="link" onClick={() => switchMode('signup')}>
                  Criar conta
                </button>
              </>
            ) : (
              <>
                Já tem conta?{' '}
                <button type="button" className="link" onClick={() => switchMode('login')}>
                  Entrar
                </button>
              </>
            )}
          </p>
        )}
      </form>
    </div>
  );
}
