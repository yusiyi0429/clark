"use client";

/**
 * 连接（个人菜单「连接」，设计 9.5、5.4.6、11.2；「插件」改叫「连接」）：三组，按「在哪」分。每行名字 + 状态词 + 一个动作，不写说明句。
 * - 这台电脑（存在本机）：本机程序（七种状态落到四个状态词，离线时下面是安装命令）、Claude Code（下面是订阅额度和每个窗口的明细）、Codex、TokenHub、
 *   GitHub 和飞书命令行（登没登录、登的是谁）、工具（本人给子会话加的 MCP 服务器，存在本机）、文件夹（添加、移除）、同时跑、验收过就合回、带上个人配置；
 *   再下面是我的几台电脑（断开 = 吊销设备令牌）。
 *   逻辑照插件页（components/local/PluginsPage.tsx）：配对好、没关联云端时自己关联一次；断开的正好是这台时当场重新关联。手机上不连本机，只列电脑。
 * - 我的账号（存在云端）：飞书（连接、断开、重新授权）、微信（这套天枢接了才有）、让外部 AI 读天枢（个人 MCP 令牌，展开是现有的连接表单）、本体（我的能力域）。
 * - 公司：公司本体、飞书应用，只看状态（联网搜索没有能读的状态，先不画）。
 * 动作没成：那一行动作的位置写「失败 · 重试」（原因在 title 里），不弹 toast。
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Check, ChevronDown, Copy, X } from "lucide-react";
import { Dropdown } from "@heroui/react";
import { Popover } from "ts-design/primitives";
import type { TLocalDeviceView, TLocalTool, TLocalToolUpsert } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { ConnectionDialog } from "@/components/ConnectionDialog";
import { WechatConnectPanel, readWechatConnection, type WechatConnection } from "@/components/WechatConnect";
import { installCommand } from "@/components/local/PluginsPage";
import { useHandheld } from "@/components/ui/useHandheld";
import { FailedLine } from "@/components/work/DecisionBox";
import { browserApi } from "@/lib/api/client";
import { listDevices, revokeDevice } from "@/lib/board/cloud";
import { feishuConnectHref, readFeishuConnection, type FeishuConnection } from "@/lib/feishuLogin";
import { usageCells } from "@/lib/home/quota";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { linkCloud, type LinkPerson } from "@/lib/local/link";
import type { SecondaryPageProps } from "./index";
import { KINGDEE_PLACEHOLDER, agentRow, feishuRow, isCliTool, localToolRow, mcpRow, programRow, tokenHubRow, toolRow, type RowAction, type RowModel, type TokenLike } from "./connectionRows";
import { ICON, QuotaBlock, Row, STATE_WORD, Section, SwitchRow, relative, useMe, type Me } from "./parts";
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

export function ConnectionsPage(_props: SecondaryPageProps) {
  const me = useMe();
  const world = useWorldRead();
  return <><ThisComputer me={me} /><MyAccounts me={me} world={world} /><Company world={world.state} /></>;
}

/* ---------------- 这台电脑 ---------------- */

function ThisComputer({ me }: { me: Me | null }) {
  const local = useLocalRunner();
  const handheld = useHandheld();
  const actions = useActions();
  const [linking, setLinking] = useState(false);
  const [copied, setCopied] = useState(false);
  const status = local.status;
  const ready = local.phase === "ready";
  const person: LinkPerson | null = me ? { personId: me.personId, name: me.displayName } : null;
  const now = Date.now();
  // 配对好、还没关联云端的自动关联由 LocalRunnerProvider 一处管；这里只留没关联上、或老关联没记下是谁时的「连接」。

  const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
  const program = programRow({ phase: local.phase, status, version: local.version, pairing: local.pairing, error: local.error, linking, install: installCommand(mac) });
  const programWork: Record<RowAction, (() => Promise<unknown>) | null> = {
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
  const login = async () => { await local.runner.login(); await local.refresh(); };
  const patch = (body: Parameters<typeof local.runner.patchSettings>[0]) => actions.run("settings", async () => { await local.runner.patchSettings(body); await local.refresh(); });
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1600); } catch { /* 手动选中复制 */ }
  };

  // 额度和右栏「用量」同一套数：订阅的挂在 Claude Code、Codex 下面，其余（网关余额、当天花费）挂在 TokenHub 下面。
  const cells = ready ? usageCells(status?.quota ?? [], now) : [];
  const cellsOf = (id: string) => cells.filter((cell) => cell.id === id);
  const gatewayCells = cells.filter((cell) => cell.id !== "claude" && cell.id !== "codex");
  const rowOf = (model: RowModel, children?: ReactNode, work?: (() => Promise<unknown>) | null) => (
    <Row key={model.key} testId={`row-${model.key}`} name={model.name} sub={model.sub} state={model.state}
      action={actions.slot(model.key, model.action ? LABEL[model.action] : null, work ?? null)}>{children}</Row>
  );

  return (
    <Section title="这台电脑" testId="group-computer">
      <ul className={p.rows}>
        {handheld ? null : rowOf(program, program.command ? (
          <div className={p.command}>
            <code>{program.command}</code>
            <HeroButton variant="ghost" size="sm" isIconOnly title={copied ? "已复制" : "复制"} aria-label="复制" onPress={() => void copy(program.command!)}>{copied ? <Check {...ICON} /> : <Copy {...ICON} />}</HeroButton>
          </div>
        ) : null, program.action ? programWork[program.action] : null)}
        {ready && status ? <>
          {status.agents.map((agent) => {
            const own = cellsOf(agent.kind === "claude-code" ? "claude" : "codex");
            return rowOf(agentRow(agent, now, own.some((cell) => cell.value === "用完")), own.length ? own.map((cell) => <QuotaBlock key={cell.id} cell={cell} />) : null, login);
          })}
          {rowOf(tokenHubRow(local.models), gatewayCells.length ? gatewayCells.map((cell) => <QuotaBlock key={cell.id} cell={cell} />) : null)}
          {status.tools.filter(isCliTool).map((tool) => rowOf(toolRow(tool)))}
          <LocalTools />
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
          <Row testId="row-concurrency" name="同时跑" action={<Concurrency value={status.settings.maxConcurrent} onPick={(maxConcurrent) => patch({ maxConcurrent })} />} />
          <SwitchRow testId="row-auto-merge" name="验收过就合回" checked={status.settings.autoMerge} onChange={(autoMerge) => patch({ autoMerge })} />
          <SwitchRow testId="row-personal-config" name="带上个人配置" checked={status.settings.includePersonalConfigByDefault}
            onChange={(value) => actions.run("settings", () => local.setIncludePersonal(value))} />
        </> : null}
        <Devices me={me} />
      </ul>
      {actions.failed?.key === "settings" || actions.failed?.key.startsWith("folder:") ? <FailedLine reason={actions.failed.reason} onRetry={actions.failed.retry} /> : null}
    </Section>
  );
}

/**
 * 工具（9.5 · 11/08）：本人给子会话加的 MCP 服务器，存在本机，钥匙只写不读。一行「工具」带「添加」，下面每个工具一行：名字、小字、状态词、「编辑」。
 * 金蝶没加过时先占一行「未连接」。读不到写「失败 · 重试」，不弹 toast。
 */
function LocalTools() {
  const local = useLocalRunner();
  const [tools, setTools] = useState<TLocalTool[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    void local.runner.listTools().then(setTools).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : ""));
  }, [local.runner]);
  useEffect(load, [load]);
  const rows: { model: RowModel; tool: TLocalTool | null }[] = [
    ...(tools?.some((tool) => tool.preset === "kingdee") ? [] : [{ model: KINGDEE_PLACEHOLDER, tool: null }]),
    ...(tools ?? []).map((tool) => ({ model: localToolRow(tool), tool })),
  ];
  return (
    <Row testId="row-local-tools" name="工具" sub={tools?.length ? `${tools.length} 个` : null}
      action={<ToolForm tool={null} taken={tools ?? []} onDone={load} />}>
      {tools ? rows.map(({ model, tool }) => (
        <div key={model.key} className={p.sub} data-testid={model.key}>
          <b>{model.name}</b>{model.sub ? <span className={p.subText} title={model.sub}>{model.sub}</span> : null}<span className={p.grow} />
          {model.state ? <span className={p.state} data-state={model.state}>{STATE_WORD[model.state]}</span> : null}
          {tool ? <ToolForm tool={tool} taken={tools} onDone={load} /> : null}
        </div>
      )) : null}
      {error !== null ? <FailedLine reason={error} onRetry={load} /> : null}
    </Row>
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
 * 添加、编辑一个工具：站内同一种弹层，三项（名字、地址、钥匙）。存过钥匙的只显示「已设置」，可以换、可以清掉；
 * 编辑时多一个「移除」（点两下才移除，钥匙一起删）。保存后本机马上查一次，列表里的状态词就是查的结果。
 */
function ToolForm({ tool, taken, onDone }: { tool: TLocalTool | null; taken: TLocalTool[]; onDone: () => void }) {
  const local = useLocalRunner();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  /** set：存着钥匙、不动；edit：换一把（空着不动）；cleared：清掉。没存过钥匙的直接是 edit。 */
  const [keyMode, setKeyMode] = useState<"set" | "edit" | "cleared">("edit");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyField = useRef<HTMLInputElement>(null);
  const openChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setName(tool?.name ?? ""); setUrl(tool?.url ?? ""); setKey("");
    setKeyMode(tool?.hasKey ? "set" : "edit"); setConfirmRemove(false); setError(null);
  };
  const work = async (job: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await job(); setOpen(false); onDone(); } catch (reason) { setError(reason instanceof Error ? reason.message : ""); } finally { setBusy(false); }
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
    <Popover isOpen={open} onOpenChange={openChange}>
      <HeroButton variant={tool ? "ghost" : "tertiary"} size="sm" aria-label={label}>{tool ? "编辑" : "添加"}</HeroButton>
      <Popover.Content placement="bottom end" offset={8} className={h.pop}>
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

/** 同时跑几个：中性 chip 触发弹层（1–10），当前那项行尾一个勾。 */
function Concurrency({ value, onPick }: { value: number; onPick: (value: number) => void }) {
  return (
    <Dropdown>
      <Dropdown.Trigger className={p.pick} aria-label={`同时跑 ${value} 个`}>{value} 个<ChevronDown {...ICON} /></Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end" offset={8} className={h.pop}>
        <Dropdown.Menu aria-label="同时跑几个" className={h.menuList} onAction={(key) => onPick(Number(key))}>
          {Array.from({ length: 10 }, (_, index) => index + 1).map((n) => (
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
 */
function Devices({ me }: { me: Me | null }) {
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
  return <>{rows.map((device) => {
    const gone = revoked.some((entry) => entry.id === device.id);
    const synced = relative(device.lastSyncAt, now);
    const sub = gone ? "已断开" : [device.appVersion ? `v${device.appVersion}` : null, synced ? `${synced}同步` : null].filter(Boolean).join(" · ") || null;
    return (
      <Row key={device.id} testId="row-device" name={device.name} tag={device.id === here ? "这台" : undefined} sub={sub}
        action={gone ? null : actions.slot(`device:${device.id}`, "断开", async () => revoke(device))} />
    );
  })}</>;
}

/* ---------------- 我的账号 ---------------- */

function MyAccounts({ me, world }: { me: Me | null; world: WorldRead }) {
  const actions = useActions();
  const [feishu, setFeishu] = useState<FeishuConnection | null>(null);
  const [wechat, setWechat] = useState<WechatConnection | null>(null);
  const [tokens, setTokens] = useState<TokenLike[] | null>(null);
  const [open, setOpen] = useState<"mcp" | "wechat" | null>(null);
  const loadTokens = useCallback(() => { void browserApi.GET("/api/me/tokens").then(({ data }) => setTokens(data?.tokens ?? [])).catch(() => setTokens([])); }, []);
  useEffect(() => {
    void readFeishuConnection().then(setFeishu);
    void readWechatConnection().then(setWechat);
    loadTokens();
  }, [loadTokens]);
  const now = Date.now();
  const feishuModel = feishuRow(feishu);
  const mcp = mcpRow(tokens, now);
  const toggle = (key: "mcp" | "wechat") => { setOpen((current) => (current === key ? null : key)); if (key === "mcp" && open === "mcp") loadTokens(); };
  const reconnectFeishu = async () => { window.location.assign(feishuConnectHref(`${window.location.pathname}${window.location.search}`)); };
  const disconnectFeishu = async () => {
    const { error } = await browserApi.DELETE("/api/me/feishu");
    if (error) throw new Error((error as { message?: string }).message ?? "");
    setFeishu(await readFeishuConnection());
  };
  const wechatState = wechat ? (wechat.state === "connected" ? "connected" : wechat.state === "stale" ? "expired" : "disconnected") : null;
  return (
    <Section title="我的账号" testId="group-account">
      <ul className={p.rows}>
        {feishuModel ? <Row testId="row-feishu" name={feishuModel.name} state={feishuModel.state}
          action={actions.slot("feishu", feishuModel.action ? LABEL[feishuModel.action] : null, feishuModel.action === "unpair" ? disconnectFeishu : reconnectFeishu)} /> : null}
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
        <WorldRow {...world} />
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

function WorldRow({ state, reload }: WorldRead) {
  const read = relative(state?.readAt, Date.now());
  return (
    <Row testId="row-world" name="本体" state={state ? (state.ok ? "connected" : "disconnected") : null}
      sub={!state ? null : state.ok ? ["我的能力域", read ? `${read}读过` : null].filter(Boolean).join(" · ") : "本体读取失败"}
      action={state && !state.ok ? <HeroButton variant="ghost" size="sm" onPress={reload}>重试</HeroButton> : null} />
  );
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
