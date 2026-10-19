/**
 * 管理员视图自查截图：本机 Chrome 无头模式 + CDP，登录 fixture-server.mts 造的测试账号，1440 与 390 两个宽度各拍几张。
 * 用法：node shoot.mjs（先起 fixture-server.mts 在 4600、next dev 在 3600）。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("./", import.meta.url));
const base = "http://127.0.0.1:3600";
const profile = mkdtempSync(join(tmpdir(), "admin-shoot-"));
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe",
  ["--headless=new", "--remote-debugging-port=9339", `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  target = await fetch("http://127.0.0.1:9339/json").then((r) => r.json()).then((list) => list.find((item) => item.type === "page")).catch(() => undefined);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve));
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, (message) => message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result));
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
const go = async (path) => { await send("Page.navigate", { url: `${base}${path}` }); await sleep(4500); };
const size = (width, height, mobile) => send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(out, name), Buffer.from(data, "base64"));
  console.log("saved", name);
};
/** 截长页：把阅读页的滚动区撑开，整页拍下来。 */
const shotFull = async (name, width) => {
  const height = await evaluate(`(() => { const el = document.querySelector('.ts-detail'); return Math.ceil((el?.scrollHeight ?? 900) + 40); })()`);
  await size(width, Math.max(height, 400), width < 760);
  await sleep(600);
  await shot(name);
};
const login = (loginId, passcode) => evaluate(`fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginId: '${loginId}', passcode: '${passcode}' }) }).then((r) => r.status)`);
const dismiss = () => evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '知道了'); b?.click(); return Boolean(b); })()`);
const click = (selectorExpr) => evaluate(`(() => { const el = ${selectorExpr}; el?.click(); return Boolean(el); })()`);

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await size(1440, 900, false);
  await go("/access");
  console.log("login", await login("sunm", "2580"));
  await go("/admin");
  await dismiss(); await sleep(800);
  await shot("1440-01-overview.png");
  await shotFull("1440-02-overview-full.png", 1440);
  await size(1440, 900, false); await sleep(400);
  await click(`[...document.querySelectorAll('button[aria-expanded]')].find((b) => b.textContent.startsWith('陈思远'))`);
  await sleep(500);
  await shot("1440-03-row-expanded.png");
  await click(`[...document.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.includes('后台任务失败'))`);
  await sleep(500);
  await shot("1440-04-filter-jobs.png");
  await click(`[...document.querySelectorAll('button[aria-pressed="true"]')][0]`);
  await sleep(300);
  await click(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '提醒')`);
  await sleep(800);
  await shot("1440-05-remind-preview.png");
  await click(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '发送')`);
  await sleep(1500);
  await click(`[...document.querySelectorAll('li')].find((li) => li.textContent.includes('feishu.event'))?.querySelector('button')`);
  await sleep(1200);
  await shotFull("1440-06-after-actions-full.png", 1440);

  await size(390, 844, true);
  await go("/admin");
  await dismiss(); await sleep(800);
  await shot("390-01-overview.png");
  await shotFull("390-02-overview-full.png", 390);
  await size(390, 844, true); await sleep(400);
  await click(`[...document.querySelectorAll('button[aria-expanded]')].find((b) => b.textContent.startsWith('陈思远'))`);
  await sleep(600);
  await shotFull("390-03-row-expanded-full.png", 390);

  // 成员（非管理员）打开同一路径：页面不存在。
  await size(1440, 900, false);
  await evaluate(`fetch('/api/auth/logout', { method: 'POST' }).then((r) => r.status)`);
  await go("/access");
  console.log("member login", await login("chens", "4826"));
  await go("/me/admin");
  await shot("1440-07-non-admin-404.png");
  // 被提醒的人：通知栏「请求」里收到管理员发来的那一条。
  await go("/me");
  await dismiss(); await sleep(800);
  await shot("1440-08-member-receives-reminder.png");
} finally {
  ws.close();
  chrome.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome 还占着文件时留给系统清理 */ }
}
