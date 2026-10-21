import { useEffect, useState } from 'react';
import { api } from '../api';
import { socket } from '../socket';
import { Icon } from '../icons';

type Mode = 'qr' | 'code';

const fmtCode = (c: string) => (c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c);

export function Connect({ status, me }: { status: string; me?: string }) {
  const [mode, setMode] = useState<Mode>('qr');
  const [qr, setQr] = useState<string | null>(null);
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [waitingCode, setWaitingCode] = useState(false);
  const [confirm, setConfirm] = useState(false);

  // Tipo de conexão: QR (servidor próprio) ou API Oficial (Meta Cloud API).
  const [conn, setConn] = useState<'qr' | 'cloud'>('qr');
  const [cloud, setCloud] = useState<{ phoneId: string; token: string; wabaId: string; hasToken: boolean; verifyToken: string; webhookUrl: string } | null>(
    null,
  );
  const [cloudMsg, setCloudMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const loadCloud = () =>
    api.waCloud().then((c) => {
      setConn(c.channel === 'cloud' ? 'cloud' : 'qr');
      setCloud({ phoneId: c.phoneId, token: '', wabaId: c.wabaId, hasToken: c.hasToken, verifyToken: c.verifyToken, webhookUrl: c.webhookUrl });
    });
  useEffect(() => {
    loadCloud().catch(() => {});
  }, []);

  const saveCloud = async (activate: boolean) => {
    if (!cloud) return;
    setCloudMsg(null);
    try {
      await api.waCloudSave({
        channel: activate ? 'cloud' : undefined,
        phoneId: cloud.phoneId,
        wabaId: cloud.wabaId,
        ...(cloud.token.trim() ? { token: cloud.token.trim() } : {}),
      });
      setCloudMsg({ ok: true, text: activate ? 'API Oficial ativada.' : 'Salvo.' });
      await loadCloud();
    } catch (x) {
      setCloudMsg({ ok: false, text: (x as Error).message });
    }
  };
  const useQrChannel = async () => {
    try {
      await api.waCloudSave({ channel: 'qr' });
      setConn('qr');
    } catch {
      /* ignore */
    }
  };
  const copy = (t: string) => navigator.clipboard?.writeText(t).catch(() => {});

  useEffect(() => {
    api.waStatus().then((s) => {
      setQr(s.qr);
      if (s.pairCode) {
        setPairCode(s.pairCode);
        setMode('code');
      }
    });
    const onQr = (e: { dataUrl: string }) => setQr(e.dataUrl);
    const onPair = (e: { code: string | null; error?: string }) => {
      setWaitingCode(false);
      setPairCode(e.code);
      if (e.error) setError(e.error);
    };
    const onStatus = (e: { status: string }) => {
      if (e.status === 'connected' || e.status === 'disconnected') {
        setQr(null);
        setPairCode(null);
        setWaitingCode(false);
      }
    };
    socket.on('wa:qr', onQr);
    socket.on('wa:pair', onPair);
    socket.on('wa:status', onStatus);
    return () => {
      socket.off('wa:qr', onQr);
      socket.off('wa:pair', onPair);
      socket.off('wa:status', onStatus);
    };
  }, []);

  const connectQr = async () => {
    setBusy(true);
    setError('');
    try {
      await api.waConnect();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reconnectFresh = async () => {
    setBusy(true);
    setError('');
    setQr(null);
    try {
      await api.waReconnect(); // apaga a sessão antiga e gera um QR novo
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const connectCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setPairCode(null);
    try {
      const r = await api.waConnect(phone);
      if (r.pairCode) setPairCode(r.pairCode);
      else setWaitingCode(true); // o código chega pelo tempo real em alguns segundos
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    try {
      await api.waLogout();
      setQr(null);
      setPairCode(null);
      setConfirm(false);
    } finally {
      setBusy(false);
    }
  };

  const number = me ? me.split(':')[0].split('@')[0] : '';

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h1">Conexão WhatsApp</h1>
          <p className="sub">Cada escritório conecta o próprio número. Os agentes respondem por ele.</p>
        </div>
        {conn === 'qr' && status !== 'connected' && (
          <div className="segmented">
            <button className={mode === 'qr' ? 'active' : ''} onClick={() => setMode('qr')}>
              QR code
            </button>
            <button className={mode === 'code' ? 'active' : ''} onClick={() => setMode('code')}>
              Código pelo número
            </button>
          </div>
        )}
      </div>

      {/* Tipo de conexão: servidor próprio (QR) ou API Oficial da Meta. */}
      <div className="segmented" style={{ marginBottom: 14, alignSelf: 'flex-start' }}>
        <button className={conn === 'qr' ? 'active' : ''} onClick={useQrChannel}>
          <Icon name="wifi" size={15} /> Conexão via QR Code
        </button>
        <button className={conn === 'cloud' ? 'active' : ''} onClick={() => setConn('cloud')}>
          <Icon name="shield" size={15} /> API Oficial (Meta)
        </button>
      </div>

      {conn === 'qr' &&
        (status === 'connected' ? (
        <div className="card connect-card">
          <span className="connect-ico ok">
            <Icon name="wifi" size={26} />
          </span>
          <div>
            <h3 className="card-title" style={{ margin: 0 }}>
              Número conectado
            </h3>
            <p className="mono" style={{ marginTop: 4 }}>
              +{number}
            </p>
          </div>
          <button onClick={() => setConfirm(true)} disabled={busy}>
            Desconectar número
          </button>
        </div>
      ) : mode === 'qr' ? (
        <div className="card connect-card">
          {qr ? (
            <>
              <img src={qr} alt="QR code do WhatsApp" className="qr" />
              <ol className="steps">
                <li>Abra o WhatsApp no celular do escritório.</li>
                <li>
                  Toque em <b>Aparelhos conectados</b> e depois em <b>Conectar um aparelho</b>.
                </li>
                <li>Aponte a câmera para este código.</li>
              </ol>
            </>
          ) : (
            <>
              <span className="connect-ico">
                <Icon name="wifi" size={26} />
              </span>
              <div>
                <h3 className="card-title" style={{ margin: 0 }}>
                  {status === 'connecting' ? 'Conectando…' : 'Nenhum número conectado'}
                </h3>
                <p className="muted small" style={{ marginTop: 4 }}>
                  Gere o QR code e leia com o WhatsApp do escritório.
                </p>
              </div>
              <div className="stack-sm" style={{ alignItems: 'flex-end' }}>
                <button className="primary" onClick={connectQr} disabled={busy || status === 'connecting'}>
                  {busy ? 'Gerando…' : 'Gerar QR code'}
                </button>
                <button className="link" onClick={reconnectFresh} disabled={busy} title="Apaga a sessão antiga e gera um QR novo">
                  Travou / não aparece o QR? Gerar novo do zero
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="card connect-card" style={{ alignItems: 'flex-start' }}>
          {pairCode ? (
            <>
              <div className="pair-code mono" aria-label="Código de pareamento">
                {fmtCode(pairCode)}
              </div>
              <ol className="steps">
                <li>Abra o WhatsApp no celular do número informado.</li>
                <li>
                  Toque em <b>Aparelhos conectados</b> → <b>Conectar um aparelho</b>.
                </li>
                <li>
                  Na tela da câmera, toque em <b>Conectar com número de telefone</b>.
                </li>
                <li>Digite este código. Ele vale por poucos minutos.</li>
              </ol>
            </>
          ) : (
            <form className="stack-sm" style={{ flex: 1, minWidth: 260 }} onSubmit={connectCode}>
              <div className="field-sm">
                <span>Número do WhatsApp do escritório (com DDI e DDD)</span>
                <input
                  className="mono"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="55 21 99999-0000"
                  inputMode="tel"
                  autoComplete="tel"
                  required
                />
              </div>
              <div className="row">
                <button className="primary" disabled={busy || waitingCode}>
                  {busy || waitingCode ? 'Gerando código…' : 'Gerar código'}
                </button>
                <span className="muted small">Use quando a leitura do QR não funcionar.</span>
              </div>
            </form>
          )}
        </div>
      ))}

      {conn === 'cloud' && (
        <div className="card stack" style={{ maxWidth: 720 }}>
          <div className="row between">
            <h3 className="card-title" style={{ margin: 0 }}>
              <Icon name="shield" /> API Oficial do WhatsApp (Meta)
            </h3>
            <span className={`pill ${status === 'connected' ? 'ok' : 'warn'}`}>{status === 'connected' ? 'Conectada' : 'Não conectada'}</span>
          </div>
          <p className="muted small">
            Conexão oficial e estável (menos risco de bloqueio). Requer uma conta no <b>Meta for Developers</b> com um app de
            WhatsApp. Cole abaixo o <b>Phone Number ID</b> e um <b>token permanente</b>, e configure o webhook na Meta com os
            dados ao lado.
          </p>

          <div className="duo">
            <div className="field-sm">
              <span>Phone Number ID</span>
              <input value={cloud?.phoneId ?? ''} onChange={(e) => setCloud((c) => c && { ...c, phoneId: e.target.value })} placeholder="ex.: 1098...456" />
            </div>
            <div className="field-sm">
              <span>WhatsApp Business Account ID (opcional)</span>
              <input value={cloud?.wabaId ?? ''} onChange={(e) => setCloud((c) => c && { ...c, wabaId: e.target.value })} placeholder="ex.: 1023...789" />
            </div>
          </div>
          <div className="field-sm">
            <span>Token permanente (System User)</span>
            <input
              type="password"
              value={cloud?.token ?? ''}
              onChange={(e) => setCloud((c) => c && { ...c, token: e.target.value })}
              placeholder={cloud?.hasToken ? '•••••••• (token salvo — deixe em branco para manter)' : 'cole o token'}
              autoComplete="off"
            />
          </div>

          <div className="field-sm">
            <span>Webhook (configure na Meta → WhatsApp → Configuration)</span>
            <div className="row" style={{ gap: 6 }}>
              <input readOnly value={cloud?.webhookUrl ?? ''} className="mono" style={{ fontSize: 12.5 }} />
              <button className="soft" onClick={() => cloud && copy(cloud.webhookUrl)}>
                <Icon name="copy" size={14} /> Copiar
              </button>
            </div>
          </div>
          <div className="field-sm">
            <span>Token de verificação do webhook</span>
            <div className="row" style={{ gap: 6 }}>
              <input readOnly value={cloud?.verifyToken ?? ''} className="mono" style={{ fontSize: 12.5 }} />
              <button className="soft" onClick={() => cloud && copy(cloud.verifyToken)}>
                <Icon name="copy" size={14} /> Copiar
              </button>
            </div>
            <span className="muted small">
              Na Meta, cole a URL e este token em <b>Configuration → Webhook</b>, verifique, e assine o campo <b>messages</b>.
            </span>
          </div>

          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="primary" onClick={() => saveCloud(true)}>
              Salvar e ativar API Oficial
            </button>
            {cloudMsg && <span className={`small ${cloudMsg.ok ? 'ok-text' : 'late-text'}`}>{cloudMsg.text}</span>}
          </div>
        </div>
      )}

      {error && (
        <div className="alert" style={{ marginTop: 12, maxWidth: 720 }}>
          {error}
        </div>
      )}

      {conn === 'qr' && (
        <p className="muted small" style={{ marginTop: 14, maxWidth: 620 }}>
          Se o celular mostrar “Não é possível conectar novos dispositivos no momento”, o WhatsApp bloqueou novas conexões
          por um tempo. Espere algumas horas, remova aparelhos antigos em Aparelhos conectados e tente uma vez só. A
          conexão por QR ou código usa o protocolo não oficial do WhatsApp Web e pode levar ao bloqueio do número.
        </p>
      )}

      {confirm && (
        <div className="modal-backdrop" onClick={() => setConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Desconectar +{number}?</h3>
            <p className="muted">Os agentes param de responder até você conectar de novo.</p>
            <div className="modal-actions">
              <button onClick={() => setConfirm(false)}>Cancelar</button>
              <button className="danger" onClick={logout} disabled={busy}>
                Desconectar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
