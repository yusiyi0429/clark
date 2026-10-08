import s from "./whats-new.module.css";

/** 固定种子的伪随机：每次渲染同一片星空，服务端和浏览器输出一致。 */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = seeded(20261001);
/** 越靠近地平线星越少越暗，和真实夜空一样。 */
const FIELD = Array.from({ length: 110 }, (_, index) => {
  const y = Math.pow(random(), 1.6) * 300;
  return { x: random() * 400, y, r: 0.3 + random() * 0.75, o: (0.2 + random() * 0.65) * (1 - y / 420), twinkle: index % 9 === 0 };
});
/** 北斗七星不连线、不标名，只比周围的星亮一些；斗口的天枢最亮。 */
const DIPPER = [[292, 62], [300, 112], [240, 126], [226, 84], [174, 72], [130, 56], [80, 72]] as const;

/** 更新卡片右侧的氛围画：夜空、北斗、自然的极光光幕和被照亮的低云。纯装饰。 */
export function ReleaseArt() {
  return <div className={s.art} aria-hidden="true">
    <svg className={s.layer} viewBox="0 0 400 460" preserveAspectRatio="xMidYMin slice">
      <defs>
        <radialGradient id="ra-star">
          <stop offset="0" stopColor="#fff" stopOpacity=".9" />
          <stop offset=".25" stopColor="#d8f4ff" stopOpacity=".35" />
          <stop offset="1" stopColor="#bfe8ff" stopOpacity="0" />
        </radialGradient>
      </defs>
      {FIELD.map((star, index) => <circle key={index} className={star.twinkle ? s.twinkle : undefined} cx={star.x} cy={star.y} r={star.r} fill="#fff" opacity={star.o} style={star.twinkle ? { animationDelay: `${(index % 5) * -1.7}s` } : undefined} />)}
      {DIPPER.map(([x, y], index) => <g key={index}>
        <circle cx={x} cy={y} r={index === 0 ? 11 : 6} fill="url(#ra-star)" />
        <circle cx={x} cy={y} r={index === 0 ? 1.7 : 1.25} fill="#f4fbff" />
      </g>)}
    </svg>
    <div className={`${s.layer} ${s.auroraFar}`}><Aurora id="ra-far" d="M-40 250C60 228 140 260 220 240S340 220 440 244L440 104C340 80 260 116 190 96S50 80-40 112Z" seed={11} tone="far" /></div>
    <div className={`${s.layer} ${s.auroraNear}`}><Aurora id="ra-near" d="M-40 304C40 282 110 312 190 292S320 270 440 298L440 158C360 128 300 174 230 148S100 134-40 174Z" seed={4} tone="near" /></div>
    <div className={`${s.layer} ${s.clouds}`}>
      <svg viewBox="0 0 400 460" preserveAspectRatio="xMidYMax slice" width="100%" height="100%" overflow="visible">
        <defs>
          {([["ra-cloud-lit", "#a49df0"], ["ra-cloud-body", "#0b1233"]] as const).map(([id, color]) => <filter key={id} id={id} x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency=".007 .022" numOctaves="5" seed="3" />
            <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  3.4 0 0 0 -1.55" result="shape" />
            <feFlood floodColor={color} />
            <feComposite in2="shape" operator="in" />
            <feGaussianBlur stdDeviation="2.2" />
          </filter>)}
          <linearGradient id="ra-cloud-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset=".5" stopColor="#fff" stopOpacity=".9" />
            <stop offset="1" stopColor="#fff" stopOpacity="1" />
          </linearGradient>
          <radialGradient id="ra-cloud-glow" cx=".55" cy=".2" r=".6">
            <stop offset="0" stopColor="#4ee6ff" stopOpacity=".32" />
            <stop offset=".5" stopColor="#8f7dff" stopOpacity=".12" />
            <stop offset="1" stopColor="#8f7dff" stopOpacity="0" />
          </radialGradient>
          <mask id="ra-cloud-mask"><rect x="-40" y="276" width="480" height="184" fill="url(#ra-cloud-fade)" /></mask>
        </defs>
        <g mask="url(#ra-cloud-mask)">
          <rect x="-40" y="262" width="480" height="200" filter="url(#ra-cloud-lit)" className={s.cloudLit} />
          <rect x="-40" y="276" width="480" height="200" filter="url(#ra-cloud-body)" className={s.cloudBody} />
          <rect x="-40" y="262" width="480" height="200" fill="url(#ra-cloud-glow)" className={s.cloudGlow} />
        </g>
      </svg>
    </div>
    <span className={s.grain} />
  </div>;
}

/** 一幅极光光幕：底边最亮、往上渐隐成紫；竖向的光丝来自拉长的噪声。 */
function Aurora({ id, d, seed, tone }: { id: string; d: string; seed: number; tone: "far" | "near" }) {
  const near = tone === "near";
  return <svg viewBox="0 0 400 460" preserveAspectRatio="xMidYMin slice" width="100%" height="100%" overflow="visible">
    <defs>
      <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#9b7dff" stopOpacity="0" />
        <stop offset=".45" stopColor="#8f7dff" stopOpacity={near ? ".35" : ".25"} />
        <stop offset=".76" stopColor="#4ee6ff" stopOpacity={near ? ".8" : ".5"} />
        <stop offset=".92" stopColor="#8affcc" stopOpacity={near ? "1" : ".6"} />
        <stop offset="1" stopColor="#ff9ad6" stopOpacity={near ? ".55" : ".3"} />
      </linearGradient>
      <filter id={`${id}-rays`} x="-10%" y="-20%" width="120%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency=".05 .0018" numOctaves="2" seed={seed} result="noise" />
        <feColorMatrix in="noise" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  2.8 0 0 0 -.9" result="streaks" />
        <feComposite in="SourceGraphic" in2="streaks" operator="in" result="rays" />
        <feGaussianBlur in="rays" stdDeviation=".8 5" result="softRays" />
        <feGaussianBlur in="SourceGraphic" stdDeviation="16" result="glow" />
        <feMerge><feMergeNode in="glow" /><feMergeNode in="softRays" /></feMerge>
      </filter>
    </defs>
    <path d={d} fill={`url(#${id}-fill)`} filter={`url(#${id}-rays)`} />
  </svg>;
}
