"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Download } from "lucide-react";
import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { Button } from "ts-design/primitives";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import { GUIDE_FILE_NAME, clientName, connectCommands, connectionGuide, type AgentClient } from "@/lib/connectionGuide";
import f from "@/components/onboarding/foundation.module.css";
import s from "@/styles/connection-dialog.module.css";
import { OAuthConnectForm } from "./OAuthConnectForm";

type TokenView = components["schemas"]["PersonalTokenView"];
type Created = components["schemas"]["CreatePersonalTokenResponse"];
export const expiryText = (date: string | null) => date ? monthDayTime(date) : "不过期";
/** 连接列表与生成后的状态：写过进展 > 调通过 > 还没连。 */
export const connectionState = (token: TokenView) => token.lastProgressAt ? `最近同步 ${monthDayTime(token.lastProgressAt)}`
  : token.lastUsedAt ? `已连上 · 最近使用 ${monthDayTime(token.lastUsedAt)}` : "等待连接";

/** 生成后等 Agent 第一次调通：每隔一会儿读一次连接列表，连上或被撤销就停；返回停止函数。 */
export function watchFirstUse(id: string, onView: (view: TokenView) => void, intervalMs = 5_000): () => void {
  let stopped = false;
  let timer: number | undefined;
  const tick = async () => {
    try {
      const { data } = await browserApi.GET("/api/me/tokens");
      const view = data?.tokens.find((token) => token.id === id);
      if (data && !view) stopped = true;
      if (view && !stopped) { onView(view); if (view.lastUsedAt) stopped = true; }
    } catch { /* 网络抖动：下一轮再看 */ }
    if (!stopped) timer = window.setTimeout(() => void tick(), intervalMs);
  };
  timer = window.setTimeout(() => void tick(), intervalMs);
  return () => { stopped = true; window.clearTimeout(timer); };
}

/** 连接一个外部工具：填名字、选工具与有效期（成员还有每周同步开关）→ 生成 → 下载说明文件发给自己的 Agent。
 *  设置里的「连接到外部工具」和首次引导共用这一份。 */
export function PersonalTokenForm({ role, defaultName = "", activeCount = 0, revokedIds = [], actionsTarget, onCreated, onUpdated, onDownloaded }: {
  role: "ceo" | "member";
  /** 首次引导：主按钮（生成 → 下载）放进引导底栏的这个位置，和其他步骤的主按钮同一处，不会被挤出可视区。 */
  actionsTarget?: HTMLElement | null;
  /** 本次在列表里撤销掉的连接：刚生成的那个被撤销了，就不再给下载和令牌。 */
  revokedIds?: string[];
  defaultName?: string;
  /** 已有的有效连接数；满 5 个时不能再生成。 */
  activeCount?: number;
  onCreated?: (view: TokenView) => void;
  /** 生成后轮询到这条连接的最新状态（首次调通、写入进展）。 */
  onUpdated?: (view: TokenView) => void;
  onDownloaded?: () => void;
}) {
  const [createdRaw, setCreated] = useState<Created | null>(null);
  const created = createdRaw && !revokedIds.includes(createdRaw.view.id) ? createdRaw : null;
  const [name, setName] = useState(defaultName);
  const [client, setClient] = useState<TokenView["client"]>("codex");
  const [expiresInDays, setExpiresInDays] = useState<30 | 90 | null>(90);
  /** 默认每周五自动同步：写进说明文件，由 Agent 连接时一并设好定时任务。 */
  const [weeklySync, setWeeklySync] = useState(false);
  const [createdWeekly, setCreatedWeekly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  /** 刚生成的这条连接的最新状态；Agent 第一次调通后 lastUsedAt 才有值。 */
  const [live, setLive] = useState<TokenView | null>(null);
  const createdId = created?.view.id;
  useEffect(() => {
    if (!createdId) return;
    return watchFirstUse(createdId, (view) => { setLive(view); onUpdated?.(view); });
    // 只跟着这条连接走；回调变化不重启轮询。
  }, [createdId]);
  const connected = Boolean(created && live?.id === created.view.id && live.lastUsedAt);
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setError(""); setCreated(null);
    try {
      const { data, error: failure } = await browserApi.POST("/api/me/tokens", { body: { name: name.trim(), client, expiresInDays } });
      if (!data) throw new Error(failure?.message ?? "连接说明没生成，请重试");
      setCreated(data); setCreatedWeekly(weeklySync); setName("");
      onCreated?.(data.view);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "连接说明没生成，请重试"); }
    finally { setBusy(false); }
  };
  const copy = async (label: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(label); }
    catch { setError("复制失败，请手动选择文本"); }
  };
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const endpoint = `${origin}/mcp/me`;
  const download = () => {
    if (!created) return;
    const text = connectionGuide({ role, client: created.view.client as AgentClient, endpoint, token: created.token, expires: expiryText(created.view.expiresAt), weeklySync: createdWeekly });
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = GUIDE_FILE_NAME;
    document.body.append(link); link.click(); link.remove();
    URL.revokeObjectURL(url);
    onDownloaded?.();
  };
  const commandBlock = (label: string, value: string) => <div key={label} className={s.commandBlock}><strong>{label}</strong><div className={s.command}><code>{value}</code><button type="button" onClick={() => void copy(label, value)}>复制</button></div></div>;
  return <div className={s.form}>
    <label className={s.nameField}>给这次连接起个名字<input value={name} maxLength={40} placeholder="比如：我的笔记本" onChange={(event) => setName(event.target.value)} /></label>
    <div className={s.choice}><span id="connection-client">你用的是</span>
      <ToggleButtonGroup className={s.segmented} aria-labelledby="connection-client" selectionMode="single" disallowEmptySelection selectedKeys={[client]}
        onSelectionChange={(keys) => { const next = [...keys][0]; if (next === "codex" || next === "claude" || next === "other") setClient(next); }}>
        <ToggleButton id="codex">Codex</ToggleButton><ToggleButton id="claude">Claude Code</ToggleButton><ToggleButton id="other">其他工具</ToggleButton>
      </ToggleButtonGroup>
      {client === "other" ? <p className={s.muted}>OpenCode、Cursor 等支持远程 MCP 的工具。</p> : null}
    </div>
    <div className={s.choice}><span id="connection-expiry">有效期</span>
      <ToggleButtonGroup className={s.segmented} aria-labelledby="connection-expiry" selectionMode="single" disallowEmptySelection selectedKeys={[String(expiresInDays ?? "never")]}
        onSelectionChange={(keys) => { const next = [...keys][0]; setExpiresInDays(next === "never" ? null : Number(next) as 30 | 90); }}>
        <ToggleButton id="30">30 天</ToggleButton><ToggleButton id="90">90 天</ToggleButton><ToggleButton id="never">不过期</ToggleButton>
      </ToggleButtonGroup>
    </div>
    <p className={s.muted}>个人令牌到期后需要重新生成并更新工具设置；开启同步不会延长有效期。</p>
    {role === "member" ? <button type="button" role="switch" aria-checked={weeklySync} className={s.switchRow} onClick={() => setWeeklySync(!weeklySync)}>
      <span className={s.switchText}><strong>每周五 18:00 自动同步进展</strong><span>连接时让 Agent 一并设好定时任务，每周把你的进展写进天枢。</span></span>
      <span className={f.switch} data-on={weeklySync} aria-hidden="true"><span /></span>
    </button> : null}
    {actionsTarget === undefined ? <Button variant="primary" isDisabled={busy || !name.trim() || activeCount >= 5} onPress={() => void create()}>生成连接说明</Button> : null}
    {actionsTarget ? createPortal(created
      ? <button type="button" className={f.primary} onClick={download}>下载连接说明<Download size={18} aria-hidden="true" /></button>
      : <button type="button" className={f.primary} disabled={busy || !name.trim() || activeCount >= 5} onClick={() => void create()}>{busy ? "正在生成…" : "生成连接说明"}{busy ? null : <ArrowRight size={18} aria-hidden="true" />}</button>, actionsTarget) : null}
    {activeCount >= 5 ? <p className={s.muted}>最多保留 5 个连接。可以在个人菜单的「连接到外部工具」里撤销不用的再生成。</p> : null}
    {created ? <div className={s.ready} aria-label="连接说明已生成">
      <strong>连接说明已生成</strong>
      <p>下载后把文件发给你的 {clientName(created.view.client)}，对它说：「按这个文件帮我连上天枢」。它会自己完成设置，连好后删掉文件。</p>
      {created.view.client === "other" ? <p className={s.muted}>你用的工具要支持远程 MCP（HTTP）；不支持的话，换成 Codex 或 Claude Code。</p> : null}
      {actionsTarget === undefined ? <Button variant="primary" onPress={download}><Download size={16} aria-hidden />下载连接说明</Button> : null}
      <p className={s.muted}>文件里有你的连接令牌，只能在这次下载；关掉后要连就重新生成一份。</p>
      <p role="status" className={connected ? s.connected : s.muted}>{connected ? "✓ 已连上天枢" : "等待你的 Agent 连上…（连上后这里会自动变化）"}</p>
      <details className={s.manual}><summary>手动设置（熟悉命令行的同事用）</summary>
        <div className={s.manualBody}>
          {commandBlock("令牌", created.token)}
          <p className={s.muted}>连接地址：{endpoint}</p>
          {connectCommands(created.view.client as AgentClient, endpoint, created.token).map(({ label, value }) => commandBlock(label, value))}
          {created.view.client === "codex" ? <p className={s.muted}>保存后完全退出并重新打开 Codex。</p> : null}
        </div>
      </details>
    </div> : null}
    {copied ? <p role="status" className={s.muted}>已复制：{copied}</p> : null}
    {error ? <p role="alert" className={s.error}>{error}</p> : null}
  </div>;
}

export function ConnectAgentForm(props: Parameters<typeof PersonalTokenForm>[0]) {
  const [personal, setPersonal] = useState(false);
  return <div className={s.form}>
    {personal ? <PersonalTokenForm {...props} /> : <OAuthConnectForm {...props} />}
    <button type="button" className={s.modeSwitch} onClick={() => setPersonal(!personal)}>{personal ? "使用浏览器授权连接" : "使用个人令牌连接（备用）"}</button>
  </div>;
}
