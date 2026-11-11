import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import { loadConfig, VERSION, type RunnerConfig } from "./config.js";
import { registerFormats } from "./store.js";
import { EventLog } from "./eventLog.js";
import { Drafts } from "./drafts.js";
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
import { ClaudeCodeAdapter, readModels, readUsage, type ClaudeBin } from "./agents/claudeCode.js";
import { ClaudeCatalog } from "./claudeCatalog.js";
import { CodexAdapter } from "./agents/codex.js";
import { findCodexBin, type CodexBin } from "./agents/codexRpc.js";
import { CodexSetup } from "./agents/codexSetup.js";
import { CodexCatalog } from "./codexCatalog.js";
import { homeDir } from "./agents/claudeEnv.js";
import { createServer } from "./http/server.js";
import { QuotaTracker } from "./quota.js";
import { CliTools, type ToolExec } from "./tools.js";
import { GatewayPricing } from "./pricing.js";
import { GatewaySpend } from "./spend.js";
import { TokenHub } from "./tokenHub.js";
import { Budgets } from "./budget.js";
import { CodexQuota } from "./codexQuota.js";
import { createDesktop, openUrl, type Desktop, type MenuAction } from "./desktop/index.js";
import { AppWindow } from "./desktop/appWindow.js";

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
  /** 测试用：这台电脑的 Claude 订阅能不能用（连 TokenHub 时决定要不要把它设成默认）；不给就看 Claude Code 装没装、登没登录。 */
  subscriptionUsable?: () => Promise<boolean>;
  /** 读本人 Codex 订阅的额度（测试里换成假的；没装回 null）。 */
  codexLimits?: () => Promise<Record<string, unknown> | null>;
  /** 测试用：Codex 可执行文件（假的 app-server）；null 当没装。不给就找本机装的。 */
  codexBin?: CodexBin | null;
  /** Codex 的配置目录（登录也在里面）：默认是数据目录下天枢专用的 codex；null 用本人的 ~/.codex。 */
  codexHome?: string | null;
  /** 测试用：替本人打开浏览器（登录 Codex 时），不去开真的。 */
  openUrl?: (url: string) => void;
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
  const drafts = new Drafts();
  const desktop = opts.desktop ?? createDesktop(Boolean(opts.headless), config.dataDir);
  const tokens = new TokenStore(config.dataDir);
  const pairings = new Pairings(tokens, ({ code, origin, label }) =>
    desktop.confirm("天枢本机程序 · 配对", `${label}（${origin}）想连接这台电脑上的天枢本机程序。\n\n确认码：${code}\n\n和网页上显示的一致才点「是」。`));
  // 本人的 Codex（设计 17.2 第 38 条）：用天枢专用的配置目录，登录、额度、模型目录、会话都在里面
  const codexHome = opts.codexHome !== undefined ? opts.codexHome : join(config.dataDir, "codex");
  if (codexHome) mkdirSync(codexHome, { recursive: true });
  const codexBin = opts.codexBin !== undefined ? async () => opts.codexBin ?? null : async () => findCodexBin();
  const codex = new CodexSetup(codexBin, codexHome, opts.openUrl ?? openUrl);
  const codexCatalog = new CodexCatalog(config.dataDir, () => codex.readModels());
  // 本人 Claude 订阅能用的模型（设计 17.2 第 40 条）：向 Claude Code 读（握手里就有，不发提示、不花 token）
  const claudeCatalog = new ClaudeCatalog(config.dataDir, async () => {
    const bin = await claudeBin();
    return bin ? readModels(bin, config.dataDir) : null;
  });
  const models = new ModelProfiles(config.dataDir, secrets, codexCatalog, claudeCatalog);
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
  // Codex 订阅的额度：装了 Codex 才有；用完了 Codex 的卡停下等
  const codexQuota = new CodexQuota(opts.codexLimits ?? (() => codex.readLimits()));
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
  const tokenHub = new TokenHub(models, config.tokenHubUrl, baseFetch, opts.subscriptionUsable ?? (async () => {
    const s = await claude.status();
    return s.installed && s.loggedIn;
  }));
  const budgets = new Budgets(config.dataDir);
  let sessionsRef: SessionManager | null = null;
  const updateTray = () => desktop.setState({ paired: tokens.count() > 0, running: sessionsRef?.activeCount() ?? 0, paused: settings.get().paused });
  const sessions = new SessionManager({
    dataDir: config.dataDir, log, drafts, models, customTools, folders, outbox, deviceId: config.deviceId, port: () => config.port,
    // 只看关联记录在不在，不解钥匙：本机程序重启后第一次解要起 powershell（11/11 量过 0.5–2.6 秒），拉起时不等它。关联、取消时令牌和记录一起写、一起删。
    cloudLinked: async () => cloud.view().linked,
    paused: () => settings.get().paused,
    skillsDir: opts.skillsDir ?? join(homeDir(), ".claude", "skills"),
    maxConcurrent: () => settings.get().maxConcurrent,
    autoMerge: () => settings.get().autoMerge,
    quota, codexQuota, pricing, budgets, holdTiming: opts.holdTiming,
    verifyBrief: async (handbackKey) => fetchVerifyBrief(await cloud.target(), handbackKey, cloudFetch),
    fetchAttachment: async (id) => fetchAttachment(await cloud.target(), id, cloudFetch, MAX_ATTACHMENT_BYTES),
    adapters: {
      "claude-code": new ClaudeCodeAdapter(claudeBin),
      codex: new CodexAdapter(codexBin, { home: codexHome, dataDir: config.dataDir }),
    },
    onChange: updateTray,
  });
  sessionsRef = sessions;
  quota.onChange = () => sessions.onQuotaChange();
  codexQuota.onChange = () => sessions.onQuotaChange();
  // 登上 Codex 了：马上读它能用的模型和额度
  codex.onLogin = () => { void codexCatalog.refresh(true); void codexQuota.refresh(true); };
  outbox.slots = () => sessions.slots();
  // 交回送到天枢以后去取验收交代。
  outbox.onSent = () => void sessions.pullBriefs();
  const server = createServer({
    config, version: VERSION, tokens, pairings, sessions, log, drafts, models, folders, claude, cloud, settings, quota, codexQuota, codex, codexCatalog, claudeCatalog, tools, customTools, spend, tokenHub,
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

  // 托盘点开：装成了 Chrome / Edge 应用就开应用窗口，没装开浏览器标签
  const appWindow = new AppWindow(config.tianshuUrl, openUrl);
  const onMenu = async (a: MenuAction) => {
    if (a === "open") await appWindow.open();
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
  void codexCatalog.refresh();
  void claudeCatalog.refresh();
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
