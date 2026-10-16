import { useEffect, useState } from 'react';
import { api, type Stage } from '../api';

const BRL = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function Pipeline() {
  const [stages, setStages] = useState<Stage[]>([]);
  const [dragDeal, setDragDeal] = useState<string | null>(null);

  const load = () => api.stages().then(setStages);

  useEffect(() => {
    load();
  }, []);

  const addStage = async () => {
    const name = prompt('Nome da etapa:');
    if (name) {
      await api.addStage(name);
      load();
    }
  };

  const drop = async (stageId: string) => {
    if (!dragDeal) return;
    await api.moveDeal(dragDeal, stageId);
    setDragDeal(null);
    load();
  };

  return (
    <div className="page">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <h1 className="h1" style={{ margin: 0 }}>
          Funil de vendas
        </h1>
        <button onClick={addStage}>+ Etapa</button>
      </div>

      {stages.length === 0 ? (
        <p className="muted">
          Nenhuma etapa ainda. Crie etapas (ex.: Novo, Em negociação, Fechado) e
          arraste oportunidades entre elas.
        </p>
      ) : (
        <div className="board">
          {stages.map((s) => (
            <div
              key={s.id}
              className="column"
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => drop(s.id)}
            >
              <h3>
                {s.name} <span className="muted">({s.deals.length})</span>
              </h3>
              {s.deals.map((d) => (
                <div
                  key={d.id}
                  className="deal"
                  draggable
                  onDragStart={() => setDragDeal(d.id)}
                >
                  <strong>{d.title}</strong>
                  <div className="muted">{d.contact.name || d.contact.phone}</div>
                  <div>{BRL(d.valueCents)}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
