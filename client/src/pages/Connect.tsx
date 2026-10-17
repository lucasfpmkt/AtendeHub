import { useEffect, useState } from 'react';
import { api } from '../api';
import { socket } from '../socket';
import { Icon } from '../icons';

export function Connect({ status, me }: { status: string; me?: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    api.waStatus().then((s) => setQr(s.qr));
    const onQr = (e: { dataUrl: string }) => setQr(e.dataUrl);
    const onStatus = (e: { status: string }) => {
      if (e.status === 'connected') setQr(null);
    };
    socket.on('wa:qr', onQr);
    socket.on('wa:status', onStatus);
    return () => {
      socket.off('wa:qr', onQr);
      socket.off('wa:status', onStatus);
    };
  }, []);

  const connect = async () => {
    setBusy(true);
    try {
      await api.waConnect();
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    try {
      await api.waLogout();
      setQr(null);
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
      </div>

      <div className="card connect-card">
        {status === 'connected' ? (
          <>
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
          </>
        ) : qr ? (
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
            <button className="primary" onClick={connect} disabled={busy || status === 'connecting'}>
              {busy ? 'Gerando…' : 'Gerar QR code'}
            </button>
          </>
        )}
      </div>

      <p className="muted small" style={{ marginTop: 14, maxWidth: 620 }}>
        A conexão por QR usa o protocolo do WhatsApp Web e não é oficial. Ela contraria os termos do WhatsApp e pode
        levar ao bloqueio do número. Para uso em escala, o caminho é a WhatsApp Business Cloud API.
      </p>

      {confirm && (
        <div className="modal-backdrop" onClick={() => setConfirm(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Desconectar +{number}?</h3>
            <p className="muted">Os agentes param de responder até você ler um novo QR code.</p>
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
