"use client";

import { useEffect, useState } from "react";
import { Button } from "ts-design/primitives";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";
import { useConfirm } from "@/components/ConfirmDialog";
import { monthDayTime } from "@/lib/companyTime";
import s from "@/styles/connection-dialog.module.css";

type TokenView = components["schemas"]["PersonalTokenView"];
type Created = components["schemas"]["CreatePersonalTokenResponse"];
const when = (date: string | null) => date ? monthDayTime(date) : "不过期";
const clientName = (client: TokenView["client"]) => client === "codex" ? "Codex" : "Claude Code";

export function ConnectionDialog() {
  const [tokens, setTokens] = useState<TokenView[]>([]);
  const [created, setCreated] = useState<Created | null>(null);
  const [name, setName] = useState("");
  const [client, setClient] = useState<TokenView["client"]>("codex");
  const [expiresInDays, setExpiresInDays] = useState<30 | 90 | null>(30);
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
      if (!data) throw new Error(failure?.message ?? "令牌没生成，请重试");
      setCreated(data); setTokens((current) => [data.view, ...current]); setName("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "令牌没生成，请重试"); }
    finally { setBusy(false); }
  };
  const revoke = async (token: TokenView) => {
    if (!await ask(`撤销「${token.name}」？使用它的 Codex 或 Claude Code 会立即断开。`, "撤销令牌")) return;
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
  const commands = created ? [
    { label: "Windows PowerShell", value: `[Environment]::SetEnvironmentVariable("TIANSHU_TOKEN", "${created.token}", "User")` },
    { label: "macOS / Linux", value: `export TIANSHU_TOKEN=${created.token}` },
    { label: "Codex", value: `codex mcp add tianshu --url ${endpoint} --bearer-token-env-var TIANSHU_TOKEN` },
    { label: "Claude Code", value: `claude mcp add --transport http tianshu ${endpoint} --header "Authorization: Bearer ${created.token}"` },
  ] : [];
  return <div className={s.root}>
    <section className={s.section}><h3>已有令牌</h3>
      {tokens.length ? <ul className={s.list}>{tokens.map((token) => <li key={token.id}>
        <div><strong>{token.name}</strong><span>{clientName(token.client)} · 创建 {monthDayTime(token.createdAt)}</span><span>到期 {when(token.expiresAt)} · 最后使用 {token.lastUsedAt ? monthDayTime(token.lastUsedAt) : "尚未使用"}</span></div>
        <Button variant="ghost" isDisabled={busy} onPress={() => void revoke(token)}>撤销</Button>
      </li>)}</ul> : <p className={s.muted}>还没有令牌。</p>}
    </section>
    <section className={s.section}><h3>生成令牌</h3>
      <div className={s.fields}><label>名称<input value={name} maxLength={40} placeholder="我的笔记本" onChange={(event) => setName(event.target.value)} /></label>
        <label>用于<select value={client} onChange={(event) => setClient(event.target.value as TokenView["client"])}><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
        <label>有效期<select value={expiresInDays ?? "never"} onChange={(event) => setExpiresInDays(event.target.value === "never" ? null : Number(event.target.value) as 30 | 90)}><option value={30}>30 天</option><option value={90}>90 天</option><option value="never">不过期</option></select></label></div>
      <Button variant="primary" isDisabled={busy || !name.trim() || activeCount >= 5} onPress={() => void create()}>生成令牌</Button>
      {activeCount >= 5 ? <p className={s.muted}>最多保留 5 个有效令牌。可以撤销不用的再生成。</p> : null}
    </section>
    {created ? <section className={s.section} aria-label="新令牌和连接命令"><h3>新令牌 · 仅显示这一次</h3>
      <p className={s.muted}>关掉后就看不到了。请自行保存，勿放进项目文件。</p>
      <div className={s.command}><code>{created.token}</code><button type="button" onClick={() => void copy("令牌", created.token)}>复制令牌</button></div>
      <p className={s.muted}>连接地址：{endpoint}</p>
      {commands.map(({ label, value }) => <div key={label} className={s.commandBlock}><strong>{label}</strong><div className={s.command}><code>{value}</code><button type="button" onClick={() => void copy(label, value)}>复制</button></div></div>)}
      <p className={s.muted}>Codex 设置环境变量后，重新打开终端再运行添加命令。</p>
      <div className={s.commandBlock}><strong>可放进项目 AGENTS.md 或 CLAUDE.md 的建议</strong><div className={s.command}><code>推进天枢里的执行事项时，开始前用 tianshu 的 list_my_items 找到对应事项；收尾时用 append_progress 写一条进展：做了什么、证据链接、下一步或阻塞；做完用 update_status 标完成。</code><button type="button" onClick={() => void copy("建议", "推进天枢里的执行事项时，开始前用 tianshu 的 list_my_items 找到对应事项；收尾时用 append_progress 写一条进展：做了什么、证据链接、下一步或阻塞；做完用 update_status 标完成。")}>复制</button></div></div>
      {copied ? <p role="status" className={s.muted}>已复制：{copied}</p> : null}
    </section> : null}
    {error ? <p role="alert" className={s.error}>{error}</p> : null}
    {dialog}
  </div>;
}
