import { join } from "node:path";
import type { Server } from "node:http";
import { loadConfig, VERSION, type RunnerConfig } from "./config.js";
import { registerFormats } from "./store.js";
import { EventLog } from "./eventLog.js";
import { Pairings, TokenStore } from "./pairing.js";
import { createSecretStore, type SecretStore } from "./secrets.js";
import { ModelProfiles } from "./models.js";
import { CustomTools } from "./customTools.js";
import { readsTokenHubSpend } from "./modelOrigin.js";
import { Folders } from "./folders.js";
import { Outbox } from "./outbox.js";
import { CloudLink, Settings, fetchAttachment, fetchVerifyBrief } from "./cloud.js";
import { MAX_ATTACHMENT_BYTES } from "./attachments.js";
import { cloneRepo } from "./handover.js";
import { SessionManager, type SessionDeps } from "./sessions.js";
import { ClaudeSetup } from "./agents/claudeSetup.js";
import { ClaudeCodeAdapter, readUsage, type ClaudeBin } from "./agents/claudeCode.js";
import { CodexAdapter } from "./agents/codex.js";
import { homeDir } from "./agents/claudeEnv.js";
import { createServer } from "./http/server.js";
import { QuotaTracker } from "./quota.js";
import { CliTools, type ToolExec } from "./tools.js";
import { GatewayPricing } from "./pricing.js";
import { GatewaySpend } from "./spend.js";
import { Budgets } from "./budget.js";
import { CodexQuota, readCodexLimits } from "./codexQuota.js";
import { createDesktop, openUrl, type Desktop, type MenuAction } from "./desktop/index.js";

export interface RunnerOptions {
  dataDir?: string;
  /** 测试用：当成本人主目录的地方（新建文件夹默认建在它的 Desktop 下），不碰真的主目录。 */
  home?: string;
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
  /** 测试用：替换查 gh、lark-cli 登录状态的执行（不去跑本人电脑上真装的）。 */
  toolsExec?: ToolExec;
  /** 测试用：停着等额度时的等待时长。 */
  holdTiming?: SessionDeps["holdTiming"];
  /** 接手项目时 clone 仓库（测试里换成从本地仓库 clone）。 */
  cloneRepo?: typeof cloneRepo;
  /** 读本人 Codex 订阅的额度（测试里换成假的；没装回 null）。 */
  codexLimits?: () => Promise<Record<string, unknown> | null>;
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
  const customTools = new CustomTools(config.dataDir, secrets, opts.fetchImpl ?? fetch);
  const folders = new Folders(config.dataDir, opts.home);
  const cloud = new CloudLink(config.dataDir, secrets, config.allowedOrigins);
  const settings = new Settings(config.dataDir, config.allowedOrigins);
  const outbox = new Outbox(config.dataDir, () => cloud.target(), { deviceId: config.deviceId, runnerVersion: VERSION }, opts.fetchImpl);
  cloud.outbox = outbox;
  // 令牌被拒只认同步接口：同步回 401 才当成没关联（网页会自己重新关联），发件箱留着、关联上以后接着发。
  // 会话的天枢 MCP、验收交代碰到 401 时，马上用同步接口（发一批空的）确认一次。
  outbox.onRejected = (token) => void cloud.rejected(token);
  const baseFetch = opts.fetchImpl ?? fetch;
  const cloudFetch: typeof fetch = async (input, init) => {
    const res = await baseFetch(input, init);
    if (res.status === 401) void outbox.heartbeat(true);
    return res;
  };
  const claude = new ClaudeSetup(config.claudePath);
  const claudeBin = opts.claudeBin ? async () => opts.claudeBin! : () => claude.bin();
  // 额度：向 Claude Code 读（不发提示、不花 token），跑着的卡报的也算进来
  const quota = new QuotaTracker(config.dataDir, async () => {
    const bin = await claudeBin();
    if (!bin) throw new Error("这台电脑上没找到 Claude Code");
    return readUsage(bin, config.dataDir);
  });
  // Codex 订阅的额度：装了 Codex 才有，只显示、同步，不挡卡
  const codexQuota = new CodexQuota(opts.codexLimits ?? (() => readCodexLimits()));
  outbox.quota = () => [...quota.syncView(), ...codexQuota.syncView(), ...spend.syncView()];
  const tools = new CliTools(opts.toolsExec);
  const pricing = new GatewayPricing(baseFetch);
  // TokenHub 今天、本月花了多少：用本机存的网关钥匙读 TokenHub 自己的统计（每人一个计费账户）
  const spend = new GatewaySpend(async () => {
    const out: { baseUrl: string; apiKey: string }[] = [];
    for (const p of await models.list()) {
      if (p.source !== "gateway" || !p.hasKey || (p.origin && !readsTokenHubSpend(p.origin))) continue; // 经 magpie 的、认得出的厂商不读 TokenHub 的统计
      const m = await models.resolve(p.id);
      if (m?.baseUrl && m.apiKey) out.push({ baseUrl: m.baseUrl, apiKey: m.apiKey });
    }
    return out;
  }, baseFetch);
  const budgets = new Budgets(config.dataDir);
  let sessionsRef: SessionManager | null = null;
  const updateTray = () => desktop.setState({ paired: tokens.count() > 0, running: sessionsRef?.activeCount() ?? 0, paused: settings.get().paused });
  const sessions = new SessionManager({
    dataDir: config.dataDir, log, models, customTools, folders, outbox, deviceId: config.deviceId, port: () => config.port,
    cloudLinked: async () => Boolean(await cloud.target()),
    paused: () => settings.get().paused,
    skillsDir: opts.skillsDir ?? join(homeDir(), ".claude", "skills"),
    maxConcurrent: () => settings.get().maxConcurrent,
    autoMerge: () => settings.get().autoMerge,
    quota, pricing, budgets, holdTiming: opts.holdTiming,
    verifyBrief: async (handbackKey) => fetchVerifyBrief(await cloud.target(), handbackKey, cloudFetch),
    fetchAttachment: async (id) => fetchAttachment(await cloud.target(), id, cloudFetch, MAX_ATTACHMENT_BYTES),
    adapters: {
      "claude-code": new ClaudeCodeAdapter(claudeBin),
      codex: new CodexAdapter(),
    },
    onChange: updateTray,
  });
  sessionsRef = sessions;
  quota.onChange = () => sessions.onQuotaChange();
  outbox.slots = () => sessions.slots();
  // 交回送到天枢以后去取验收交代。
  outbox.onSent = () => void sessions.pullBriefs();
  const server = createServer({
    config, version: VERSION, tokens, pairings, sessions, log, models, folders, claude, cloud, settings, quota, codexQuota, tools, customTools, spend,
    pickFolder: () => desktop.pickFolder(),
    cloneRepo: opts.cloneRepo ?? cloneRepo,
    fetchImpl: cloudFetch,
    onSettingsChange: updateTray,
  });

  let closing: Promise<void> | null = null;
  const close = () => closing ??= (async () => {
    outbox.stop();
    tools.stop();
    await sessions.shutdown();
    desktop.stop();
    await new Promise<void>((r) => server.close(() => r()));
  })();

  const onMenu = async (a: MenuAction) => {
    if (a === "open") openUrl(config.tianshuUrl);
    if (a === "pause") { settings.patch({ paused: true }); await sessions.interruptAll(); }
    if (a === "resume") { settings.patch({ paused: false }); sessions.pump(); }
    if (a === "quit") { await close(); opts.onQuit?.(); }
    updateTray();
  };

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  // 上次没开始的排队会话，有空位就接上（要等本机程序开始监听，本会话 MCP 才连得上）。
  sessions.pump();
  void sessions.pullBriefs();
  void sessions.pruneWorktrees();
  void sessions.releaseWaiting();
  tools.start();
  await desktop.start((a) => void onMenu(a));
  updateTray();
  setInterval(updateTray, 10_000).unref();
  outbox.kick();
  outbox.startHeartbeat();
  return { config, server, sessions, outbox, close };
}
