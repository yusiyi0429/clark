'use client';

/** 从概念版移植的 Siri 曲线。能量来自本次录音的同一条麦克风流；减少动效时静止。 */

import { useEffect, useRef } from 'react';

/** 洋红、天青、蓝紫：照参考图取的三种光。 */
const COLORS = ['255, 104, 198', '98, 226, 255', '132, 108, 255'];
const ATT = 4;
/** 横向取样范围：x 在 [−SPAN, SPAN] 上，铺满整条画布。 */
const SPAN = 11;

const att = (x: number) => Math.pow(ATT / (ATT + x * x), ATT);

interface Lobe {
  amp: number;
  target: number;
  offset: number;
  width: number;
  speed: number;
  phase: number;
  life: number;
  age: number;
}

function spawn(random: () => number, lobe?: Lobe): Lobe {
  const next: Lobe = lobe ?? { amp: 0, target: 0, offset: 0, width: 1, speed: 0, phase: 0, life: 0, age: 0 };
  next.amp = 0;
  next.target = 0.35 + random() * 0.65;
  next.offset = -3 + random() * 6;
  next.width = 1 + random() * 2;
  next.speed = 0.5 + random() * 0.5;
  next.phase = random() * Math.PI * 2;
  next.life = 1.4 + random() * 2.4;
  next.age = 0;
  return next;
}

export function SiriWave({ energy, className, still = false }: {
  /** 0–1：真实麦克风响度。 */
  energy: number;
  className?: string;
  /** 停在当前这一帧不动（新首页页头、伙伴名片里空闲时）；变回 false 接着流动。 */
  still?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const energyRef = useRef(energy);
  useEffect(() => { energyRef.current = energy; }, [energy]);
  const stillRef = useRef(still);
  const restart = useRef<() => void>(() => {});
  useEffect(() => { stillRef.current = still; restart.current(); }, [still]);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = motion.matches
      || document.documentElement.dataset.reduceMotion === 'true';
    // 固定种子：减少动效时那一帧每次都一样，不会刷新一下换一个样子。
    let seed = 20260924;
    const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const curves = COLORS.map(() => Array.from({ length: 2 + Math.floor(random() * 3) }, () => {
      const lobe = spawn(random);
      lobe.amp = lobe.target * 0.7;
      lobe.age = random() * lobe.life;
      return lobe;
    }));

    let width = 0;
    let height = 0;
    let ratio = 1;
    const resize = () => {
      ratio = Math.min(2, window.devicePixelRatio || 1);
      // 量布局尺寸，不用 getBoundingClientRect：胶囊出现时自己带着缩放，二级页打开时整页也在缩放，
      // 那样量出来的是缩过的尺寸，动画结束后画布就一直小一圈、发虚（缩放结束不会触发 ResizeObserver）。
      width = element.clientWidth;
      height = element.clientHeight;
      element.width = Math.max(1, Math.round(width * ratio));
      element.height = Math.max(1, Math.round(height * ratio));
    };
    resize();
    const observer = new ResizeObserver(() => { resize(); if (reduced || stillRef.current) draw(); });
    observer.observe(element);

    let level = 0.12 + energyRef.current * 0.88;

    function draw() {
      if (!context || !width || !height) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const middle = height / 2;
      const reach = height * 0.44;
      context.globalCompositeOperation = 'lighter';
      for (let c = 0; c < curves.length; c += 1) {
        const lobes = curves[c];
        const heights: number[] = [];
        for (let px = 0; px <= width + 1; px += 2) {
          const i = (px / width) * 2 * SPAN - SPAN;
          let y = 0;
          for (const lobe of lobes) {
            const x = i / lobe.width - lobe.offset;
            y += Math.abs(lobe.amp * Math.sin(x - lobe.phase) * att(x));
          }
          // 几段叠在一起时按根号平均：全取平均光太细看不见，直接相加又会顶出画布。
          heights.push(Math.min(reach, reach * level * (y / Math.sqrt(lobes.length)) * 1.5));
        }
        context.beginPath();
        context.moveTo(0, middle);
        heights.forEach((h, index) => context.lineTo(index * 2, middle - h));
        for (let index = heights.length - 1; index >= 0; index -= 1) context.lineTo(index * 2, middle + heights[index]);
        context.closePath();
        context.fillStyle = `rgba(${COLORS[c]}, 0.78)`;
        context.fill();
      }
      context.globalCompositeOperation = 'source-over';
    }

    function step(dt: number) {
      const e = Math.max(0, Math.min(1, energyRef.current));
      level += (0.12 + e * 0.88 - level) * Math.min(1, dt * 12);
      const pace = 1.1 + e * 1.6;
      for (const lobes of curves) {
        for (const lobe of lobes) {
          lobe.age += dt;
          lobe.phase += lobe.speed * dt * pace;
          if (lobe.age > lobe.life) lobe.target = 0;
          lobe.amp += (lobe.target - lobe.amp) * Math.min(1, dt * 2.4);
          if (lobe.target === 0 && lobe.amp < 0.02) spawn(random, lobe);
        }
      }
    }

    let frame = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      step(dt);
      draw();
      frame = requestAnimationFrame(loop);
    };
    const start = () => { cancelAnimationFrame(frame); if (reduced || stillRef.current || document.visibilityState !== 'visible') return; last = performance.now(); frame = requestAnimationFrame(loop); };
    restart.current = start;
    const onVisibility = () => start();
    const onMotion = () => { reduced = motion.matches; start(); draw(); };
    draw();
    start();
    document.addEventListener('visibilitychange', onVisibility);
    motion.addEventListener('change', onMotion);
    return () => {
      restart.current = () => {};
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      motion.removeEventListener('change', onMotion);
    };
  }, []);

  return <canvas ref={canvas} className={className} aria-hidden />;
}
