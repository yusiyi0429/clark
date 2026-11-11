"use client";

/**
 * 「连接和技能」页的「连接」标签（设计 9.5、5.4.6、11.2、§17.2 第 22、31 条）。不写说明句。
 * - 我的：最上面是卡片网格——本机程序、飞书、本体、GitHub、飞书命令行、加过的工具（金蝶、其他）；
 *   下面是几组行：这台电脑（Claude Code 带订阅额度和每个窗口的明细、Codex、TokenHub、文件夹、同时跑、验收过就合回、带上个人配置、我的几台电脑）、
 *   我的账号（微信、让外部 AI 读天枢）、公司（公司本体、飞书应用，只看状态）。
 *   本机逻辑照插件页（components/local/PluginsPage.tsx）：配对好、没关联云端时自己关联一次；断开的正好是这台时当场重新关联。手机上不连本机，只列电脑。
 * - 可添加：还没加的工具预设（金蝶）和「其他工具」。
 * 动作没成：那一行动作的位置写「失败 · 重试」（原因在 title 里），不弹 toast。
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { Boxes, Check, ChevronDown, Copy, Database, GitBranch, MessageSquare, Monitor, Plug, Terminal, X } from "lucide-react";
import { Dropdown } from "@heroui/react";
import { Popover } from "ts-design/primitives";
import type { TLocalAgentKind, TLocalDeviceView, TLocalTool, TLocalToolUpsert, TLocalSource } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { ConnectionDialog } from "@/components/ConnectionDialog";
import { WechatConnectPanel, readWechatConnection, type WechatConnection } from "@/components/WechatConnect";
import { installCommand, isMac } from "@/components/local/PluginsPage";
import { useHandheld } from "@/components/ui/useHandheld";
import { FailedLine } from "@/components/work/DecisionBox";
import { MANY_SESSIONS } from "@/components/work/Slots";
import { browserApi } from "@/lib/api/client";
import { listDevices, revokeDevice } from "@/lib/board/cloud";
import { feishuConnectHref, readFeishuConnection, type FeishuConnection } from "@/lib/feishuLogin";
import { usageCells } from "@/lib/home/quota";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { linkCloud, type LinkPerson } from "@/lib/local/link";
import { modelDisplayName } from "@/lib/local/runModel";
import type { SecondaryPageProps } from "./index";
import { TokenHubDialog } from "./TokenHubDialog";
import { AddSourceDialog } from "../AddSourceDialog";
import { KINGDEE_PLACEHOLDER, agentRow, feishuRow, isCliTool, localToolRow, mcpRow, programRow, tokenHubRow, toolRow, type RowAction, type RowModel, type TokenLike } from "./connectionRows";
import { AddButton, Added, Card, CardGrid, ICON, QuotaBlock, Row, Section, StateLine, SwitchRow, relative, useMe, type Me } from "./parts";
import h from "@/styles/home.module.css";
import p from "@/styles/home-pages.module.css";

const LABEL: Record<RowAction, string> = { pair: "配对", retry: "重试", resume: "继续", link: "连接", unpair: "断开", reauth: "重新授权", login: "连接" };

/** 一行一个动作：跑的时候按钮变灰；没成写「失败 · 重试」。 */
function useActions() {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ key: string; reason: string; retry: () => void } | null>(null);
  const run = useCallback((key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setFailed(null);
    void work().catch((error: unknown) => setFailed({ key, reason: error instanceof Error ? error.message : "", retry: () => run(key, work) }))
      .finally(() => setBusy(null));
  }, []);
  /** 这一行的动作位：没成时是「失败 · 重试」，否则是次按钮。 */
  const slot = (key: string, label: string | null, work: (() => Promise<unknown>) | null): ReactNode => {
    if (failed?.key === key) return <FailedLine inline reason={failed.reason} onRetry={failed.retry} />;
    if (!label || !work) return null;
    return <HeroButton variant="tertiary" size="sm" isDisabled={busy === key} onPress={() => run(key, work)}>{label}</HeroButton>;
  };
  return { run, slot, failed };
}

export function ConnectionsPage({ view = "mine" }: Partial<SecondaryPageProps> & { view?: "mine" | "add" }) {
  const me = useMe();
  const world = useWorldRead();
  const tools = useLocalTools();
  if (view === "add") return <AddConnections tools={tools} />;
  return <><ConnectionGrid me={me} world={world} tools={tools} /><ThisComputer me={me} /><MyAccounts me={me} /><Company world={world.state} /></>;
}

/* ---------------- 这台电脑 ---------------- */

function ThisComputer({ me }: { me: Me | null }) {
  const local = useLocalRunner();
  const actions = useActions();
  const status = local.status;
  const ready = local.phase === "ready";
  const now = Date.now();
  const login = (agent: TLocalAgentKind) => async () => { await local.runner.login(agent); await local.refresh(); };
  const patch = (body: Parameters<typeof local.runner.patchSettings>[0]) => actions.run("settings", async () => { await local.runner.patchSettings(body); await local.refresh(); });
  const [tokenHubOpen, setTokenHubOpen] = useState(false);
  const tokenHub = tokenHubRow(local.models);
  // 加过的来源（第 52 条）：TokenHub 上面那一行单独管，这里列别的；老本机程序没有来源接口（sources 为 null）不画这一行。
  const [sourceDialog, setSourceDialog] = useState<{ source: TLocalSource | null } | null>(null);
  const added = (local.sources?.sources ?? []).filter((source) => source.id !== "tokenhub");

  // 额度和右栏「用量」同一套数：订阅的挂在 Claude Code、Codex 下面，其余（网关余额、当天花费）挂在 TokenHub 下面。
  const cells = ready ? usageCells(status?.quota ?? [], now) : [];
  const cellsOf = (id: string) => cells.filter((cell) => cell.id === id);
  const gatewayCells = cells.filter((cell) => cell.id !== "claude" && cell.id !== "codex");
  const rowOf = (model: RowModel, children?: ReactNode, work?: (() => Promise<unknown>) | null) => (
    <Row key={model.key} testId={`row-${model.key}`} name={model.name} sub={model.sub} state={model.state}
      action={actions.slot(model.key, model.action ? LABEL[model.action] : null, work ?? null)}>{children}</Row>
  );

  // 本机没就绪时这一组只剩「我的几台电脑」，没有电脑就整组不画（本机程序在上面的卡里）。
  if (!ready || !status) return <Devices me={me} alone />;
  return (
    <Section title="这台电脑" testId="group-computer">
      <ul className={p.rows}>
        {ready && status ? <>
          {status.agents.map((agent) => {
            const own = cellsOf(agent.kind === "claude-code" ? "claude" : "codex");
            return rowOf(agentRow(agent, now, own.some((cell) => cell.value === "用完")), own.length ? own.map((cell) => <QuotaBlock key={cell.id} cell={cell} />) : null, login(agent.kind));
          })}
          {rowOf(tokenHub, gatewayCells.length ? gatewayCells.map((cell) => <QuotaBlock key={cell.id} cell={cell} />) : null,
            tokenHub.action === "link" ? async () => setTokenHubOpen(true) : async () => { await local.runner.disconnectTokenHub(); await local.refresh(); })}
          {local.sources ? (
            <Row testId="row-sources" name="来源" sub={added.length ? `${added.length} 个` : null}
              action={<HeroButton variant="tertiary" size="sm" onPress={() => setSourceDialog({ source: null })}>添加</HeroButton>}>
              {added.map((source) => (
                <div key={source.id} className={p.sub} title={source.baseUrl} data-testid="source-row">
                  <b>{source.name}</b><span className={p.path}>{source.models.map((model) => modelDisplayName(model.name)).join(" · ")}</span><span className={p.grow} />
                  <HeroButton variant="ghost" size="sm" onPress={() => setSourceDialog({ source })}>换 Key</HeroButton>
                  <HeroButton variant="ghost" size="sm" isIconOnly title="删除" aria-label={`删除 ${source.name}`}
                    onPress={() => actions.run(`source:${source.id}`, async () => { await local.runner.deleteSource(source.id); await local.refresh(); })}><X {...ICON} /></HeroButton>
                </div>
              ))}
            </Row>
          ) : null}
          <Row testId="row-folders" name="文件夹" sub={local.folders.length ? `${local.folders.length} 个` : null}
            action={<HeroButton variant="tertiary" size="sm" onPress={() => void local.pickFolder()}>添加</HeroButton>}>
            {local.folders.length || local.error ? <>
              {local.folders.map((folder) => (
                <div key={folder.id} className={p.sub} title={folder.path}>
                  <b>{folder.label}</b><span className={p.path}>{folder.path}</span><span className={p.grow} />
                  <HeroButton variant="ghost" size="sm" isIconOnly title="移除" aria-label={`移除 ${folder.label}`}
                    onPress={() => actions.run(`folder:${folder.id}`, async () => { await local.runner.removeFolder(folder.id); await local.refresh(); })}><X {...ICON} /></HeroButton>
                </div>
              ))}
              {local.error ? <p className={p.error} role="alert">{local.error}</p> : null}
            </> : null}
          </Row>
          <Row testId="row-concurrency" name="同时跑" action={<Concurrency value={status.settings.maxConcurrent} onPick={(maxConcurrent) => patch({ maxConcurrent })} />}>
            {status.settings.maxConcurrent > MANY_SESSIONS ? <p className={p.warn}>超过 {MANY_SESSIONS} 个，电脑和额度可能吃紧</p> : null}
          </Row>
          <SwitchRow testId="row-auto-merge" name="验收过就合回" checked={status.settings.autoMerge} onChange={(autoMerge) => patch({ autoMerge })} />
          <SwitchRow testId="row-personal-config" name="带上个人配置" checked={status.settings.includePersonalConfigByDefault}
            onChange={(value) => actions.run("settings", () => local.setIncludePersonal(value))} />
        </> : null}
        <Devices me={me} />
      </ul>
      {actions.failed?.key === "settings" || actions.failed?.key.startsWith("folder:") || actions.failed?.key.startsWith("source:") ? <FailedLine reason={actions.failed.reason} onRetry={actions.failed.retry} /> : null}
      {sourceDialog ? <AddSourceDialog source={sourceDialog.source} onClose={() => setSourceDialog(null)} /> : null}
      {tokenHubOpen ? <TokenHubDialog onClose={() => setTokenHubOpen(false)} onConnect={async (apiKey) => { await local.runner.connectTokenHub(apiKey); await local.refresh(); }} /> : null}
    </Section>
  );
}

/* ---------------- 连接的卡片网格（我的 / 可添加） ---------------- */

type LocalTools = { list: TLocalTool[] | null; error: string | null; ready: boolean; reload: () => void };

/** 本人加的工具（存在本机）：本机就绪时读一次；读不到写「失败 · 重试」。 */
function useLocalTools(): LocalTools {
  const local = useLocalRunner();
  const ready = local.phase === "ready";
  const [list, setList] = useState<TLocalTool[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    setError(null);
    void local.runner.listTools().then(setList).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : ""));
  }, [local.runner]);
  useEffect(() => { if (ready) reload(); }, [ready, reload]);
  return { list: ready ? list : null, error: ready ? error : null, ready, reload };
}

const CLI_ICON: Record<"gh" | "lark-cli", ReactNode> = { gh: <GitBranch {...ICON} />, "lark-cli": <Terminal {...ICON} /> };
const toolIcon = (tool: Pick<TLocalTool, "preset">) => (tool.preset === "kingdee" ? <Database {...ICON} /> : <Plug {...ICON} />);

/**
 * 我的连接：本机程序、飞书、本体排在最前（11/09：找不到连飞书和本机的地方），然后 GitHub、飞书命令行、加过的工具（金蝶、其他）。
 * 卡上那一行写状态；连上了右上角 ✓，要处理的放一个动作（配对、重试、连接、重新授权）。
 * 本机、飞书连上以后点卡是一个菜单（断开、重新配对 / 断开）；工具点卡开编辑（名字、地址、钥匙）。
 */
function ConnectionGrid({ me, world, tools }: { me: Me | null; world: WorldRead; tools: LocalTools }) {
  const local = useLocalRunner();
  const actions = useActions();
  const [feishu, setFeishu] = useState<FeishuConnection | null>(null);
  useEffect(() => { void readFeishuConnection().then(setFeishu); }, []);
  const feishuModel = feishuRow(feishu);
  const reconnectFeishu = async () => { window.location.assign(feishuConnectHref(`${window.location.pathname}${window.location.search}`)); };
  const disconnectFeishu = async () => {
    const { error } = await browserApi.DELETE("/api/me/feishu");
    if (error) throw new Error((error as { message?: string }).message ?? "");
    setFeishu(await readFeishuConnection());
  };
  const read = relative(world.state?.readAt, Date.now());
  const cli = local.phase === "ready" && local.status ? local.status.tools.filter(isCliTool) : [];
  return (
    <>
      <CardGrid label="我的连接" testId="connections-mine">
        <ProgramCard me={me} />
        {feishuModel ? (
          <Card testId="card-feishu" icon={<MessageSquare {...ICON} />} name="飞书" source="我的账号" line={<StateLine state={feishuModel.state} />}
            main={feishuModel.action === "unpair" ? (body) => (
              <Dropdown>
                <Dropdown.Trigger className={p.cardMain} aria-label="飞书">{body}</Dropdown.Trigger>
                <Dropdown.Popover placement="bottom start" offset={8} className={h.pop}>
                  <Dropdown.Menu aria-label="飞书" className={h.menuList} onAction={() => actions.run("feishu", disconnectFeishu)}>
                    <Dropdown.Item id="unpair" textValue="断开" className={h.menuItem}>断开</Dropdown.Item>
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown>
            ) : undefined}
            corner={actions.failed?.key === "feishu" ? <FailedLine inline reason={actions.failed.reason} onRetry={actions.failed.retry} />
              : feishuModel.action === "unpair" ? <Added label="已连接" />
              : actions.slot("feishu", feishuModel.action ? LABEL[feishuModel.action] : null, reconnectFeishu)} />
        ) : null}
        <Card testId="card-world" icon={<Boxes {...ICON} />} name="本体" source="公司"
          line={world.state ? <StateLine state={world.state.ok ? "connected" : "disconnected"} detail={world.state.ok ? ["我的能力域", read ? `${read}读过` : null].filter(Boolean).join(" · ") : "本体读取失败"} /> : null}
          corner={!world.state ? null : world.state.ok ? <Added label="已连接" /> : <HeroButton variant="ghost" size="sm" onPress={world.reload}>重试</HeroButton>} />
        {cli.map((tool) => {
          const model = toolRow(tool);
          return (
            <Card key={model.key} testId={`card-${model.key}`} icon={CLI_ICON[tool.kind]} name={model.name} source="本机"
              line={<StateLine state={model.state} detail={model.sub} />} corner={model.state === "connected" ? <Added label="已连接" /> : null} />
          );
        })}
        {(tools.list ?? []).map((tool) => <ToolCard key={tool.id} tool={tool} taken={tools.list ?? []} onDone={tools.reload} />)}
      </CardGrid>
      {tools.error !== null ? <FailedLine reason={tools.error} onRetry={tools.reload} /> : null}
    </>
  );
}

/**
 * 本机程序（原来「这台电脑」组里那一行，做法照旧）：七种状态落到状态词加小字；未配对给「配对」，离线、等浏览器允许、被拦截给「重试」，
 * 暂停给「继续」，没关联云端给「连接」；配好了右上 ✓，点卡是菜单（断开、重新配对）。离线时卡下面是安装命令和「复制」。手机上不连本机，不画。
 * 配对好、还没关联云端的自动关联由 LocalRunnerProvider 一处管；这里只留没关联上、或老关联没记下是谁时的「连接」。
 */
function ProgramCard({ me }: { me: Me | null }) {
  const local = useLocalRunner();
  const handheld = useHandheld();
  const actions = useActions();
  const [linking, setLinking] = useState(false);
  const [copied, setCopied] = useState(false);
  const status = local.status;
  const person: LinkPerson | null = me ? { personId: me.personId, name: me.displayName } : null;
  const program = programRow({ phase: local.phase, status, version: local.version, pairing: local.pairing, error: local.error, linking, install: isMac() ? null : installCommand() });
  if (handheld) return null;
  const work: Record<RowAction, (() => Promise<unknown>) | null> = {
    pair: () => local.pair(),
    retry: () => local.refresh(),
    resume: async () => { await local.runner.patchSettings({ paused: false }); await local.refresh(); },
    link: async () => {
      if (!status || !person) return;
      setLinking(true);
      try { await linkCloud(local.runner, status, person); await local.refresh(); } finally { setLinking(false); }
    },
    unpair: () => local.unpair(),
    reauth: null, login: null,
  };
  const repair = async () => { await local.unpair(); await local.pair(); };
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch { /* 手动选中复制 */ }
  };
  const paired = local.phase === "ready";
  const settled = paired && program.action === "unpair";
  return (
    <Card testId="card-program" icon={<Monitor {...ICON} />} name={program.name} source="这台电脑" line={<StateLine state={program.state} detail={program.sub} />}
      main={paired ? (body) => (
        <Dropdown>
          <Dropdown.Trigger className={p.cardMain} aria-label={program.name}>{body}</Dropdown.Trigger>
          <Dropdown.Popover placement="bottom start" offset={8} className={h.pop}>
            <Dropdown.Menu aria-label={program.name} className={h.menuList} onAction={(key) => actions.run("program", key === "repair" ? repair : () => local.unpair())}>
              <Dropdown.Item id="unpair" textValue="断开" className={h.menuItem}>断开</Dropdown.Item>
              <Dropdown.Item id="repair" textValue="重新配对" className={h.menuItem}>重新配对</Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      ) : undefined}
      corner={actions.failed?.key === "program" ? <FailedLine inline reason={actions.failed.reason} onRetry={actions.failed.retry} />
        : settled ? <Added label="已连接" />
        : actions.slot("program", program.action ? LABEL[program.action] : null, program.action ? work[program.action] : null)}>
      {program.command ? (
        <div className={p.command}>
          <code>{program.command}</code>
          <HeroButton variant="ghost" size="sm" isIconOnly title={copied ? "已复制" : "复制"} aria-label="复制" onPress={() => void copy(program.command!)}>{copied ? <Check {...ICON} /> : <Copy {...ICON} />}</HeroButton>
        </div>
      ) : null}
    </Card>
  );
}

/** 一个加过的工具：点卡开编辑。 */
function ToolCard({ tool, taken, onDone }: { tool: TLocalTool; taken: TLocalTool[]; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const model = localToolRow(tool);
  return (
    <>
      <Card testId={model.key} icon={toolIcon(tool)} name={model.name} source={tool.preset === "kingdee" ? "预设 · 本机" : "自己加的 · 本机"}
        line={<StateLine state={model.state} detail={model.sub} />} corner={tool.state === "ready" ? <Added label="已连接" /> : null}
        label={`编辑 ${tool.name}`} openRef={anchor} onOpen={() => setOpen(true)} />
      <ToolForm tool={tool} taken={taken} onDone={onDone} isOpen={open} onOpenChange={setOpen} anchor={anchor} />
    </>
  );
}

/** 可添加的连接：还没加的工具预设（金蝶，地址和钥匙还没定，先写「未连接」、不给动作）和「其他工具」（+ 开添加表单）。本机没就绪时 + 不能点。 */
function AddConnections({ tools }: { tools: LocalTools }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const kingdeeAdded = tools.list?.some((tool) => tool.preset === "kingdee") ?? false;
  return (
    <CardGrid label="可添加的连接" testId="connections-add">
      {kingdeeAdded ? null : <Card testId={KINGDEE_PLACEHOLDER.key} icon={<Database {...ICON} />} name={KINGDEE_PLACEHOLDER.name} source="预设 · 本机" line={<StateLine state={KINGDEE_PLACEHOLDER.state} />} />}
      <Card testId="card-add-tool" icon={<Plug {...ICON} />} name="其他工具" source="本机" label="添加工具" openRef={anchor} onOpen={tools.ready ? () => setOpen(true) : undefined}
        corner={<AddButton label="添加工具" disabled={!tools.ready} onPress={() => setOpen(true)} />} />
      <ToolForm tool={null} taken={tools.list ?? []} onDone={tools.reload} isOpen={open} onOpenChange={setOpen} anchor={anchor} />
    </CardGrid>
  );
}

const URL_OK = /^https?:\/\/\S{1,292}$/;

/** 新工具的 id：字母数字和 -，不和已有的重。 */
function toolId(name: string, taken: TLocalTool[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "tool";
  let id = base;
  for (let n = 2; taken.some((tool) => tool.id === id); n += 1) id = `${base}-${n}`;
  return id;
}

/**
 * 添加、编辑一个工具：站内同一种弹层，挂在卡上，三项（名字、地址、钥匙）。存过钥匙的只显示「已设置」，可以换、可以清掉；
 * 编辑时多一个「移除」（点两下才移除，钥匙一起删）。保存后本机马上查一次，卡上的状态就是查的结果。
 */
function ToolForm({ tool, taken, onDone, isOpen, onOpenChange, anchor }: {
  tool: TLocalTool | null; taken: TLocalTool[]; onDone: () => void; isOpen: boolean; onOpenChange: (open: boolean) => void; anchor: RefObject<HTMLButtonElement | null>;
}) {
  const local = useLocalRunner();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  /** set：存着钥匙、不动；edit：换一把（空着不动）；cleared：清掉。没存过钥匙的直接是 edit。 */
  const [keyMode, setKeyMode] = useState<"set" | "edit" | "cleared">("edit");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    setName(tool?.name ?? ""); setUrl(tool?.url ?? ""); setKey("");
    setKeyMode(tool?.hasKey ? "set" : "edit"); setConfirmRemove(false); setError(null);
  }, [isOpen, tool]);
  const work = async (job: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await job(); onOpenChange(false); onDone(); } catch (reason) { setError(reason instanceof Error ? reason.message : ""); } finally { setBusy(false); }
  };
  const valid = name.trim().length > 0 && URL_OK.test(url.trim());
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || busy) return;
    const body: TLocalToolUpsert = { name: name.trim(), preset: tool?.preset ?? "custom", url: url.trim() };
    if (tool?.keyHeader) body.keyHeader = tool.keyHeader;
    if (keyMode === "cleared") body.apiKey = "";
    else if (keyMode === "edit" && key.trim()) body.apiKey = key.trim();
    void work(() => local.runner.putTool(tool?.id ?? toolId(name, taken), body));
  };
  const remove = () => {
    if (!tool) return;
    if (!confirmRemove) { setConfirmRemove(true); return; }
    void work(() => local.runner.removeTool(tool.id));
  };
  const label = tool ? `编辑 ${tool.name}` : "添加工具";
  return (
    <Popover isOpen={isOpen} onOpenChange={onOpenChange}>
      <Popover.Content triggerRef={anchor} placement="bottom end" offset={8} className={h.pop}>
        <Popover.Dialog aria-label={label} className={p.toolForm}>
          <form onSubmit={submit} className={p.toolFields}>
            <div className={p.field}>
              <label htmlFor="tool-name">名字</label>
              <input id="tool-name" className={p.input} value={name} maxLength={40} autoFocus autoComplete="off" onChange={(event) => setName(event.target.value)} />
            </div>
            <div className={p.field}>
              <label htmlFor="tool-url">地址</label>
              <input id="tool-url" className={p.input} value={url} maxLength={300} inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://"
                onChange={(event) => setUrl(event.target.value)} />
            </div>
            <div className={p.field}>
              <label htmlFor="tool-key">钥匙</label>
              {keyMode === "set" ? (
                <div className={p.keySet}>
                  <span className={p.grow}>已设置</span>
                  <HeroButton variant="ghost" size="sm" onPress={() => { setKeyMode("edit"); window.setTimeout(() => keyField.current?.focus(), 0); }}>换</HeroButton>
                  <HeroButton variant="ghost" size="sm" onPress={() => setKeyMode("cleared")}>清掉</HeroButton>
                </div>
              ) : keyMode === "cleared" ? (
                <div className={p.keySet}><span className={p.grow} data-faint>已清掉</span></div>
              ) : (
                <input id="tool-key" ref={keyField} className={p.input} type="password" value={key} maxLength={2000} autoComplete="off" spellCheck={false}
                  onChange={(event) => setKey(event.target.value)} />
              )}
            </div>
            {error !== null ? <p className={p.error} role="alert">{error || "没存上"}</p> : null}
            <div className={p.toolFoot}>
              {tool ? <HeroButton variant={confirmRemove ? "danger" : "ghost"} size="sm" isDisabled={busy} onPress={remove}>{confirmRemove ? "确认移除" : "移除"}</HeroButton> : null}
              <span className={p.grow} />
              <HeroButton variant="primary" size="sm" type="submit" isDisabled={busy || !valid}>{tool ? "保存" : "添加"}</HeroButton>
            </div>
          </form>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

/** 同时跑几个（不设上限，默认 3）：可选 1–10、12、15、20，眼下的数不在里面时也列上；中性 chip 触发弹层，当前那项行尾一个勾。 */
const CONCURRENCY = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20];
function Concurrency({ value, onPick }: { value: number; onPick: (value: number) => void }) {
  return (
    <Dropdown>
      <Dropdown.Trigger className={p.pick} aria-label={`同时跑 ${value} 个`}>{value} 个<ChevronDown {...ICON} /></Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end" offset={8} className={h.pop}>
        <Dropdown.Menu aria-label="同时跑几个" className={h.menuList} onAction={(key) => onPick(Number(key))}>
          {[...new Set([...CONCURRENCY, value])].sort((a, b) => a - b).map((n) => (
            <Dropdown.Item key={n} id={String(n)} textValue={`${n} 个`} className={h.menuItem}><span className={h.grow}>{n} 个</span>{n === value ? <Check {...ICON} /> : null}</Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/**
 * 我的几台电脑（云端的设备令牌）：名字、「这台」、版本和上次同步；「断开」= 吊销这台的令牌。
 * 断开的正好是这台时当场重新关联（这台电脑拿一把新令牌，被断开的那一行留着写「已断开」）；断开过的不再有按钮。
 * alone：本机没就绪时自己带「这台电脑」的组标题，没有电脑就什么都不画。
 */
function Devices({ me, alone }: { me: Me | null; alone?: boolean }) {
  const local = useLocalRunner();
  const actions = useActions();
  const [devices, setDevices] = useState<TLocalDeviceView[] | null>(null);
  const [revoked, setRevoked] = useState<TLocalDeviceView[]>([]);
  const load = useCallback(() => {
    void listDevices().then((list) => {
      setDevices(list);
      setRevoked((gone) => gone.filter((device) => !list.some((entry) => entry.id === device.id)));
    }).catch(() => setDevices([]));
  }, []);
  useEffect(load, [load, local.status?.cloud.linked]);
  const rows = [...(devices ?? []), ...revoked.filter((device) => !devices?.some((entry) => entry.id === device.id))];
  const here = local.status?.deviceId ?? null;
  const now = Date.now();
  const revoke = (device: TLocalDeviceView) => actions.run(`device:${device.id}`, async () => {
    await revokeDevice(device.id);
    setRevoked((gone) => [...gone, device]);
    if (device.id === here && local.status && me) { await linkCloud(local.runner, local.status, { personId: me.personId, name: me.displayName }).catch(() => undefined); await local.refresh(); load(); }
  });
  const list = rows.map((device) => {
    const gone = revoked.some((entry) => entry.id === device.id);
    const synced = relative(device.lastSyncAt, now);
    const sub = gone ? "已断开" : [device.appVersion ? `v${device.appVersion}` : null, synced ? `${synced}同步` : null].filter(Boolean).join(" · ") || null;
    return (
      <Row key={device.id} testId="row-device" name={device.name} tag={device.id === here ? "这台" : undefined} sub={sub}
        action={gone ? null : actions.slot(`device:${device.id}`, "断开", async () => revoke(device))} />
    );
  });
  if (!alone) return <>{list}</>;
  return rows.length ? <Section title="这台电脑" testId="group-computer"><ul className={p.rows}>{list}</ul></Section> : null;
}

/* ---------------- 我的账号 ---------------- */

function MyAccounts({ me }: { me: Me | null }) {
  const actions = useActions();
  const [wechat, setWechat] = useState<WechatConnection | null>(null);
  const [tokens, setTokens] = useState<TokenLike[] | null>(null);
  const [open, setOpen] = useState<"mcp" | "wechat" | null>(null);
  const loadTokens = useCallback(() => { void browserApi.GET("/api/me/tokens").then(({ data }) => setTokens(data?.tokens ?? [])).catch(() => setTokens([])); }, []);
  useEffect(() => {
    void readWechatConnection().then(setWechat);
    loadTokens();
  }, [loadTokens]);
  const now = Date.now();
  const mcp = mcpRow(tokens, now);
  const toggle = (key: "mcp" | "wechat") => { setOpen((current) => (current === key ? null : key)); if (key === "mcp" && open === "mcp") loadTokens(); };
  const wechatState = wechat ? (wechat.state === "connected" ? "connected" : wechat.state === "stale" ? "expired" : "disconnected") : null;
  return (
    <Section title="我的账号" testId="group-account">
      <ul className={p.rows}>
        {wechat && wechatState ? (
          <Row testId="row-wechat" name="微信" state={wechatState}
            sub={wechat.state === "connected" && wechat.paused ? "推送暂停中" : null}
            action={wechat.state === "connected"
              ? actions.slot("wechat", "断开", async () => { await browserApi.DELETE("/api/me/wechat"); setWechat({ state: "none" }); })
              : <HeroButton variant="tertiary" size="sm" aria-expanded={open === "wechat"} onPress={() => toggle("wechat")}>{open === "wechat" ? "收起" : "连接"}</HeroButton>}>
            {open === "wechat" && wechat.state !== "connected" ? <div className={p.panel}><WechatConnectPanel onChange={setWechat} /></div> : null}
          </Row>
        ) : null}
        <Row testId="row-mcp" name={mcp.name} sub={mcp.sub} state={tokens ? mcp.state : null}
          action={<HeroButton variant="tertiary" size="sm" aria-expanded={open === "mcp"} onPress={() => toggle("mcp")}>{open === "mcp" ? "收起" : mcp.state === "connected" ? "管理" : "连接"}</HeroButton>}>
          {open === "mcp" ? <div className={p.panel}><ConnectionDialog role={me?.role ?? "member"} /></div> : null}
        </Row>
      </ul>
    </Section>
  );
}

/** 本体（我的能力域）：读一次本人的计划（本体里的 Mission）；读到了写「我的能力域 · 刚刚读过」，读不到写「本体读取失败」加「重试」。 */
type WorldState = { ok: boolean; readAt: string | null } | null;
type WorldRead = { state: WorldState; reload: () => void };
export function useWorldRead(): WorldRead {
  const [state, setState] = useState<WorldState>(null);
  const load = useCallback(() => {
    setState(null);
    void browserApi.GET("/api/me/home-plan").then(({ data }) => {
      const times = (data?.missions ?? []).map((mission) => mission.world?.readAt).filter((at): at is string => !!at).sort();
      setState(data ? { ok: true, readAt: times.at(-1) ?? null } : { ok: false, readAt: null });
    }).catch(() => setState({ ok: false, readAt: null }));
  }, []);
  useEffect(load, [load]);
  return { state, reload: load };
}

/* ---------------- 公司 ---------------- */

/** 公司：管理员配的，成员只看状态，没有动作。公司本体看本人能不能读到计划；飞书应用看这套天枢接没接飞书。 */
function Company({ world: state }: { world: WorldState }) {
  const [feishu, setFeishu] = useState<boolean | null>(null);
  useEffect(() => { void readFeishuConnection().then((value) => setFeishu(value.enabled)); }, []);
  return (
    <Section title="公司" testId="group-company">
      <ul className={p.rows}>
        <Row testId="row-company-world" name="公司本体" state={state ? (state.ok ? "connected" : "disconnected") : null} />
        <Row testId="row-feishu-app" name="飞书应用" state={feishu === null ? null : feishu ? "connected" : "disconnected"} />
      </ul>
    </Section>
  );
}
