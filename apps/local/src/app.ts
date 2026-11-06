import { join } from "node:path";
import type { Server } from "node:http";
import { loadConfig, VERSION, type RunnerConfig } from "./config.js";
import { registerFormats } from "./store.js";
import { EventLog } from "./eventLog.js";
import { Pairings, TokenStore } from "./pairing.js";
import { createSecretStore, type SecretStore } from "./secrets.js";
import { ModelProfiles } from "./models.js";
import { Folders } from "./folders.js";
import { Outbox } from "./outbox.js";
import { CloudLink, Settings } from "./cloud.js";
import { SessionManager } from "./sessions.js";
import { ClaudeSetup } from "./agents/claudeSetup.js";
import { ClaudeCodeAdapter, type ClaudeBin } from "./agents/claudeCode.js";
import { CodexAdapter } from "./agents/codex.js";
import { homeDir } from "./agents/claudeEnv.js";
import { createServer } from "./http/server.js";
import { createDesktop, openUrl, type Desktop, type MenuAction } from "./desktop/index.js";

export interface RunnerOptions {
  dataDir?: string;
  port?: number;
  dev?: boolean;
  headless?: boolean;
  /** 测试用：替换 claude 可执行文件、钥匙存储、桌面、云端请求。 */
  claudeBin?: ClaudeBin;
  secrets?: SecretStore;
  desktop?: Desktop;
  fetchImpl?: typeof fetch;
  allowedOrigins?: string[];
  /** 本人已装技能的目录（找飞书技能）；默认 ~/.claude/skills。 */
  skillsDir?: string;
  onQuit?: () => void;
}

export interface Runner {
  config: RunnerConfig;
  server: Server;
  sessions: SessionManager;
  outbox: Outbox;
  close(): Promise<void>;
}

export async function startRunner(opts: RunnerOptions = {}): Promise<Runner> {
  registerFormats();
  const config = loadConfig({ dataDir: opts.dataDir, dev: opts.dev, port: opts.port });
  if (opts.allowedOrigins) config.allowedOrigins = opts.allowedOrigins;
  const secrets = opts.secrets ?? createSecretStore(config.dataDir);
  const log = new EventLog(join(config.dataDir, "sessions"));
  const desktop = opts.desktop ?? createDesktop(Boolean(opts.headless), config.dataDir);
  const tokens = new TokenStore(config.dataDir);
  const pairings = new Pairings(tokens, ({ code, origin, label }) =>
    desktop.confirm("天枢本机程序 · 配对", `${label}（${origin}）想连接这台电脑上的天枢本机程序。\n\n确认码：${code}\n\n和网页上显示的一致才点「是」。`));
  const models = new ModelProfiles(config.dataDir, secrets);
  const folders = new Folders(config.dataDir);
  const cloud = new CloudLink(config.dataDir, secrets, config.allowedOrigins);
  const settings = new Settings(config.dataDir, config.allowedOrigins);
  const outbox = new Outbox(config.dataDir, () => cloud.target(), { deviceId: config.deviceId, runnerVersion: VERSION }, opts.fetchImpl);
  cloud.outbox = outbox;
  const claude = new ClaudeSetup(config.claudePath);
  let sessionsRef: SessionManager | null = null;
  const updateTray = () => desktop.setState({ paired: tokens.count() > 0, running: sessionsRef?.activeCount() ?? 0, paused: settings.get().paused });
  const sessions = new SessionManager({
    dataDir: config.dataDir, log, models, folders, outbox, deviceId: config.deviceId, port: () => config.port,
    cloudLinked: async () => Boolean(await cloud.target()),
    paused: () => settings.get().paused,
    skillsDir: opts.skillsDir ?? join(homeDir(), ".claude", "skills"),
    maxConcurrent: () => settings.get().maxConcurrent,
    adapters: {
      "claude-code": new ClaudeCodeAdapter(opts.claudeBin ? async () => opts.claudeBin! : () => claude.bin()),
      codex: new CodexAdapter(),
    },
    onChange: updateTray,
  });
  sessionsRef = sessions;
  outbox.slots = () => sessions.slots();
  const server = createServer({
    config, version: VERSION, tokens, pairings, sessions, log, models, folders, claude, cloud, settings,
    pickFolder: () => desktop.pickFolder(),
    fetchImpl: opts.fetchImpl ?? fetch,
    onSettingsChange: updateTray,
  });

  let closing: Promise<void> | null = null;
  const close = () => closing ??= (async () => {
    outbox.stop();
    await sessions.shutdown();
    desktop.stop();
    await new Promise<void>((r) => server.close(() => r()));
  })();

  const onMenu = async (a: MenuAction) => {
    if (a === "open") openUrl(config.tianshuUrl);
    if (a === "pause") { settings.patch({ paused: true }); await sessions.interruptAll(); }
    if (a === "resume") settings.patch({ paused: false });
    if (a === "quit") { await close(); opts.onQuit?.(); }
    updateTray();
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  await desktop.start((a) => void onMenu(a));
  updateTray();
  setInterval(updateTray, 10_000).unref();
  outbox.kick();
  return { config, server, sessions, outbox, close };
}
