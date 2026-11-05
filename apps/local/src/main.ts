import { loadConfig, VERSION } from "./config.js";
import { startRunner } from "./app.js";
import { autostartEnabled, disableAutostart, enableAutostart } from "./autostart.js";

const USAGE = `天枢本机程序 ${VERSION}
用法：
  tianshu-local [run] [--dev] [--headless] [--port N] [--data-dir DIR]   启动（默认）
  tianshu-local autostart on|off|status                                  开机自启
  tianshu-local version`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** 已有一个本机程序在跑（开机自启 + 用户又双击了）：不再起第二个，直接打开天枢。 */
async function alreadyRunning(port: number, origin: string): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/health`, { headers: { origin }, signal: AbortSignal.timeout(1_500) });
    const j = (await r.json()) as { app?: string };
    return j.app === "tianshu-local";
  } catch {
    return false;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "run";
  const args = command === argv[0] ? argv.slice(1) : argv;
  switch (command) {
    case "version":
      console.log(VERSION);
      return;
    case "autostart": {
      const sub = args[0];
      if (sub === "on") enableAutostart(process.execPath);
      else if (sub === "off") disableAutostart();
      console.log(autostartEnabled() ? "开机自启：开" : "开机自启：关");
      return;
    }
    case "run": {
      const dev = args.includes("--dev");
      const port = flag(args, "--port") ? Number(flag(args, "--port")) : undefined;
      const dataDir = flag(args, "--data-dir");
      const cfg = loadConfig({ dataDir, dev, port });
      if (await alreadyRunning(cfg.port, cfg.allowedOrigins[0]!)) {
        console.log(`本机程序已在 127.0.0.1:${cfg.port} 运行`);
        return;
      }
      const runner = await startRunner({ dataDir, dev, port, headless: args.includes("--headless"), onQuit: () => process.exit(0) });
      console.log(`天枢本机程序 ${VERSION} 在 http://127.0.0.1:${runner.config.port}，允许来源：${runner.config.allowedOrigins.join(", ")}${dev ? `；测试页 http://127.0.0.1:${runner.config.port}/dev` : ""}`);
      const stop = async () => { await runner.close(); process.exit(0); };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
      return;
    }
    default:
      console.log(USAGE);
      process.exitCode = command === "help" || command === "--help" ? 0 : 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
