// 会后确认演示的截图：本机 Chrome 无头 + DevTools 协议（不装依赖）。按人登录，同一组镜头在 1440 与 390 各截一张当前视口。
//   node shoot.mjs <输出目录> <镜头 JSON 文件>
// 镜头：[{ "name": "01-…", "login": "lin", "path": "/me", "script": "页面里先执行的 JS（可 await）", "width": [1440, 390] }]
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [out, specFile] = process.argv.slice(2);
const shots = JSON.parse(readFileSync(specFile, "utf8"));
const ORIGIN = "http://localhost:3828";
const PASSCODE = "2580";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
mkdirSync(out, { recursive: true });

const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${join(tmpdir(), `mc-shoot-${port}`)}`, "--hide-scrollbars", "--no-first-run", "--lang=zh-CN", "about:blank"], { stdio: "ignore" });
try {
  let target;
  for (let i = 0; i < 50 && !target; i += 1) {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === "page"); } catch { await sleep(200); }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve));
  let seq = 0;
  const waiting = new Map();
  ws.addEventListener("message", (event) => { const msg = JSON.parse(event.data); if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); } });
  const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; waiting.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
    if (result.result?.exceptionDetails) console.error("  script:", JSON.stringify(result.result.exceptionDetails).slice(0, 300));
    return result.result?.result?.value;
  };
  await send("Network.enable");
  await send("Page.enable");

  const cookies = {};
  for (const shot of shots) {
    if (!cookies[shot.login]) {
      const login = await fetch(`${ORIGIN}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ loginId: shot.login, passcode: PASSCODE }) });
      cookies[shot.login] = (login.headers.get("set-cookie") ?? "").split(";")[0];
    }
    const [name, ...rest] = cookies[shot.login].split("=");
    await send("Network.clearBrowserCookies");
    await send("Network.setCookie", { name, value: rest.join("="), url: ORIGIN, httpOnly: true, sameSite: "Strict" });
    for (const width of shot.width ?? [1440, 390]) {
      const mobile = width < 768;
      await send("Emulation.setDeviceMetricsOverride", { width, height: mobile ? 844 : 900, deviceScaleFactor: 2, mobile });
      await send("Emulation.setUserAgentOverride", { userAgent: mobile
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
        : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36" });
      await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: shot.scheme ?? "light" }] });
      await send("Page.navigate", { url: `${ORIGIN}${shot.path}` });
      await sleep(shot.wait ?? 5000);
      // 关掉「这次更新了什么」和 Next 开发角标。
      await evaluate("[...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '知道了' && b.closest('[role=dialog]')).forEach(b => b.click()); document.querySelector('nextjs-portal')?.remove();");
      await sleep(800);
      if (shot.script) { await evaluate(shot.script); await sleep(shot.after ?? 1500); }
      const where = await evaluate("return location.pathname + ' | ' + document.body.innerText.slice(0, 60).replace(/\\s+/g, ' ')");
      const shotData = await send("Page.captureScreenshot", { format: "png" });
      const file = `${shot.name}-${width}${shot.scheme === "dark" ? "-dark" : ""}.png`;
      writeFileSync(join(out, file), Buffer.from(shotData.result.data, "base64"));
      console.log(file, "←", where);
    }
  }
  ws.close();
} finally {
  chrome.kill();
}
