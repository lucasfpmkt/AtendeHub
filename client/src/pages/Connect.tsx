import { useEffect, useState } from 'react';
import { api } from '../api';
import { socket } from '../socket';

export function Connect({ status, me }: { status: string; me?: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <h1 className="h1">Conexão com o WhatsApp</h1>

      {status === 'connected' ? (
        <div className="card qr-wrap">
          <p>✅ Número conectado{me ? `: ${me.split(':')[0].split('@')[0]}` : ''}.</p>
          <button onClick={logout} disabled={busy}>
            Desconectar número
          </button>
        </div>
      ) : (
        <div className="card qr-wrap">
          {qr ? (
            <>
              <img src={qr} alt="QR code do WhatsApp" />
              <p className="muted">
                Abra o WhatsApp no celular → Aparelhos conectados → Conectar um
                aparelho, e escaneie este código.
              </p>
            </>
          ) : (
            <>
              <p className="muted">
                Clique abaixo para gerar o QR code e vincular um número.
              </p>
              <button className="primary" onClick={connect} disabled={busy}>
                {busy ? 'Gerando…' : 'Gerar QR code'}
              </button>
            </>
          )}
        </div>
      )}

      <p className="muted" style={{ marginTop: 16, maxWidth: 560, fontSize: 13 }}>
        ⚠️ A conexão por QR usa o protocolo do WhatsApp Web e não é oficial:
        contraria os termos do WhatsApp e pode levar ao bloqueio do número. Para
        produção séria, avalie migrar para a WhatsApp Business Cloud API.
      </p>
    </div>
  );
}
