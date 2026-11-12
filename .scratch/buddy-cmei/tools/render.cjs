// 用 ../preview.html 截 ../renders/ 里的图（预览页自带动作代码和画，直接用 file:// 打开，不用开服务）。
// 先跑 build-preview.cjs，再跑：node .scratch/buddy-cmei/tools/render.cjs
// 依赖：Playwright（require("playwright")，用它自带的 Chromium）。
const path = require("path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "renders");
const PAGE = "file://" + path.join(ROOT, "preview.html");

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  // 减少动效：rig 直接摆好终态，截出来是稳定的一帧（在听：头侧 3.5°、目光朝向说话的人）
  const open = async (width, scale) => {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: scale, reducedMotion: "reduce", colorScheme: "light" });
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(PAGE);
    await page.waitForTimeout(600);
    return page;
  };

  // 产品里的大小：胶囊原大，1 倍屏和 3 倍屏
  for (const scale of [1, 3]) {
    const page = await open(600, scale);   // 两颗胶囊并排放得下
    await page.click("label:has(#zoom-1)");
    await page.waitForTimeout(300);
    await (await page.$("#live")).screenshot({ path: `${OUT}/product-${scale}x.png` });
    await page.close();
  }

  // 动作一览、大图、剪影
  let page = await open(1180, 1.5);
  await (await page.$("#motions")).screenshot({ path: `${OUT}/motions.jpg`, type: "jpeg", quality: 88 });
  await (await page.$("#bigpair")).screenshot({ path: `${OUT}/full-art.png` });
  await page.check("#hand-down");
  await page.waitForTimeout(100);
  await (await page.$("#bigpair")).screenshot({ path: `${OUT}/full-art-hand-down.png` });
  await page.uncheck("#hand-down");
  await page.check("#silhouette");
  await page.waitForTimeout(100);
  await (await page.$("#bigpair")).screenshot({ path: `${OUT}/silhouette.png` });
  await page.close();

  // 眼睛特写：C妹 放大 9 倍，摆出 milesRig 里转眼（只移眼珠）和眨眼（整只压扁）的几帧
  page = await open(1400, 1);
  await page.evaluate(async () => {
    const NS = "http://www.w3.org/2000/svg";
    const rig = makeRig(CMEI_ART, CMEI_SVG_SRC);
    const at = (x, y) => `translate(calc(var(--g) * ${x}), calc(var(--g) * ${y}))`;
    const STATES = [
      ["在说（目光居中）", "speaking", () => {}],
      ["在听", "listening", () => {}],
      ["往左看", "listening", (p) => { p.look.style.transform = "rotate(-1.5deg)"; p.gazes.forEach((n) => (n.style.transform = at(-1.6, 0))); }],
      ["往右看", "listening", (p) => { p.look.style.transform = "rotate(1.5deg)"; p.gazes.forEach((n) => (n.style.transform = at(1.6, 0))); }],
      ["左上", "listening", (p) => { p.look.style.transform = "rotate(-1.2deg)"; p.gazes.forEach((n) => (n.style.transform = at(-1.2, -0.7))); }],
      ["往下", "listening", (p) => { p.gazes.forEach((n) => (n.style.transform = at(0, 0.8))); }],
      ["眨眼一半", "listening", (p) => p.shells.forEach((s) => (s.style.transform = "scaleY(0.5)"))],
      ["往左看时眨眼", "listening", (p) => { p.look.style.transform = "rotate(-1.5deg)"; p.gazes.forEach((n) => (n.style.transform = at(-1.6, 0))); p.shells.forEach((s) => (s.style.transform = "scaleY(0.5)")); }],
    ];
    document.body.innerHTML = '<div id="eyes" style="display:grid;grid-template-columns:repeat(4,340px);gap:8px;padding:8px;background:#fff"></div>';
    const grid = document.getElementById("eyes");
    const cells = STATES.map(([title, pose, apply], i) => {
      const cell = document.createElement("div");
      cell.style.cssText = "position:relative;height:230px;overflow:hidden;border-radius:10px;background:linear-gradient(180deg,#e7efff 0%,#f3f7fd 100%)";
      cell.innerHTML = `<span style="position:absolute;left:8px;bottom:6px;z-index:2;background:#fffc;padding:1px 6px;border-radius:6px;font:600 13px -apple-system,'PingFang SC',sans-serif;color:#5d6878"></span><div style="position:absolute;left:-135px;top:-148px"><div class="miles" style="zoom:9;animation:none" data-pose="${pose}"></div></div>`;
      cell.querySelector("span").textContent = title;
      const box = cell.querySelector(".miles");
      const svg = document.createElementNS(NS, "svg");
      svg.setAttribute("class", "unit");
      box.appendChild(svg);
      grid.appendChild(cell);
      const r = rig.mountMiles(svg, { idPrefix: "e" + i, name: "C妹", pose, reduced: true, classes: { headPose: "headPose", gaze: "gaze", breathe: "breathe", speakGlass: "speakGlass" } });
      box.style.width = r.setName("C妹") + "px";
      return { svg, apply };
    });
    await new Promise((done) => setTimeout(done, 300));
    for (const { svg, apply } of cells) {
      const head = svg.querySelector('[data-part="head"]');
      apply({ look: head.parentNode, gazes: [...svg.querySelectorAll("g.gaze")], shells: ["eye-l", "eye-r"].map((n) => svg.querySelector(`[data-part="${n}"]`).parentNode) });
    }
  });
  await page.waitForTimeout(200);
  await (await page.$("#eyes")).screenshot({ path: `${OUT}/glance.jpg`, type: "jpeg", quality: 86 });
  await page.close();

  await browser.close();
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log("renders/ 写好了：product-1x.png、product-3x.png、motions.jpg、full-art.png、full-art-hand-down.png、silhouette.png、glance.jpg");
})();
