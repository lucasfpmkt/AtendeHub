import { useEffect, useRef } from 'react';

/**
 * Fundo animado com partículas na cor da marca (vermelho por padrão).
 * Fica atrás de tudo (pointer-events: none), pausa com a aba oculta e
 * fica parado para quem prefere menos movimento.
 */
export function Particles() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const brand = () => getComputedStyle(document.documentElement).getPropertyValue('--p-600').trim() || '#b71312';
    const rgb = (hex: string) => {
      const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
      return m ? m.slice(1).map((x) => parseInt(x, 16)).join(',') : '183,19,18';
    };
    let color = rgb(brand());
    // Brilho de uma partícula desenhado uma vez só (bem mais leve por quadro).
    const sprite = document.createElement('canvas');
    const paintSprite = () => {
      sprite.width = sprite.height = 64;
      const sc = sprite.getContext('2d')!;
      const g = sc.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, `rgba(${color},1)`);
      g.addColorStop(0.18, `rgba(${color},0.75)`);
      g.addColorStop(0.4, `rgba(${color},0.22)`);
      g.addColorStop(1, `rgba(${color},0)`);
      sc.clearRect(0, 0, 64, 64);
      sc.fillStyle = g;
      sc.fillRect(0, 0, 64, 64);
    };
    paintSprite();

    type P = { x: number; y: number; vx: number; vy: number; r: number; a: number; tw: number };
    let parts: P[] = [];
    let w = 0;
    let h = 0;
    let raf = 0;
    let dpr = 1;

    const make = (): P => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.25,
      vy: -0.08 - Math.random() * 0.22, // sobem devagar
      r: 0.8 + Math.random() * 2.4,
      a: 0.25 + Math.random() * 0.5,
      tw: Math.random() * Math.PI * 2,
    });

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const target = Math.round(Math.min(110, Math.max(35, (w * h) / 16000)));
      parts = parts.slice(0, target);
      while (parts.length < target) parts.push(make());
    };

    const LINK = 120;
    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      // linhas finas entre partículas próximas (efeito "rede")
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        for (let j = i + 1; j < parts.length; j++) {
          const q = parts[j];
          const dx = p.x - q.x;
          const dy = p.y - q.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < LINK * LINK) {
            const o = (1 - Math.sqrt(d2) / LINK) * 0.12;
            ctx.strokeStyle = `rgba(${color},${o})`;
            ctx.lineWidth = 0.6;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.stroke();
          }
        }
      }
      for (const p of parts) {
        const a = p.a * (0.7 + 0.3 * Math.sin(t / 900 + p.tw));
        const size = p.r * 8;
        ctx.globalAlpha = a;
        ctx.drawImage(sprite, p.x - size / 2, p.y - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
    };

    // ~30 quadros/s: o movimento é lento e isso alivia o desfoque do vidro por cima.
    let lastT = 0;
    const step = (t: number) => {
      raf = requestAnimationFrame(step);
      if (t - lastT < 32) return;
      const k = lastT ? Math.min((t - lastT) / 16.7, 4) : 1;
      lastT = t;
      for (const p of parts) {
        p.x += p.vx * k;
        p.y += p.vy * k;
        if (p.y < -10) {
          p.y = h + 10;
          p.x = Math.random() * w;
        }
        if (p.x < -10) p.x = w + 10;
        if (p.x > w + 10) p.x = -10;
      }
      draw(t);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      lastT = 0;
      if (reduce) draw(0);
      else raf = requestAnimationFrame(step);
    };
    const onVis = () => (document.hidden ? cancelAnimationFrame(raf) : start());
    // Troca de cor da marca (vermelho/azul) em Configurações.
    const mo = new MutationObserver(() => {
      color = rgb(brand());
      paintSprite();
      if (reduce) draw(0);
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-brand'] });

    resize();
    start();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelAnimationFrame(raf);
      mo.disconnect();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return <canvas ref={ref} className="particles" aria-hidden />;
}

/**
 * Destaque "líquido" do menu: uma pílula de vidro que desliza com efeito
 * elástico até a aba ativa e se estica no caminho.
 */
export function useLiquidIndicator(deps: unknown[]) {
  const railRef = useRef<HTMLElement>(null);
  const blobRef = useRef<HTMLSpanElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const rail = railRef.current;
    const blob = blobRef.current;
    if (!rail || !blob) return;
    const place = (animate: boolean) => {
      const el = rail.querySelector<HTMLElement>('.rail-link.active');
      if (!el) {
        blob.style.opacity = '0';
        return;
      }
      const x = el.offsetLeft;
      const y = el.offsetTop;
      blob.style.opacity = '1';
      blob.style.width = `${el.offsetWidth}px`;
      blob.style.height = `${el.offsetHeight}px`;
      blob.style.transform = `translate(${x}px, ${y}px)`;
      const prev = last.current;
      if (animate && prev && (prev.x !== x || prev.y !== y)) {
        // Reinicia a animação de "gota" (estica e volta).
        const dir = Math.abs(y - prev.y) >= Math.abs(x - prev.x) ? 'v' : 'h';
        blob.classList.remove('wobble-v', 'wobble-h');
        void blob.offsetWidth;
        blob.classList.add(dir === 'v' ? 'wobble-v' : 'wobble-h');
      }
      last.current = { x, y };
    };
    place(last.current !== null);
    const ro = new ResizeObserver(() => {
      blob.classList.add('no-anim');
      place(false);
      requestAnimationFrame(() => blob.classList.remove('no-anim'));
    });
    ro.observe(rail);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { railRef, blobRef };
}
