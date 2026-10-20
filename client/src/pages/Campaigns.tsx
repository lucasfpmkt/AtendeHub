import { useEffect, useState } from 'react';
import { api, type Stage, type Tag } from '../api';
import { Icon } from '../icons';

type Aud = 'all' | 'tag' | 'stage';

export function Campaigns({ connected }: { connected: boolean }) {
  const [body, setBody] = useState('');
  const [aud, setAud] = useState<Aud>('all');
  const [tagValue, setTagValue] = useState('');
  const [stageValue, setStageValue] = useState('');
  const [tags, setTags] = useState<Tag[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [list, setList] = useState<Awaited<ReturnType<typeof api.campaigns>>>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () => api.campaigns().then(setList).catch(() => {});

  useEffect(() => {
    load();
    api.tags().then(setTags).catch(() => {});
    api
      .funnels()
      .then((fs) => (fs[0] ? api.board(fs[0].id).then((b) => setStages(b.stages)) : null))
      .catch(() => {});
    const t = setInterval(load, 5000); // acompanha o progresso
    return () => clearInterval(t);
  }, []);

  const disparar = async () => {
    if (!body.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      const value = aud === 'tag' ? tagValue : aud === 'stage' ? stageValue : undefined;
      const r = await api.startCampaign(body.trim(), aud, value);
      setMsg({ ok: true, text: `Disparo iniciado para ${r.total} contato(s).` });
      setBody('');
      load();
    } catch (x) {
      setMsg({ ok: false, text: (x as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="h1">Campanhas</h1>
          <p className="sub">Dispare uma mensagem para vários contatos de uma vez.</p>
        </div>
      </div>

      {!connected && (
        <div className="alert" style={{ marginBottom: 14 }}>
          Conecte o WhatsApp para disparar campanhas.
        </div>
      )}

      <div className="grid2">
        <div className="card stack">
          <h3 className="card-title">
            <Icon name="send" /> Nova campanha
          </h3>
          <div className="field-sm">
            <span>Público</span>
            <div className="segmented" style={{ alignSelf: 'flex-start' }}>
              {(
                [
                  ['all', 'Todas as conversas'],
                  ['tag', 'Por etiqueta'],
                  ['stage', 'Por etapa'],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className={aud === k ? 'active' : ''} onClick={() => setAud(k)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          {aud === 'tag' && (
            <div className="field-sm">
              <span>Etiqueta</span>
              <select value={tagValue} onChange={(e) => setTagValue(e.target.value)}>
                <option value="">Selecione…</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {aud === 'stage' && (
            <div className="field-sm">
              <span>Etapa</span>
              <select value={stageValue} onChange={(e) => setStageValue(e.target.value)}>
                <option value="">Selecione…</option>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field-sm">
            <span>Mensagem</span>
            <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Escreva a mensagem da campanha…" />
          </div>
          <p className="muted small">
            O envio é espaçado (uma mensagem a cada poucos segundos) para reduzir risco de bloqueio do WhatsApp. Evite disparos
            muito grandes de uma vez.
          </p>
          <div className="row">
            <button
              className="primary"
              onClick={disparar}
              disabled={busy || !connected || !body.trim() || (aud === 'tag' && !tagValue) || (aud === 'stage' && !stageValue)}
            >
              {busy ? 'Iniciando…' : 'Disparar campanha'}
            </button>
            {msg && <span className={`small ${msg.ok ? 'ok-text' : 'late-text'}`}>{msg.text}</span>}
          </div>
        </div>

        <div className="card">
          <h3 className="card-title">
            <Icon name="history" /> Campanhas recentes
          </h3>
          {list.length === 0 && <p className="muted small">Nenhuma campanha ainda.</p>}
          {list.map((c) => (
            <div key={c.id} className="fun-row">
              <div className="row between small">
                <span>{c.body.slice(0, 48)}{c.body.length > 48 ? '…' : ''}</span>
                <span className="mono">
                  {c.sent}/{c.total}
                </span>
              </div>
              <div className="bar">
                <i
                  style={{
                    width: `${c.total ? (c.sent / c.total) * 100 : 0}%`,
                    background: c.status === 'error' ? 'var(--bad)' : c.status === 'done' ? 'var(--ok)' : 'var(--p-600)',
                  }}
                />
              </div>
              <div className="row between small muted">
                <span>{c.audience}</span>
                <span>
                  {c.status === 'running' ? 'enviando…' : c.status === 'done' ? 'concluída' : 'interrompida'} ·{' '}
                  {new Date(c.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
