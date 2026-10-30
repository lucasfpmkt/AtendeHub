import { useEffect, useRef, type ReactNode } from 'react';

type Edges = { l: number; r: number; t: number; b: number };
type Side = keyof Edges;

const power3Out = (x: number) => 1 - Math.pow(1 - x, 3);
const power3InOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

/** Conteúdo de uma aba do menu + a cópia invertida que aparece sob a pílula. */
export function RailInner({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <span className="rail-inv" aria-hidden>
        {children}
      </span>
    </>
  );
}

/**
 * Pílula "líquida" do menu: a borda da frente vai primeiro e mais rápido,
 * a de trás alcança depois — a pílula se estica como uma gota em vez de
 * deslizar dura. Dentro dela as cores ficam invertidas (fundo escuro,
 * texto branco), recortando a cópia invertida de cada aba.
 */
export function useLiquidPill(deps: unknown[]) {
  const railRef = useRef<HTMLElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const st = useRef<Edges | null>(null);
  const anims = useRef<Partial<Record<Side, { from: number; to: number; t0: number; dur: number; ease: (x: number) => number }>>>({});
  const raf = useRef(0);

  useEffect(() => {
    const rail = railRef.current;
    const pill = pillRef.current;
    if (!rail || !pill) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const box = () => ({ w: rail.scrollWidth, h: rail.scrollHeight });
    const edgesOf = (el: HTMLElement, W: number, H: number): Edges => ({
      l: el.offsetLeft,
      t: el.offsetTop,
      r: W - (el.offsetLeft + el.offsetWidth),
      b: H - (el.offsetTop + el.offsetHeight),
    });

    const paint = () => {
      const s = st.current;
      if (!s) return;
      const { w: W, h: H } = box();
      pill.style.width = `${W}px`;
      pill.style.height = `${H}px`;
      pill.style.clipPath = `inset(${s.t}px ${s.r}px ${s.b}px ${s.l}px round 10px)`;
      // Texto invertido: recorta a cópia de cada aba pela mesma forma da pílula.
      rail.querySelectorAll<HTMLElement>('.rail-link').forEach((link) => {
        const inv = link.querySelector<HTMLElement>(':scope > .rail-inv');
        if (!inv) return;
        const e = edgesOf(link, W, H);
        const t = s.t - e.t;
        const b = s.b - e.b;
        const l = s.l - e.l;
        const r = s.r - e.r;
        const hidden = t >= link.offsetHeight || b >= link.offsetHeight || l >= link.offsetWidth || r >= link.offsetWidth;
        inv.style.clipPath = hidden ? 'inset(100%)' : `inset(${t}px ${r}px ${b}px ${l}px round 10px)`;
      });
    };

    const tick = (now: number) => {
      const s = st.current!;
      let running = false;
      for (const k of Object.keys(anims.current) as Side[]) {
        const a = anims.current[k]!;
        const p = Math.min(1, (now - a.t0) / a.dur);
        s[k] = a.from + (a.to - a.from) * a.ease(p);
        if (p < 1) running = true;
        else delete anims.current[k];
      }
      paint();
      raf.current = running ? requestAnimationFrame(tick) : 0;
    };

    const tween = (k: Side, to: number, dur: number, ease: (x: number) => number) => {
      anims.current[k] = { from: st.current![k], to, t0: performance.now(), dur, ease };
    };

    const go = (animate: boolean) => {
      const target = rail.querySelector<HTMLElement>('.rail-link.active');
      if (!target) {
        pill.style.opacity = '0';
        return;
      }
      pill.style.opacity = '1';
      const { w: W, h: H } = box();
      const to = edgesOf(target, W, H);
      const s = st.current;
      if (!s || !animate || reduce) {
        anims.current = {};
        st.current = { ...to };
        paint();
        return;
      }
      const vertical = Math.abs(to.t - s.t) > Math.abs(to.l - s.l);
      const fwd = vertical ? to.t > s.t : to.l > s.l;
      const [lead, trail]: [Side, Side] = vertical ? (fwd ? ['b', 't'] : ['t', 'b']) : fwd ? ['r', 'l'] : ['l', 'r'];
      const others: Side[] = vertical ? ['l', 'r'] : ['t', 'b'];
      tween(lead, to[lead], 360, power3Out);
      tween(trail, to[trail], 550, power3InOut);
      for (const k of others) tween(k, to[k], 360, power3Out);
      if (!raf.current) raf.current = requestAnimationFrame(tick);
    };

    go(st.current !== null);
    // Mudou o tamanho do menu (recolher, girar o celular): reposiciona sem animar.
    const ro = new ResizeObserver(() => {
      if (!raf.current) go(false);
    });
    ro.observe(rail);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return { railRef, pillRef };
}
