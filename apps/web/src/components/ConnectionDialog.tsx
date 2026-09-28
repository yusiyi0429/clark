"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { Button } from "ts-design/primitives";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";
import { useConfirm } from "@/components/ConfirmDialog";
import { monthDayTime } from "@/lib/companyTime";
import { GUIDE_FILE_NAME, SYNC_INSTRUCTION, clientName, connectCommands, connectionGuide, syncCommand } from "@/lib/connectionGuide";
import f from "@/components/onboarding/foundation.module.css";
import s from "@/styles/connection-dialog.module.css";

type TokenView = components["schemas"]["PersonalTokenView"];
type Created = components["schemas"]["CreatePersonalTokenResponse"];
const when = (date: string | null) => date ? monthDayTime(date) : "不过期";

/** 连接到外部工具：主路径是下载一份说明文件发给自己的 Codex、Claude Code 或其他 AI 工具，由它完成设置；命令行步骤收在「手动设置」里。 */
export function ConnectionDialog() {
  const [tokens, setTokens] = useState<TokenView[]>([]);
  const [created, setCreated] = useState<Created | null>(null);
  const [name, setName] = useState("");
  const [client, setClient] = useState<TokenView["client"]>("codex");
  const [expiresInDays, setExpiresInDays] = useState<30 | 90 | null>(30);
  /** 默认每周五自动同步：写进说明文件，由 Agent 连接时一并设好定时任务。 */
  const [weeklySync, setWeeklySync] = useState(true);
  const [createdWeekly, setCreatedWeekly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const { ask, dialog } = useConfirm();
  useEffect(() => {
    let active = true;
    browserApi.GET("/api/me/tokens").then(({ data, error: failure }) => {
      if (!active) return;
      if (data) setTokens(data.tokens);
      else setError(failure?.message ?? "令牌列表暂时无法读取");
    }).catch(() => { if (active) setError("令牌列表暂时无法读取"); });
    return () => { active = false; };
  }, []);
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true); setError(""); setCreated(null);
    try {
      const { data, error: failure } = await browserApi.POST("/api/me/tokens", { body: { name: name.trim(), client, expiresInDays } });
      if (!data) throw new Error(failure?.message ?? "连接说明没生成，请重试");
      setCreated(data); setCreatedWeekly(weeklySync); setTokens((current) => [data.view, ...current]); setName("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "连接说明没生成，请重试"); }
    finally { setBusy(false); }
  };
  const revoke = async (token: TokenView) => {
    if (!await ask(`撤销「${token.name}」？使用它的工具会立即断开。`, "撤销")) return;
    setBusy(true); setError("");
    try {
      const { response, error: failure } = await browserApi.DELETE("/api/me/tokens/{id}", { params: { path: { id: token.id } } });
      if (response.status !== 204) throw new Error(failure?.message ?? "撤销失败，请重试");
      setTokens((current) => current.filter((item) => item.id !== token.id));
      if (created?.view.id === token.id) setCreated(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "撤销失败，请重试"); }
    finally { setBusy(false); }
  };
  const copy = async (label: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(label); }
    catch { setError("复制失败，请手动选择文本"); }
  };
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const endpoint = `${origin}/mcp/me`;
  const activeCount = tokens.filter((token) => !token.expiresAt || Date.parse(token.expiresAt) > Date.now()).length;
  const download = () => {
    if (!created) return;
    const text = connectionGuide({ client: created.view.client, endpoint, token: created.token, expires: when(created.view.expiresAt), weeklySync: createdWeekly });
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = GUIDE_FILE_NAME;
    document.body.append(link); link.click(); link.remove();
    URL.revokeObjectURL(url);
  };
  const commandBlock = (label: string, value: string) => <div key={label} className={s.commandBlock}><strong>{label}</strong><div className={s.command}><code>{value}</code><button type="button" onClick={() => void copy(label, value)}>复制</button></div></div>;
  return <div className={s.root}>
    <p className={s.lead}>让你自己用的 AI 工具（Codex、Claude Code、OpenCode 等）连上天枢：它能读你的执行事项、帮你写进展。</p>
    <section className={s.section} aria-label="连接一个 Agent"><h3>连接一个 Agent</h3>
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
      <button type="button" role="switch" aria-checked={weeklySync} className={s.switchRow} onClick={() => setWeeklySync((value) => !value)}>
        <span className={s.switchText}><strong>每周五 18:00 自动同步进展</strong><span>连接时让 Agent 一并设好定时任务，每周把你的进展写进天枢。</span></span>
        <span className={f.switch} data-on={weeklySync} aria-hidden="true"><span /></span>
      </button>
      <Button variant="primary" isDisabled={busy || !name.trim() || activeCount >= 5} onPress={() => void create()}>生成连接说明</Button>
      {activeCount >= 5 ? <p className={s.muted}>最多保留 5 个连接。可以在下面撤销不用的再生成。</p> : null}
      {created ? <div className={s.ready} aria-label="连接说明已生成">
        <strong>连接说明已生成</strong>
        <p>下载后把文件发给你的 {clientName(created.view.client)}，对它说：「按这个文件帮我连上天枢」。它会自己完成设置，连好后删掉文件。</p>
        {created.view.client === "other" ? <p className={s.muted}>你用的工具要支持远程 MCP（HTTP）；不支持的话，换成 Codex 或 Claude Code。</p> : null}
        <Button variant="primary" onPress={download}><Download size={16} aria-hidden />下载连接说明</Button>
        <p className={s.muted}>文件里有你的连接令牌，只能在这次下载；关掉后要连就重新生成一份。</p>
        <details className={s.manual}><summary>手动设置（熟悉命令行的同事用）</summary>
          <div className={s.manualBody}>
            {commandBlock("令牌", created.token)}
            <p className={s.muted}>连接地址：{endpoint}</p>
            {connectCommands(created.view.client, endpoint, created.token).map(({ label, value }) => commandBlock(label, value))}
            {created.view.client === "codex" ? <p className={s.muted}>存好环境变量后，重新打开终端再添加。</p> : null}
          </div>
        </details>
      </div> : null}
    </section>
    <section className={s.section} aria-label="每周同步进展"><h3>每周同步进展</h3>
      <p className={s.muted}>连上以后，随时对你的 Agent 说「同步本周进展」就行；生成连接说明时打开「每周五自动同步」，它会一并设好定时任务。天枢每周汇总后同步给本体。</p>
      <details className={s.manual}><summary>同步指令和定时命令</summary>
        <div className={s.manualBody}>
          <div className={s.commandBlock}><strong>同步指令</strong><div className={s.command}><code>{SYNC_INSTRUCTION}</code><button type="button" onClick={() => void copy("同步指令", SYNC_INSTRUCTION)}>复制指令</button></div></div>
          {commandBlock("Codex 定时运行", syncCommand("codex"))}
          {commandBlock("Claude Code 定时运行", syncCommand("claude"))}
          <p className={s.muted}>放进系统定时任务（Windows 任务计划程序，macOS / Linux 的 crontab），工作目录设成你常用的项目。</p>
        </div>
      </details>
    </section>
    <section className={s.section}><h3>已连接</h3>
      {tokens.length ? <ul className={s.list}>{tokens.map((token) => <li key={token.id}>
        <div><strong>{token.name}</strong><span>{clientName(token.client)} · 创建 {monthDayTime(token.createdAt)}</span><span>到期 {when(token.expiresAt)} · 最后使用 {token.lastUsedAt ? monthDayTime(token.lastUsedAt) : "尚未使用"}</span></div>
        <Button variant="ghost" isDisabled={busy} onPress={() => void revoke(token)}>撤销</Button>
      </li>)}</ul> : <p className={s.muted}>还没有连接。</p>}
    </section>
    {copied ? <p role="status" className={s.muted}>已复制：{copied}</p> : null}
    {error ? <p role="alert" className={s.error}>{error}</p> : null}
    {dialog}
  </div>;
}
