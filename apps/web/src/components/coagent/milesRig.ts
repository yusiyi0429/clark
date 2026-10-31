/**
 * Miles 那颗胶囊的画和动作（components/coagent/MilesCapsule 用）：胶囊原样不动，它平直的上沿就是开口，
 * 光从这里往上透，Miles 从这里探出上半身。照 2026-10-31 定稿的原型搬过来，只留产品里用得到的两种姿势。
 *
 * - 胶囊：品牌那颗的配方（#0011fd → #0600a6（46%）→ 底部透明，整体调淡），细亮边、顶上偏左一道高光，
 *   名字下面一道 Siri 流光（洋红、天青、蓝紫三道，跟着声音变高变快）；在说时换深的那组。
 * - 出场：从胶囊里升上来约 0.5 秒，带 2px 回弹；退场沉回去约 0.26 秒。
 * - 平时：随机眨眼、偶尔转头看一眼；比耶的手举 9–16 秒就放进胶囊里歇 5–10 秒。
 * - 在听：头微微侧过来、目光朝向说话的人，耳机跟着声音亮；在说：嘴跟着音节开合。
 *
 * 动画用 WAAPI，跑完把终态写回元素再撤掉；减少动效时直接摆好终态，只剩名字和流光的静帧。
 */

import { MILES_ART, MILES_SVG } from "./milesArt";

export type MilesPose = "listening" | "speaking";

/** 胶囊上的字。 */
const MILES_NAME = "Miles";
/** 整块在页面上占的高度：上面是 Miles 的半身，下面是 70×22 的胶囊（宽就是胶囊宽）。 */
const BOX_HEIGHT = 66;

/** 样式表里给动画层的几个类（coagent-miles.module.css）。 */
export interface MilesClasses {
  headPose: string;
  gaze: string;
  breathe: string;
  breath: string;
  speakGlass: string;
}

export interface MilesRig {
  setPose(pose: MilesPose): void;
  /** 0–1：在听时对方说话的响度。 */
  setLevel(level: number): void;
  leave(): void;
  destroy(): void;
}

const NS = "http://www.w3.org/2000/svg";
const NAME_FONT = '400 10px system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const CAP = { w: 70, h: 22 };
const FIG_W = 48;
const SCALE = FIG_W / MILES_ART.figureWidth;
const VIS_H = (MILES_ART.lipY - MILES_ART.topY) * SCALE;
const CX = 56;
const TOP = 6;
const CUT = TOP + VIS_H;
const CAP_TOP = CUT - 2;
const CAP_CY = CAP_TOP + CAP.h / 2;
/** 沉回去时要沉多深：整个人加上胶囊高度，确保一点不露。 */
const SINK = VIS_H + CAP.h + 4;
const HAND_DOWN = "translate(-10px, 340px) rotate(-18deg)";
const GLANCES: [number, number, number][] = [[-1.6, 0, -1.5], [1.6, 0, 1.5], [-1.2, -0.7, -1.2], [1.2, -0.6, 1.2], [0, 0.8, 0]];
/** 在听时目光的落点（一格 = MILES_ART.gazeUnit），和样式表里 data-pose='listening' 的那一档一致。 */
const LISTEN_GAZE: [number, number] = [1, 0];

const WAVE_COLORS = ["255, 104, 198", "98, 226, 255", "132, 108, 255"];
/** 胶囊小，横向取样按宽度收窄（产品那颗是 ±11），平时的底光略高一点。 */
const WAVE_SPAN = 5;
const WAVE_FLOOR = 0.22;

const attenuate = (x: number) => Math.pow(4 / (4 + x * x), 4);

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

export function mountMiles(svg: SVGSVGElement, { idPrefix, classes, pose: initialPose, reduced }: {
  idPrefix: string;
  classes: MilesClasses;
  pose: MilesPose;
  reduced: boolean;
}): MilesRig {
  const id = (name: string) => `${idPrefix}-${name}`;
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

  // ── 画 ──
  svg.setAttribute("viewBox", `${CX - CAP.w / 2} ${TOP} ${CAP.w} ${BOX_HEIGHT}`);
  svg.style.setProperty("--g", `${MILES_ART.gazeUnit}px`);
  const defs = el("defs", {}, svg);
  defs.innerHTML = `
    <linearGradient id="${id("glass")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0011fd" stop-opacity="0.78"/><stop offset="0.46" stop-color="#0600a6" stop-opacity="0.72"/><stop offset="1" stop-color="#001eff" stop-opacity="0"/></linearGradient>
    <linearGradient id="${id("speak")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0011fd"/><stop offset="0.4" stop-color="#0600a6"/><stop offset="1" stop-color="#07058e"/></linearGradient>
    <radialGradient id="${id("speak-glow")}" cx="50%" cy="100%" r="70%"><stop offset="0" stop-color="#001eff" stop-opacity="0.6"/><stop offset="1" stop-color="#001eff" stop-opacity="0"/></radialGradient>
    <linearGradient id="${id("edge")}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.2"/><stop offset="1" stop-color="#fff" stop-opacity="0.75"/></linearGradient>
    <radialGradient id="${id("sheen")}" cx="30%" cy="0%" r="60%"><stop offset="0" stop-color="#fff" stop-opacity="0.26"/><stop offset="0.72" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <radialGradient id="${id("bloom")}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#001eff" stop-opacity="0.46"/><stop offset="0.72" stop-color="#001eff" stop-opacity="0"/></radialGradient>
    <radialGradient id="${id("shadow")}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#0011fd" stop-opacity="0.16"/><stop offset="1" stop-color="#0011fd" stop-opacity="0"/></radialGradient>
    <radialGradient id="${id("air")}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#3d63ff" stop-opacity="0.85"/><stop offset="1" stop-color="#001eff" stop-opacity="0"/></radialGradient>
    <linearGradient id="${id("lip")}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.95"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>`;
  el("ellipse", { cx: CX, cy: CAP_CY + CAP.h * 0.42, rx: CAP.w * 0.46, ry: CAP.h * 0.38, fill: `url(#${id("shadow")})` }, svg);
  el("clipPath", { id: id("above") }, svg).appendChild(el("rect", { x: -40, y: -60, width: 2 * CX + 80, height: CAP_TOP + 60.5 }));

  // 胶囊上沿往上透的一团蓝光
  const bloom = el("g", { opacity: 0, "clip-path": `url(#${id("above")})` }, svg);
  bloom.style.transformBox = "view-box";
  bloom.style.transformOrigin = `${CX}px ${CAP_TOP}px`;
  const bloomLevel = el("g", {}, bloom);
  bloomLevel.style.transition = "opacity 160ms linear";
  el("ellipse", { class: classes.breath, cx: CX, cy: CAP_TOP, rx: Math.max(CAP.w * 0.42, FIG_W * 0.62), ry: VIS_H * 0.78, fill: `url(#${id("bloom")})` }, bloomLevel);

  // Miles：只露出胶囊上沿以上的部分
  const rise = el("g", {}, el("g", { "clip-path": `url(#${id("above")})` }, svg));
  const squash = el("g", {}, rise);
  for (const node of [rise, squash]) { node.style.transformBox = "view-box"; node.style.transformOrigin = `${CX}px ${CUT}px`; }
  const [vx, vy, vw, vh] = MILES_ART.viewBox.split(" ").map(Number);
  const art = el("svg", {
    viewBox: MILES_ART.viewBox,
    x: CX - (MILES_ART.torsoCx - vx) * SCALE,
    y: CUT - (MILES_ART.lipY - vy) * SCALE,
    width: vw * SCALE,
    height: vh * SCALE,
    overflow: "visible",
  }, squash);
  art.innerHTML = MILES_SVG.replaceAll("{id}", idPrefix);
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
  const gaze = document.createElementNS(NS, "g");
  gaze.setAttribute("class", classes.gaze);
  gaze.style.transformBox = "view-box";
  eyes[0].parentNode?.insertBefore(gaze, eyes[0]);
  [...eyes, ...closedEyes].forEach((node) => gaze.appendChild(node));
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
  const path = stadium(CX, CAP_CY, CAP.w, CAP.h);
  el("clipPath", { id: id("cap") }, svg).appendChild(el("path", { d: path }));
  el("path", { d: path, fill: `url(#${id("glass")})` }, svg);
  const speak = el("g", { class: classes.speakGlass }, svg);
  el("path", { d: path, fill: `url(#${id("speak")})` }, speak);
  el("path", { d: path, fill: `url(#${id("speak-glow")})` }, speak);
  const glow = el("g", { style: "mix-blend-mode:screen; filter: blur(0.4px) drop-shadow(0 0 4px rgb(200 225 255 / 40%))" }, el("g", { "clip-path": `url(#${id("cap")})` }, svg));
  const wavePaths = WAVE_COLORS.map((color) => el("path", { fill: `rgba(${color}, 0.78)`, style: "mix-blend-mode:screen" }, glow));
  el("path", { d: path, fill: `url(#${id("sheen")})` }, svg);
  el("path", { d: stadium(CX, CAP_CY, CAP.w - 1, CAP.h - 1), fill: "none", stroke: `url(#${id("edge")})`, "stroke-width": 1 }, svg);

  // 名字：按字形本身横竖都居中（不按字体行高）
  const name = el("text", { fill: "#fff", style: `font: ${NAME_FONT}` }, svg);
  name.textContent = MILES_NAME;
  const context = document.createElement("canvas").getContext("2d")!;
  context.font = NAME_FONT;
  const glyphs = context.measureText(MILES_NAME);
  name.setAttribute("x", String(CX - (glyphs.actualBoundingBoxRight - glyphs.actualBoundingBoxLeft) / 2));
  name.setAttribute("y", String(CAP_CY + (glyphs.actualBoundingBoxAscent - glyphs.actualBoundingBoxDescent) / 2));

  // 开口那道亮线
  const half = CAP.w / 2 - CAP.h / 2;
  const lip = el("g", { opacity: 0.5 }, svg);
  el("path", { d: `M${CX - half},${CAP_TOP + 0.9} H${CX + half}`, stroke: `url(#${id("lip")})`, "stroke-width": 1.5, fill: "none" }, lip);

  rise.style.transform = `translateY(${SINK}px)`;

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
  const waveMid = CAP_CY + CAP.h * 0.27;
  const waveReach = CAP.h * 0.34;
  const drawWave = () => {
    wavePaths.forEach((node, c) => {
      const lobes = curves[c];
      const top: string[] = [];
      const bottom: string[] = [];
      for (let px = 0; px <= CAP.w; px += 1) {
        const i = (px / CAP.w) * 2 * WAVE_SPAN - WAVE_SPAN;
        let y = 0;
        for (const lobe of lobes) { const x = i / lobe.width - lobe.offset; y += Math.abs(lobe.amp * Math.sin(x - lobe.phase) * attenuate(x)); }
        const h = Math.min(waveReach, waveReach * waveLevel * (y / Math.sqrt(lobes.length)) * 1.5);
        const x = (CX - CAP.w / 2 + px).toFixed(1);
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
  drawWave();
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
    bloomLevel.style.opacity = String(Math.min(1, (pose === "speaking" ? 0.7 : 0.65) + k * 0.3));
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
    if (reduced || !out || pose !== "listening") return;
    const [dx, dy, turn] = GLANCES[Math.floor(random() * GLANCES.length)];
    const hold = 900 + random() * 700;
    const at = (x: number, y: number) => `translate(calc(var(--g) * ${x}), calc(var(--g) * ${y}))`;
    const base = at(...LISTEN_GAZE);
    const to = at(dx, dy);
    play(gaze, [{ transform: base }, { transform: to, offset: 0.16 }, { transform: to, offset: 0.84 }, { transform: base }], { duration: hold + 380, easing: "ease-in-out", fill: "none" });
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
    const blinks = () => later(() => { blink(random() < 0.2); blinks(); }, pose === "listening" ? 5000 + random() * 3000 : 3000 + random() * 3000);
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
      bloom.style.opacity = "1";
      lip.style.opacity = "1";
      return;
    }
    play(lip, [{ opacity: 0.5 }, { opacity: 1 }], { duration: 120, easing: "ease-out" });
    play(bloom, [{ opacity: 0, transform: "scaleY(.5)" }, { opacity: 1, transform: "scaleY(1)" }], { duration: 360, delay: 60, easing: "cubic-bezier(.2,.8,.2,1)" });
    play(rise, [
      { transform: `translateY(${SINK}px)`, easing: "cubic-bezier(.2,.8,.3,1)" },
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
    setPose(next) {
      if (next === pose) return;
      pose = next;
      cancelOn(gaze, look);
    },
    setLevel(next) {
      inputLevel = Math.max(0, Math.min(1, next));
    },
    leave() {
      if (!out) return;
      out = false;
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
      cancelOn(gaze, look, wiggle);
      if (reduced) { rise.style.transform = `translateY(${SINK}px)`; return; }
      play(rise, [{ transform: "translateY(0px)" }, { transform: `translateY(${SINK}px)` }], { duration: 260, easing: "cubic-bezier(.4,0,1,1)" });
      play(bloom, [{ opacity: 1 }, { opacity: 0 }], { duration: 250, easing: "ease-in" });
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
