/**
 * Miles 那颗胶囊的画和动作（components/coagent/MilesCapsule 用）：胶囊原样不动，它平直的上沿就是开口，
 * Miles 从这里探出上半身。照 2026-10-31 定稿的原型搬过来，材质按 11/02 的第 7 版，只留产品里用得到的两种姿势。
 * C妹（11/04 接入）用同一套动作：画、摆位常量和没起名字时的字由调用方传进来（MilesFigure）；
 * 她的画里有眼珠（iris-l、iris-r），转眼时只移眼珠，Miles 没有眼珠，照旧整只眼睛移。
 *
 * - 胶囊：磨砂的乳白玻璃，里面一层很淡的五色渐变（粉、淡紫、天蓝、薄荷、杏），名字下面一道同样几种浅色的
 *   柔开流光（跟着声音变高变快），顶上偏左一点高光，一圈细边；外面不带反光、阴影和发光。在说时整颗染一层淡淡的蓝紫。
 * - 名字：深色细字，本人起的伙伴名字，没起时写形象自己的名字（「Miles」，C妹 写「Mia」）。最窄 70；字放不下时两侧各留 10 往外长，最宽 96
 *   （名字的宽度上限 BUDDY_NAME_UNITS 按这个定；万一某台机器的字体更宽，就把字压进 96 里）。
 * - 页头那颗（size: header，对话层页头，11/03 用户定）：名字和对话正文一样大（15px、同一套字体），胶囊跟着高到 28，
 *   最窄 64，放不下时两侧各留 13 往外长，最宽 124；字小胶囊大才协调。
 * - 出场：从胶囊里升上来约 0.5 秒，带 2px 回弹；退场沉回去约 0.26 秒。
 * - 平时（待机）：头摆正，随机眨眼、偶尔转头看一眼；比耶的手举 9–16 秒就放进胶囊里歇 5–10 秒。
 * - 在听：头微微侧过来、目光朝向说话的人，耳机跟着声音亮；在说：嘴跟着音节开合。
 *
 * 动画用 WAAPI，跑完把终态写回元素再撤掉；减少动效时直接摆好终态，只剩名字和流光的静帧。
 */

export type MilesPose = "idle" | "listening" | "speaking";

/** 一种探出胶囊的形象：摆位常量和画（milesArt、cmeiArt 的格式，id 写成 {id}-…），没起名字时胶囊上写的字。 */
export interface MilesFigure {
  art: { viewBox: string; torsoCx: number; lipY: number; figureWidth: number; topY: number; gazeUnit: number };
  svg: string;
  name: string;
}

/** 胶囊两档：高、最窄、最宽、名字放不下时两侧各留多少、字号（页头那颗的字体跟页面走，和对话正文一样）。 */
const CAPSULES = {
  small: { h: 22, minW: 70, maxW: 96, pad: 10, font: 10 },
  header: { h: 28, minW: 64, maxW: 124, pad: 13, font: 15 },
} as const;
export type MilesCapsuleSize = keyof typeof CAPSULES;

/** 样式表里给动画层的几个类（coagent-miles.module.css）。 */
export interface MilesClasses {
  headPose: string;
  gaze: string;
  breathe: string;
  speakGlass: string;
}

export interface MilesRig {
  /** 换胶囊上的名字，返回胶囊此刻的宽。 */
  setName(name: string): number;
  setPose(pose: MilesPose): void;
  /** 0–1：在听时对方说话的响度。 */
  setLevel(level: number): void;
  leave(): void;
  destroy(): void;
}

const NS = "http://www.w3.org/2000/svg";
const INK = "#1f2a3d";
const NAME_FAMILY = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const FIG_W = 48;
const CX = 56;
const TOP = 6;

/** 形象缩到 48 宽怎么摆：胶囊上沿以上露出多高（visH），开口（cut）和胶囊上沿（capTop）在哪。 */
function stage(art: MilesFigure["art"]) {
  const scale = FIG_W / art.figureWidth;
  const visH = (art.lipY - art.topY) * scale;
  const cut = TOP + visH;
  return { scale, visH, cut, capTop: cut - 2 };
}

/** 整块在页面上占的高度：上面是探出来的半身，下面是胶囊（小号 66，页头那颗 72；宽就是胶囊宽）。 */
export function milesBoxHeight(size: MilesCapsuleSize, art: MilesFigure["art"]): number {
  return Math.ceil(stage(art).capTop + CAPSULES[size].h - TOP);
}
const HAND_DOWN = "translate(-10px, 340px) rotate(-18deg)";
const GLANCES: [number, number, number][] = [[-1.6, 0, -1.5], [1.6, 0, 1.5], [-1.2, -0.7, -1.2], [1.2, -0.6, 1.2], [0, 0.8, 0]];
/** 在听时目光的落点（一格 = 画的 gazeUnit），和样式表里 data-pose='listening' 的那一档一致。 */
const LISTEN_GAZE: [number, number] = [1, 0];

const WAVE_COLORS = ["255, 170, 214", "196, 176, 255", "150, 205, 255", "150, 228, 204", "255, 206, 164"];
/** 胶囊小，横向取样按宽度收窄（产品那颗是 ±11），平时的底子高一点。 */
const WAVE_SPAN = 5;
const WAVE_FLOOR = 0.42;

const attenuate = (x: number) => Math.pow(4 / (4 + x * x), 4);

/** 名字的字形有多宽时胶囊多宽：小号最窄 70，放不下时两侧各留 10，最宽 96；页头那颗见 CAPSULES。 */
export function milesCapsuleWidth(inkWidth: number, size: MilesCapsuleSize = "small"): number {
  const cap = CAPSULES[size];
  return Math.min(cap.maxW, Math.max(cap.minW, Math.ceil(inkWidth + 2 * cap.pad)));
}

interface Lobe { amp: number; target: number; offset: number; width: number; speed: number; phase: number; life: number; age: number }

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  parent?.appendChild(node);
  return node;
}

/** 两头整圆的跑道形。 */
function stadium(cx: number, cy: number, w: number, h: number): string {
  const r = h / 2;
  return `M${cx - w / 2 + r},${cy - h / 2} H${cx + w / 2 - r} A${r},${r} 0 0 1 ${cx + w / 2 - r},${cy + h / 2} H${cx - w / 2 + r} A${r},${r} 0 0 1 ${cx - w / 2 + r},${cy - h / 2} Z`;
}

/** 在部件外面套一层再动，不碰画里原有的 transform。 */
function wrap(node: Element, className: string, pivot?: number[]): SVGGElement {
  const g = document.createElementNS(NS, "g");
  if (className) g.setAttribute("class", className);
  g.style.transformBox = "view-box";
  if (pivot) g.style.transformOrigin = `${pivot[0]}px ${pivot[1]}px`;
  node.parentNode?.insertBefore(g, node);
  g.appendChild(node);
  return g;
}

function pivotOf(node: Element): number[] {
  return (node.getAttribute("data-pivot") ?? "0 0").split(/[ ,]+/).map(Number);
}

export function mountMiles(svg: SVGSVGElement, { figure, idPrefix, classes, name: initialName, pose: initialPose, reduced, size = "small" }: {
  /** 挂哪一种形象（Miles、C妹）。 */
  figure: MilesFigure;
  idPrefix: string;
  name: string;
  classes: MilesClasses;
  pose: MilesPose;
  reduced: boolean;
  /** 胶囊哪一档：页头那颗（header）名字和对话正文一样大。 */
  size?: MilesCapsuleSize;
}): MilesRig {
  const id = (name: string) => `${idPrefix}-${name}`;
  const { scale, visH, cut, capTop } = stage(figure.art);
  const cap = CAPSULES[size];
  const capCy = capTop + cap.h / 2;
  // 页头那颗用页面的字体（和对话正文同一套），小号照旧。
  const nameFont = `400 ${cap.font}px ${size === "header" ? getComputedStyle(svg).fontFamily || NAME_FAMILY : NAME_FAMILY}`;
  /** 沉回去时要沉多深：整个人加上胶囊高度，确保一点不露。 */
  const sink = visH + cap.h + 4;
  let pose = initialPose;
  let out = false;
  let handUp = true;
  let mouthOpen = false;
  let inputLevel = 0;
  let level = 0;
  let target = 0;
  let syllable = 0;
  const timers = new Set<number>();
  const live = new Set<Animation>();

  const later = (fn: () => void, ms: number) => {
    const timer = window.setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
  };
  const play = (node: Element, frames: Keyframe[], options: KeyframeAnimationOptions) => {
    const keep = options.fill !== "none";
    const animation = node.animate(frames, { ...options, fill: keep ? "both" : "none" });
    live.add(animation);
    animation.finished.then(() => {
      live.delete(animation);
      if (keep) { try { animation.commitStyles(); } catch { /* 元素已经不在页面上 */ } animation.cancel(); }
    }, () => live.delete(animation));
    return animation;
  };
  const cancelOn = (...nodes: Element[]) => live.forEach((animation) => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    if (target && nodes.includes(target)) animation.cancel();
  });

  // ── 画 ──（跟着名字变的几样宽度在 setName 里摆）
  let width: number = cap.minW;
  svg.style.setProperty("--g", `${figure.art.gazeUnit}px`);
  const defs = el("defs", {}, svg);
  defs.innerHTML = `
    <linearGradient id="${id("glass")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.86"/><stop offset="1" stop-color="#eef2fa" stop-opacity="0.72"/></linearGradient>
    <linearGradient id="${id("tint")}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffd9ee"/><stop offset="0.28" stop-color="#e7ddff"/><stop offset="0.52" stop-color="#d6ecff"/><stop offset="0.76" stop-color="#d9f4ea"/><stop offset="1" stop-color="#ffead8"/></linearGradient>
    <linearGradient id="${id("speak")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dfe3ff" stop-opacity="0.8"/><stop offset="1" stop-color="#c3cdff" stop-opacity="0.95"/></linearGradient>
    <linearGradient id="${id("edge")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.95"/><stop offset="1" stop-color="#fff" stop-opacity="0.3"/></linearGradient>
    <radialGradient id="${id("sheen")}" cx="30%" cy="0%" r="60%"><stop offset="0" stop-color="#fff" stop-opacity="0.6"/><stop offset="0.72" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <radialGradient id="${id("air")}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#3d63ff" stop-opacity="0.85"/><stop offset="1" stop-color="#001eff" stop-opacity="0"/></radialGradient>
    <linearGradient id="${id("lip")}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`;
  el("clipPath", { id: id("above") }, svg).appendChild(el("rect", { x: -40, y: -60, width: 2 * CX + 80, height: capTop + 60.5 }));

  // 形象：只露出胶囊上沿以上的部分
  const rise = el("g", {}, el("g", { "clip-path": `url(#${id("above")})` }, svg));
  const squash = el("g", {}, rise);
  for (const node of [rise, squash]) { node.style.transformBox = "view-box"; node.style.transformOrigin = `${CX}px ${cut}px`; }
  const [vx, vy, vw, vh] = figure.art.viewBox.split(" ").map(Number);
  const art = el("svg", {
    viewBox: figure.art.viewBox,
    x: CX - (figure.art.torsoCx - vx) * scale,
    y: cut - (figure.art.lipY - vy) * scale,
    width: vw * scale,
    height: vh * scale,
    overflow: "visible",
  }, squash);
  art.innerHTML = figure.svg.replaceAll("{id}", idPrefix);
  const part = (name: string) => art.querySelector(`[data-part="${name}"]`) as SVGGraphicsElement;

  const head = part("head"), body = part("body"), arm = part("arm-peace");
  wrap(head, classes.headPose, pivotOf(head));
  const look = wrap(head, "", pivotOf(head));
  wrap(body, classes.breathe, pivotOf(body));
  const lift = wrap(arm, "", pivotOf(arm));
  const wiggle = wrap(arm, "", pivotOf(arm));
  const shell = (node: Element, origin: string) => { const g = wrap(node, ""); g.style.transformBox = "fill-box"; g.style.transformOrigin = origin; return g; };
  const eyes = [part("eye-l"), part("eye-r")];
  const closedEyes = [part("eye-l-closed"), part("eye-r-closed")];
  // 目光：画里有眼珠（iris-l、iris-r，套在眼眶的裁切里）时只移眼珠，眼眶留在原处；豆豆眼没有眼珠，整只眼睛跟着移。
  const irisL = art.querySelector('[data-part="iris-l"]'), irisR = art.querySelector('[data-part="iris-r"]');
  const gazes: SVGGElement[] = [];
  if (irisL && irisR) gazes.push(wrap(irisL, classes.gaze), wrap(irisR, classes.gaze));
  else {
    const gaze = document.createElementNS(NS, "g");
    gaze.setAttribute("class", classes.gaze);
    gaze.style.transformBox = "view-box";
    eyes[0].parentNode?.insertBefore(gaze, eyes[0]);
    [...eyes, ...closedEyes].forEach((node) => gaze.appendChild(node));
    gazes.push(gaze);
  }
  const eyeShells = eyes.map((node) => shell(node, "center"));
  const mouth = part("mouth"), mouthOpenPart = part("mouth-open");
  const mouthShell = shell(mouthOpenPart, "50% 20%");
  // 右耳的耳机：在听时跟着对方说话的声音亮
  const pod = part("airpod-r");
  const podBox = pod.getBBox();
  const airglow = el("g", { opacity: 0 });
  airglow.style.transition = "opacity 160ms linear";
  el("circle", { cx: podBox.x + podBox.width * 0.5, cy: podBox.y + podBox.height * 0.35, r: Math.max(podBox.width, podBox.height) * 1.2, fill: `url(#${id("air")})` }, airglow);
  pod.parentNode?.insertBefore(airglow, pod);

  // 胶囊玻璃
  const capShapes = [
    el("path", {}, el("clipPath", { id: id("cap") }, svg)),
    el("path", { fill: `url(#${id("glass")})` }, svg),
    el("path", { fill: `url(#${id("tint")})`, opacity: 0.5 }, svg),
  ];
  capShapes.push(el("path", { fill: `url(#${id("speak")})` }, el("g", { class: classes.speakGlass }, svg)));
  const soft = el("g", { style: "filter: blur(1.6px)" }, el("g", { "clip-path": `url(#${id("cap")})` }, svg));
  const wavePaths = WAVE_COLORS.map((color) => el("path", { fill: `rgba(${color}, 0.55)` }, soft));
  capShapes.push(el("path", { fill: `url(#${id("sheen")})` }, svg));
  const edge = el("path", { fill: "none", stroke: `url(#${id("edge")})`, "stroke-width": 1 }, svg);
  const rim = el("path", { fill: "none", stroke: "rgb(31 42 61 / 13%)", "stroke-width": 0.75 }, svg);

  const name = el("text", { fill: INK, style: `font: ${nameFont}` }, svg);

  // 开口那道亮线
  const lip = el("g", { opacity: 0.5 }, svg);
  const lipLine = el("path", { stroke: `url(#${id("lip")})`, "stroke-width": 1.5, fill: "none" }, lip);

  rise.style.transform = `translateY(${sink}px)`;

  // ── 流光 ──
  let seed = 20260924;
  const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const spawn = (lobe: Partial<Lobe> = {}): Lobe => Object.assign(lobe, {
    amp: 0, target: 0.35 + random() * 0.65, offset: -3 + random() * 6, width: 1 + random() * 2,
    speed: 0.5 + random() * 0.5, phase: random() * Math.PI * 2, life: 1.4 + random() * 2.4, age: 0,
  });
  const curves = WAVE_COLORS.map(() => Array.from({ length: 2 + Math.floor(random() * 3) }, () => {
    const lobe = spawn();
    lobe.amp = lobe.target * 0.7;
    lobe.age = random() * lobe.life;
    return lobe;
  }));
  let waveLevel = WAVE_FLOOR;
  const waveMid = capCy + cap.h * 0.27;
  const waveReach = cap.h * 0.34;
  const drawWave = () => {
    wavePaths.forEach((node, c) => {
      const lobes = curves[c];
      const top: string[] = [];
      const bottom: string[] = [];
      // 胶囊变宽时取样范围跟着放大，起伏的疏密不变
      const span = WAVE_SPAN * width / CAPSULES.small.minW;
      for (let px = 0; px <= width; px += 1) {
        const i = (px / width) * 2 * span - span;
        let y = 0;
        for (const lobe of lobes) { const x = i / lobe.width - lobe.offset; y += Math.abs(lobe.amp * Math.sin(x - lobe.phase) * attenuate(x)); }
        const h = Math.min(waveReach, waveReach * waveLevel * (y / Math.sqrt(lobes.length)) * 1.5);
        const x = (CX - width / 2 + px).toFixed(1);
        top.push(`${x},${(waveMid - h).toFixed(2)}`);
        bottom.unshift(`${x},${(waveMid + h).toFixed(2)}`);
      }
      node.setAttribute("d", `M${top.join(" L")} L${bottom.join(" L")} Z`);
    });
  };
  const stepWave = (dt: number) => {
    waveLevel += (WAVE_FLOOR + level * (1 - WAVE_FLOOR) - waveLevel) * Math.min(1, dt * 12);
    const pace = 1.1 + level * 1.6;
    for (const lobes of curves) for (const lobe of lobes) {
      lobe.age += dt;
      lobe.phase += lobe.speed * dt * pace;
      if (lobe.age > lobe.life) lobe.target = 0;
      lobe.amp += (lobe.target - lobe.amp) * Math.min(1, dt * 2.4);
      if (lobe.target === 0 && lobe.amp < 0.02) spawn(lobe);
    }
  };

  /** 写上名字，胶囊按它定宽；名字按字形本身横竖都居中（不按字体行高）。 */
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = nameFont;
  const setName = (text: string) => {
    const label = text.trim() || figure.name;
    name.textContent = label;
    const glyphs = measure.measureText(label);
    const ink = glyphs.actualBoundingBoxLeft + glyphs.actualBoundingBoxRight;
    width = milesCapsuleWidth(ink, size);
    const room = width - 2 * cap.pad;
    if (ink > room) {
      name.setAttribute("textLength", String(room));
      name.setAttribute("lengthAdjust", "spacingAndGlyphs");
      name.setAttribute("x", String(CX - room / 2));
    } else {
      name.removeAttribute("textLength");
      name.removeAttribute("lengthAdjust");
      name.setAttribute("x", String(CX - (glyphs.actualBoundingBoxRight - glyphs.actualBoundingBoxLeft) / 2));
    }
    name.setAttribute("y", String(capCy + (glyphs.actualBoundingBoxAscent - glyphs.actualBoundingBoxDescent) / 2));
    svg.setAttribute("viewBox", `${CX - width / 2} ${TOP} ${width} ${milesBoxHeight(size, figure.art)}`);
    const path = stadium(CX, capCy, width, cap.h);
    capShapes.forEach((node) => node.setAttribute("d", path));
    edge.setAttribute("d", stadium(CX, capCy, width - 1, cap.h - 1));
    rim.setAttribute("d", stadium(CX, capCy, width + 0.75, cap.h + 0.75));
    const half = width / 2 - cap.h / 2;
    lipLine.setAttribute("d", `M${CX - half},${capTop + 0.9} H${CX + half}`);
    drawWave();
    return width;
  };
  setName(initialName);
  let frame = 0;
  let last = 0;
  const loop = (now: number) => {
    stepWave(Math.min(0.05, (now - last) / 1000));
    last = now;
    drawWave();
    frame = requestAnimationFrame(loop);
  };
  const startWave = () => {
    cancelAnimationFrame(frame);
    if (reduced || document.visibilityState !== "visible") return;
    last = performance.now();
    frame = requestAnimationFrame(loop);
  };
  document.addEventListener("visibilitychange", startWave);

  // ── 嘴、声音 ──
  const show = (node: Element | null, on: boolean) => node?.setAttribute("display", on ? "inline" : "none");
  const talk = (k: number) => {
    // 有个回差：大于 0.18 张开，小于 0.08 才合上，免得在门槛上来回闪
    if (mouthOpen ? k < 0.08 : k > 0.18) mouthOpen = !mouthOpen;
    show(mouth, !mouthOpen);
    show(mouthOpenPart, mouthOpen);
    if (mouthOpen) mouthShell.style.transform = reduced ? "scale(1, 0.75)" : `scale(${0.92 + k * 0.1}, ${0.5 + k * 0.55})`;
  };
  // 在说：天枢这边没有说话的声音，按音节模拟；在听：用麦克风那条流的响度。起得快落得慢。
  const tick = () => {
    if (!out) target = 0;
    else if (pose === "speaking") {
      syllable -= 1;
      if (syllable <= 0) { syllable = 1 + Math.floor(random() * 3); target = random() < 0.16 ? 0 : 0.35 + random() * 0.65; }
    } else target = inputLevel;
    level += (target - level) * (target > level ? 0.6 : 0.25);
    const k = Math.max(0, Math.min(1, level));
    airglow.style.opacity = pose === "listening" && out ? String(0.2 + k * 0.7) : "0";
    talk(pose === "speaking" && out ? (reduced ? 0.6 : k) : 0);
  };
  const levelTimer = window.setInterval(tick, 90);

  // ── 小动作 ──
  const blink = (twice = false) => {
    if (reduced || !out) return;
    eyeShells.forEach((node) => play(node, [{ transform: "scaleY(1)" }, { transform: "scaleY(0.08)", offset: 0.45 }, { transform: "scaleY(1)" }], { duration: 150, easing: "ease-in-out", fill: "none" }));
    if (twice) later(() => blink(false), 230);
  };
  const glance = () => {
    if (reduced || !out || pose === "speaking") return;
    const [dx, dy, turn] = GLANCES[Math.floor(random() * GLANCES.length)];
    const hold = 900 + random() * 700;
    const at = (x: number, y: number) => `translate(calc(var(--g) * ${x}), calc(var(--g) * ${y}))`;
    const base = pose === "listening" ? at(...LISTEN_GAZE) : at(0, 0);
    const to = at(dx, dy);
    gazes.forEach((node) => play(node, [{ transform: base }, { transform: to, offset: 0.16 }, { transform: to, offset: 0.84 }, { transform: base }], { duration: hold + 380, easing: "ease-in-out", fill: "none" }));
    play(look, [{ transform: "rotate(0deg)" }, { transform: `rotate(${turn}deg)`, offset: 0.2 }, { transform: `rotate(${turn}deg)`, offset: 0.8 }, { transform: "rotate(0deg)" }], { duration: hold + 380, easing: "ease-in-out", fill: "none" });
  };
  const greet = () => {
    if (reduced || !out) return;
    play(wiggle, [{ transform: "rotate(0deg)" }, { transform: "rotate(-7deg)", offset: 0.35 }, { transform: "rotate(4deg)", offset: 0.7 }, { transform: "rotate(0deg)" }], { duration: 520, easing: "ease-in-out", fill: "none" });
  };
  const lowerHand = () => {
    if (reduced || !out || !handUp) return;
    handUp = false;
    play(lift, [{ transform: "translate(0px, 0px) rotate(0deg)" }, { transform: HAND_DOWN }], { duration: 420, easing: "cubic-bezier(.5,0,.75,0)" });
  };
  const raiseHand = () => {
    if (reduced || !out || handUp) return;
    handUp = true;
    play(lift, [{ transform: HAND_DOWN }, { transform: "translate(0px, -14px) rotate(3deg)", offset: 0.72 }, { transform: "translate(0px, 0px) rotate(0deg)" }], { duration: 480, easing: "cubic-bezier(.2,.8,.3,1)" });
  };
  const loops = () => {
    const blinks = () => later(() => { blink(random() < 0.2); blinks(); }, pose === "speaking" ? 3000 + random() * 3000 : 5000 + random() * 3000);
    const glances = () => later(() => { glance(); glances(); }, 3000 + random() * 2000);
    const hands = () => later(() => { if (handUp) lowerHand(); else raiseHand(); hands(); }, handUp ? 9000 + random() * 7000 : 5000 + random() * 5000);
    blinks();
    glances();
    hands();
  };

  // ── 出来 ──
  const enter = () => {
    out = true;
    if (reduced) {
      rise.style.transform = "translateY(0px)";
      lip.style.opacity = "1";
      return;
    }
    play(lip, [{ opacity: 0.5 }, { opacity: 1 }], { duration: 120, easing: "ease-out" });
    play(rise, [
      { transform: `translateY(${sink}px)`, easing: "cubic-bezier(.2,.8,.3,1)" },
      { transform: "translateY(-2px)", offset: 0.75, easing: "ease-in-out" },
      { transform: "translateY(0px)" },
    ], { duration: 500, delay: 100, easing: "linear" });
    play(squash, [{ transform: "scale(.98,1.02)", easing: "ease-out" }, { transform: "scale(1,1)", offset: 0.75 }, { transform: "scale(1,1)" }], { duration: 500, delay: 100, easing: "linear" });
    later(() => { loops(); blink(); }, 600 + 380);
    later(greet, 600 + 700);
  };
  // 和胶囊一起凝出来（capsuleIn）：胶囊先出现一点，Miles 再从里面升上来
  later(enter, reduced ? 0 : 180);
  startWave();

  return {
    setName,
    setPose(next) {
      if (next === pose) return;
      pose = next;
      cancelOn(...gazes, look);
    },
    setLevel(next) {
      inputLevel = Math.max(0, Math.min(1, next));
    },
    leave() {
      if (!out) return;
      out = false;
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
      cancelOn(...gazes, look, wiggle);
      if (reduced) { rise.style.transform = `translateY(${sink}px)`; return; }
      play(rise, [{ transform: "translateY(0px)" }, { transform: `translateY(${sink}px)` }], { duration: 260, easing: "cubic-bezier(.4,0,1,1)" });
      play(lip, [{ opacity: 1 }, { opacity: 0.5 }], { duration: 250 });
    },
    destroy() {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
      window.clearInterval(levelTimer);
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", startWave);
      live.forEach((animation) => animation.cancel());
      svg.replaceChildren();
    },
  };
}
