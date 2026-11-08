import { VERSION } from "./config.js";
import { startRunner } from "./app.js";
import { HostedDesktop, type HostPort } from "./desktop/hosted.js";

/**
 * 天枢桌面版拉起本机程序的入口（Electron utilityProcess.fork，见 apps/desktop）。数据目录、端口、配置照常（和脚本装的同一个数据目录）。
 * 起好了回 {type:"ready", port, version}；起不来回 {type:"error", code, message} 后退出（端口被占是 EADDRINUSE）。
 * 托盘「退出」时本机程序收尾后退出；开机自启、单实例、托盘由壳管。
 */
const port = (process as unknown as { parentPort?: HostPort }).parentPort;
if (!port) {
  console.error("这个入口只能由天枢桌面版拉起");
  process.exit(1);
}
const host = port;
startRunner({ desktop: new HostedDesktop(host), onQuit: () => process.exit(0) }).then(
  (runner) => {
    host.postMessage({ type: "ready", port: runner.config.port, version: VERSION });
    const stop = async () => { await runner.close(); process.exit(0); };
    process.on("SIGTERM", stop);
  },
  (e: unknown) => {
    host.postMessage({ type: "error", code: (e as { code?: string })?.code ?? null, message: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  },
);
