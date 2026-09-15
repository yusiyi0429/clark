/**
 * 视觉验收 —— 用 CDP 打开真页面，读**计算后**的样式。
 *
 * 为什么不用静态 grep：这一版的分隔线是 `.row + .row::before`（相邻兄弟 + 伪元素），
 * 而清单是客户端取数之后才渲染的。源码里看得见 class，服务端 HTML 里一行都没有，
 * 只有真浏览器跑完 JS 才知道那条线到底画没画出来。
 *
 * 用法：node scripts/verify-visual.mjs <baseUrl> <cookie> [cdpPort]
 */

const [, , base = "http://localhost:3112", cookie = "", port = "9333"] = process.argv;

const ws = await fetch(`http://localhost:${port}/json/new?about:blank`, {
  method: "PUT",
}).then((r) => r.json());


/* 没有 ws 库，直接用 CDP 的 HTTP + WebSocket。Node 22 自带 WebSocket。 */
const sock = new WebSocket(ws.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

sock.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
});

await new Promise((res) => sock.addEventListener("open", res));

const send = (method, params = {}) =>
  new Promise((res) => {
    const n = ++id;
    pending.set(n, res);
    sock.send(JSON.stringify({ id: n, method, params }));
  });

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  return r?.result?.value;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");

if (cookie) {
  const [name, value] = cookie.split("=");
  const u = new URL(base);
  await send("Network.setCookie", { name, value, domain: u.hostname, path: "/" });
}

const goto = async (path) => {
  await send("Page.navigate", { url: `${base}${path}` });
  /*
   * 等清单真的出现 —— 取数是客户端的，load 事件早于数据到手。
   *
   * 这里错过两次，都值得记下来：
   *
   * 1. 只等 `.row` 出现：主页和文档库本来就没有行，每页白等 8 秒超时。
   * 2. 改成等「骨架屏归零」：**更糟，因为它会假成功。** 导航刚开始时 React 还没
   *    水合，`.skeleton` 本来就是 0 —— 判据当场满足，脚本在空页面上跑完全部检查，
   *    报一片 PASS。第一版就这么把 6 个路由验成了「全部通过」，而那几页当时
   *    根本还没渲染（rows=0 是唯一的破绽）。
   *
   * 现在要求**先见到骨架屏，再见到它消失**：见过骨架屏才证明水合发生过，
   * 消失才证明数据到手。没有骨架屏的页面（纯静态）用 DOM 节点数稳定兜底。
   */
  await evaluate(`new Promise((res) => {
    const t0 = Date.now();
    let sawSkeleton = false;
    let lastCount = -1, stable = 0;
    const tick = () => {
      const n = document.querySelectorAll('.skeleton').length;
      if (n > 0) sawSkeleton = true;
      const nodes = document.querySelectorAll('*').length;
      if (nodes === lastCount) stable++; else { stable = 0; lastCount = nodes; }
      const done = sawSkeleton ? n === 0 && stable >= 2 : stable >= 5;
      if (done || Date.now() - t0 > 10000) return res({ sawSkeleton, nodes });
      setTimeout(tick, 120);
    };
    tick();
  })`);
};

/*
 * 只验浅色。
 *
 * 深色这一套在这一版是**休眠**的：`.dark` 是 class 变体，而
 * `app/layout.tsx` 里那段会加 class 的首屏脚本随口述模式一起封存了（见那里的注释），
 * 产品代码里也没有一处 `dark:`（只有四个未启用的 shadcn 基件带着）。
 *
 * 试过用脚本强行 `classList.add('dark')` 来验，结论不可用：token 会翻，但组件里
 * 那些走 Tailwind 任意值、直接读浅色变量的地方不会跟着翻，量出来的是一个**产品里
 * 不存在的中间态**（深纸上压着浅面、浅面上压着浅字）。拿这种状态报出来的
 * 「27 处对比度不足」既不是真缺陷，也没法修 —— 修的是一个不会渲染的界面。
 *
 * 深色重启（语音交互回来）时，把它加进 SCHEMES，会得到一批真实结论；
 * 现在写死浅色，是让验收只声称它真的验过的东西。
 */
const SCHEMES = ["light"];

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
};

/* ---------- 1. 中性轴：token 的实际计算值 ---------- */
const readTokens = () => evaluate(`(() => {
  const s = getComputedStyle(document.documentElement);
  const names = ['--paper','--surface','--ink','--ink-muted','--ink-faint','--rule','--solid','--solid-fg'];
  const out = {};
  for (const n of names) out[n] = s.getPropertyValue(n).trim();
  return out;
})()`);

/* sRGB -> OKLCH，验色相与彩度 */
const toOklch = (hex) => {
  const h = hex.replace("#", "");
  const f = (i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = [f(0), f(2), f(4)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C: Math.hypot(A, B), H };
};

const checkTokens = (tokens, scheme) => {
  console.log(`\n=== 计算后的中性色 token（${scheme}）===`);
  console.log(JSON.stringify(tokens, null, 2));
  const bad = [];
  for (const [k, v] of Object.entries(tokens)) {
    if (!v.startsWith("#")) continue;
    const { C, H } = toOklch(v);
    if (C > 0.0085) bad.push(`${k} C=${C.toFixed(4)}`);
    /* 彩度极低时色相无意义，只对能看出颜色的检查轴 */
    if (C > 0.004 && Math.abs(H - 286.3) > 1.5) bad.push(`${k} H=${H.toFixed(1)}`);
  }
  check(
    `[${scheme}] 中性色全部落在 H=286.3°、C≤0.008`,
    bad.length === 0,
    bad.length ? bad.join("; ") : `${Object.keys(tokens).length} 个 token 全部合规`
  );
};

/* ---------- 2. 分隔线真的画出来了 ---------- */
const readSep = () => evaluate(`(() => {
  const rows = [...document.querySelectorAll('.row')];
  if (rows.length < 2) {
    /* 「渲染了没有」用主内容区的正文长度判：顶栏那几个字（TKOS / 返回主页 /
       文档库）在空白页上也有，所以不能拿整个 body 算。 */
    const main = document.querySelector('main') ?? document.body;
    const bodyLen = main.innerText.replace(/\\s+/g, '').length;
    return { rows: rows.length, err: '行数不足，无法验相邻兄弟', hydrated: bodyLen > 20, bodyLen };
  }
  const second = rows[1];
  const cs = getComputedStyle(second, '::before');
  return {
    rows: rows.length,
    height: cs.height,
    background: cs.backgroundColor,
    left: cs.left,
    content: cs.content,
    /* --row-pad 的**声明值**是 .875rem，而 ::before 的 left 是**计算值** 14px。
       直接比字符串永远不等。丢一个探针元素进去，让浏览器自己把 rem 换成 px。 */
    rowPad: (() => {
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--row-pad)';
      second.appendChild(probe);
      const w = getComputedStyle(probe).width;
      probe.remove();
      return w;
    })(),
  };
})()`);

const checkSep = async (sep, tag) => {
  /*
   * rows=0 要分清两件完全不同的事，否则报告会骗人（两个方向都试过了）：
   *
   * - **页面没渲染**：那一页的其余检查全是在空 DOM 上跑的，PASS 毫无意义。必须失败。
   * - **页面渲染了，但确实没有行**：种子数据里 `/decisions`、`/issues-log`、
   *   `/archive` 都是 0 条（「现在没有要确认的决定」），`/signals` 用的是卡片不是行。
   *   这种情况判失败是在骂一个正确的空态。
   *
   * 判据不能是「这条路由该不该有行」（我按这个写过一版，结果把四个正确的空态判成
   * 渲染失败）。判据是**页面到底渲染了没有** —— `sep.hydrated` 直接问这件事。
   */
  if (sep?.err) {
    if (!sep.hydrated) {
      check(
        `[${tag}] 行间发丝线真的渲染（::before 有高度和颜色）`,
        false,
        `页面没有渲染出内容（rows=0、正文 ${sep.bodyLen} 字），本页其余检查不可信`
      );
      return;
    }
    console.log(`SKIP  [${tag}] 行间发丝线：这一页渲染正常但没有行（空态或用卡片，rows=0）`);
    return;
  }

  check(
    `[${tag}] 行间发丝线真的渲染（::before 有高度和颜色）`,
    !!sep && sep.height !== "auto" && parseFloat(sep.height) > 0 &&
      sep.background !== "rgba(0, 0, 0, 0)",
    `rows=${sep?.rows} height=${sep?.height} bg=${sep?.background} left=${sep?.left}`
  );

  /* 发丝线必须是一个物理像素：CSS 高度 × dpr ≈ 1 */
  const dprInfo = await evaluate(`({ dpr: devicePixelRatio, hw: getComputedStyle(document.documentElement).getPropertyValue('--hairline-w').trim() })`);
  const physical = parseFloat(sep.height) * dprInfo.dpr;
  check(
    `[${tag}] 发丝线宽度按 dppx 分档（1 物理像素）`,
    Math.abs(physical - 1) < 0.35,
    `dpr=${dprInfo.dpr} --hairline-w=${dprInfo.hw} → 物理像素≈${physical.toFixed(2)}`
  );

  /* 分隔线从内容左沿起画，等于行自己的左内边距 */
  check(
    `[${tag}] 分隔线内缩量 = 行左内边距（separatorInset 规则）`,
    parseFloat(sep.left) === parseFloat(sep.rowPad),
    `::before left=${sep.left}，--row-pad=${sep.rowPad}`
  );
};

/* ---------- 3. 内容层零阴影 ---------- */
const readShadows = () => evaluate(`(() => {
  const bad = [];
  for (const el of document.querySelectorAll('.row, .card, .row *')) {
    const cs0 = getComputedStyle(el);
    /*
     * 规矩是「**内容层**不许有阴影」，不是「全站不许有阴影」——
     * 浮层（tooltip、下拉、浮动胶囊）那一档本来就允许，它们靠 absolute/fixed
     * 脱离文档流。按 class 选元素会把这两类混在一起：主页那颗会前提示挂在
     * .row 里面，但它是 absolute 的悬浮提示，不是内容。
     *
     * 判据取「是否在正常流里」，因为这正是两层的定义差别。
     */
    if (cs0.position === 'absolute' || cs0.position === 'fixed') continue;

    const bs = cs0.boxShadow;
    if (bs && bs !== 'none') {
      /* .card 自己那圈发丝线环是允许的：spread 环，没有模糊也没有偏移。
         颜色函数不能只认 rgb()：发丝线是 color-mix(in oklab,…) 算出来的，
         Chrome 把它序列化成 oklab(L a b / α)，写死 rgba? 会把合法的环判成阴影。 */
      const isHairlineRing = /^[a-z]+\\([^)]*\\) 0px 0px 0px [0-9.]+px$/.test(bs.trim());
      const isInsetRing = bs.includes('inset');
      if (!isHairlineRing && !isInsetRing) bad.push(el.className.toString().slice(0, 60) + ' => ' + bs.slice(0, 70));
    }
  }
  return bad;
})()`);

/* ---------- 4. 文字对比度 ---------- */
const readContrast = () => evaluate(`(() => {
  /*
   * 颜色一律交给浏览器解析，不自己认字符串。
   *
   * 两个坑，上一版都踩了：
   * 1. 这套设计里的颜色大量是 color-mix(in oklab,…)，Chrome 序列化成
   *    \\\`oklab(L a b / α)\\\`。按 rgb() 抓三个数字，抓到的是 0.99 / 0.0004 / -0.001，
   *    再当成 0–255 通道算亮度 —— 结论纯属噪声（顶栏的 TKOS 因此报成 1.17:1）。
   * 2. 半透明底色必须先合成。\\\`.floating\\\` 是 72% 的面，底下还有纸白；
   *    拿 72% 那层自己当背景算对比度，算的是一块不存在的颜色。
   *
   * 1×1 画布把两件事一次解决：颜色由 canvas 解析（认所有色彩空间），
   * 半透明层按 source-over 真的叠一遍，读回来的就是屏幕上那个像素。
   */
  const cvs = document.createElement('canvas');
  cvs.width = cvs.height = 1;
  const ctx = cvs.getContext('2d');

  const paint = (colors) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.globalCompositeOperation = 'source-over';
    for (const c of colors) { ctx.fillStyle = c; ctx.fillRect(0, 0, 1, 1); }
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };

  const lum = ([r, g, b]) => {
    const f = (c) => { c /= 255; return c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
    return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b);
  };

  /* 从元素往上收集背景层，收到第一个不透明的就停，然后自下而上叠。 */
  const bgStack = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (!bg) continue;
      const [, , , a] = paint([bg]);
      if (a === 0) continue;
      layers.unshift(bg);
      if (a === 1) return layers;
    }
    /* 走到根还没遇到不透明层：垫上画布本身的白。 */
    layers.unshift('#fff');
    return layers;
  };

  const out = [];
  for (const el of document.querySelectorAll('.meta, p, span, h1, h2, h3, a, button, li, td, th')) {
    if (!el.textContent.trim() || el.children.length > 0) continue;
    const cs = getComputedStyle(el);
    /* 看不见的东西不算：隐藏、透明、零尺寸（骨架屏和收起来的浮层都在这一档）。 */
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    if (!el.getClientRects().length) continue;

    const stack = bgStack(el);
    const bgPx = paint(stack);
    /* 字色本身可能半透明（比如 text-ink/60），要压在已合成的底色上再读。 */
    const fgPx = paint([...stack, cs.color]);
    const a = lum(fgPx), b = lum(bgPx);
    const cr = (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
    const px = parseFloat(cs.fontSize);
    const need = (px >= 18.66 || (px >= 14 && +cs.fontWeight >= 700)) ? 3.0 : 4.5;
    if (cr < need) out.push({
      text: el.textContent.trim().slice(0,22),
      fg: cs.color, bg: stack.join(' over '),
      cr: +cr.toFixed(2), need, px,
    });
  }
  return out;
})()`);

/* ---------- 5. chrome 的几何 ---------- */

/*
 * 顶栏高度必须是 64px，装饰层必须脱离文档流。
 *
 * 加这一条是因为前四项**一条都没拦住**一个肉眼一秒就能看见的 bug：
 * `.scroll-edge` 的主定义整个缺失（只有三处媒体查询在覆盖一个没定义过的类），
 * 于是那个 88px 高的装饰 div 留在正常流里，把顶栏胶囊往下顶了 88px。
 *
 * 颜色对、发丝线对、对比度对 —— 东西全在错的位置上。**验收只验了「长什么样」，
 * 没验「在哪儿」。**
 *
 * 64 是个有下游的数字：各页面里的 `calc(100vh-4rem)` 都按它算。
 * 装饰层则必须 absolute/fixed —— 它一旦回到正常流就会推走真正的内容。
 */
const readChrome = () => evaluate(`(() => {
  const h = document.querySelector('header');
  if (!h) return { err: '找不到 header' };
  const deco = [...document.querySelectorAll('.scroll-edge')].map((el) => ({
    cls: el.className,
    position: getComputedStyle(el).position,
    height: +el.getBoundingClientRect().height.toFixed(1),
  }));
  return {
    headerH: +getComputedStyle(h).height.replace('px', ''),
    headerTop: +h.getBoundingClientRect().top.toFixed(1),
    deco,
  };
})()`);

const checkChrome = (c, tag) => {
  if (c?.err) return check(`[${tag}] chrome 几何`, false, c.err);

  check(
    `[${tag}] 顶栏高度 = 64px（各页 calc(100vh-4rem) 依赖它）`,
    c.headerH === 64,
    `header 实测 ${c.headerH}px、top=${c.headerTop}`
  );

  const inFlow = c.deco.filter((d) => d.position !== "absolute" && d.position !== "fixed");
  check(
    `[${tag}] 装饰层脱离文档流（否则会把内容顶下去）`,
    inFlow.length === 0,
    inFlow.length
      ? inFlow.map((d) => `${d.cls} position=${d.position} h=${d.height}px —— 留在正常流里`).join(" | ")
      : `${c.deco.length} 层装饰全部 absolute`
  );
};

/* ---------- 驱动：全部路由 × 两套配色 ---------- */

/*
 * 为什么要遍历全部路由，而不是只看一页：
 *
 * 第一版只验了 `/issues`，6/6 全过。铺开之后立刻在主页抓到两处真缺陷 ——
 * `text-factual/80` 压在常驻深底上只有 2.37:1，`--ink-faint` 在 wash 底上
 * 只有 4.17:1（它在纸上是过的，所以单页验收看不见）。
 *
 * 规律：**缺陷长在组合上，不长在 token 上。** 一个 token 单独看是合格的，
 * 换一块底就不是；只有把它实际出现的每一块底都走一遍才会露出来。
 */
const ROUTES = [
  "/",
  "/issues",
  "/decisions",
  "/signals",
  "/issues-log",
  "/signals-log",
  "/archive",
  "/docs",
];

for (const scheme of SCHEMES) {
  for (const path of ROUTES) {
    await goto(path);
    const tag = `${scheme} ${path}`;

    /* token 只跟配色有关，每套验一次就够 —— 在第一条路由上验。 */
    if (path === ROUTES[0]) checkTokens(await readTokens(), scheme);

    checkChrome(await readChrome(), tag);

    await checkSep(await readSep(), tag);

    const shadows = await readShadows();
    check(
      `[${tag}] 内容层没有真阴影（只允许发丝线环）`,
      shadows.length === 0,
      shadows.length ? shadows.join(" | ") : "0 处"
    );

    const contrast = await readContrast();
    if (contrast.length) {
      console.log(`\n=== [${tag}] 未达对比度下限的文字 ===`);
      console.log(JSON.stringify(contrast.slice(0, 12), null, 2));
    }
    check(
      `[${tag}] 可见文字全部达到 WCAG AA`,
      contrast.length === 0,
      contrast.length
        ? `${contrast.length} 处未达标（最低 ${Math.min(...contrast.map((c) => c.cr))}:1）`
        : "全部通过"
    );
  }
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log("\n未通过：");
  for (const f of failed) console.log(`  - ${f.name}\n    ${f.detail}`);
}
sock.close();
process.exit(failed.length ? 1 : 0);
