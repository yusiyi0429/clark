// 把 shots/ 里某个宽度的截图拼成一张总览（带编号和名字），无头 Chrome 截整页。node sheet.mjs <宽度> <输出 png>
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [width, outFile] = process.argv.slice(2);
const dir = resolve("shots");
const files = readdirSync(dir).filter((f) => f.endsWith(`-${width}.png`)).sort();
const mobile = Number(width) < 768;
const cols = mobile ? 5 : 2;
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:32px;background:#eef0f4;font:15px "Microsoft YaHei",sans-serif;color:#1d2433}
h1{font-size:22px;margin:0 0 20px} .g{display:grid;grid-template-columns:repeat(${cols},1fr);gap:24px}
figure{margin:0;background:#fff;border-radius:12px;padding:12px;box-shadow:0 1px 3px #0002}
figcaption{font-weight:600;margin:0 0 8px} img{width:100%;border-radius:8px;display:block;border:1px solid #dde}
</style><h1>会后确认 · ${width} 宽 · 演示环境（脱敏样例「co-agent 交互评审」）</h1><div class="g">${files.map((f) =>
  `<figure><figcaption>${f.replace(`-${width}.png`, "").replace(/^(\d+)-/, "$1 · ").replace(/-/g, " · ")}</figcaption><img src="data:image/png;base64,${readFileSync(join(dir, f)).toString("base64")}"></figure>`).join("")}</div>`;
const page = join(tmpdir(), `sheet-${width}.html`);
writeFileSync(page, html);
const port = 9800 + Math.floor(Math.random() * 100);
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${join(tmpdir(), `sheet-${port}`)}`, "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let target; for (let i = 0; i < 50 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch { await sleep(200); } }
  const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r));
  let seq = 0; const wait = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const id = ++seq; wait.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: mobile ? 1800 : 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: pathToFileURL(page).href }); await sleep(2500);
  const { result } = await send("Runtime.evaluate", { expression: "document.documentElement.scrollHeight", returnByValue: true });
  await send("Emulation.setDeviceMetricsOverride", { width: mobile ? 1800 : 1600, height: result.value, deviceScaleFactor: 1, mobile: false }); await sleep(800);
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  writeFileSync(outFile, Buffer.from(shot.result.data, "base64")); console.log(outFile, files.length, "shots");
  ws.close();
} finally { chrome.kill(); }
