// 预览页自检：桌面（浅色、深色）和手机宽度下没有报错、没有横向溢出；真动画里 C妹 转眼时只移两颗眼珠、两颗同步，
// 切到在说后眼珠回正，退场没有报错。用法：node .scratch/buddy-cmei/tools/verify-page.cjs（先跑 build-preview.cjs）
const path = require("path");
const { chromium } = require("playwright");

const PAGE = "file://" + path.join(__dirname, "..", "preview.html");
let failed = 0;
const ok = (cond, msg) => { console.log(`${cond ? "ok  " : "FAIL"} ${msg}`); if (!cond) failed++; };

(async () => {
  const browser = await chromium.launch();
  for (const [name, width, scheme] of [["桌面浅色", 1180, "light"], ["桌面深色", 1180, "dark"], ["手机", 400, "light"]]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (["error", "warning"].includes(m.type())) errors.push(m.text()); });
    await page.goto(PAGE);
    await page.waitForTimeout(1500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(errors.length === 0 && overflow <= 0, `${name}：没有报错（${errors.length}）、没有横向溢出（${overflow}px）`);
    await page.close();
  }

  // 真动画：在听时每 3–5 秒转一次眼，最多等 15 秒
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) errors.push(m.text()); });
  await page.goto(PAGE);
  const seen = await page.evaluate(() => new Promise((resolve) => {
    const svg = document.querySelector("#live-cmei svg");
    const miles = document.querySelector("#live-miles svg");
    const t0 = performance.now();
    let moved = false, together = true;
    const id = setInterval(() => {
      const m = [...svg.querySelectorAll("g.gaze")].map((n) => getComputedStyle(n).transform);
      if (m.some((v) => v !== m[0])) together = false;
      const x = new DOMMatrix(m[0]).e;
      if (Math.abs(x - CMEI_ART.gazeUnit) > 3) moved = true;   // 在听时目光停在 (1, 0) 格，偏离它就是在转眼
      if ((moved && performance.now() - t0 > 4000) || performance.now() - t0 > 15000) {
        clearInterval(id);
        resolve({ irises: m.length, milesGaze: miles.querySelectorAll("g.gaze").length, moved, together });
      }
    }, 40);
  }));
  ok(seen.irises === 2 && seen.milesGaze === 1, `C妹 的目光层是两颗眼珠（${seen.irises}），Miles 照旧整只眼睛（${seen.milesGaze}）`);
  ok(seen.moved, "15 秒内 C妹 转了一次眼");
  ok(seen.together, "两颗眼珠始终同步");
  await page.click("label:has(#pose-speaking)");
  await page.waitForTimeout(600);
  const speaking = await page.evaluate(() => [...document.querySelectorAll("#live-cmei g.gaze")].map((n) => getComputedStyle(n).transform));
  ok(speaking.every((v) => v === "none"), "切到在说后眼珠回正");
  await page.click("#leave");
  await page.waitForTimeout(1800);
  ok(errors.length === 0, `出场、转眼、切姿势、退场，控制台没有报错或警告${errors.length ? "：" + errors.join(" | ") : ""}`);
  await browser.close();
  console.log(failed ? `\n${failed} 项没过` : "\n全部通过");
  process.exit(failed ? 1 : 0);
})();
