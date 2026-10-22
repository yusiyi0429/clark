"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";
import { useConfirm } from "@/components/ConfirmDialog";
import { ConnectAgentForm, connectionState, expiryText } from "@/components/ConnectAgentForm";
import { DAILY_SYNC_INSTRUCTION, SYNC_INSTRUCTION, syncCommand } from "@/lib/connectionGuide";
import s from "@/styles/connection-dialog.module.css";

type TokenView = components["schemas"]["PersonalTokenView"];

/** 有已连上的工具时，「已连接」居首，连接表单收进折叠；浏览器授权为默认方式，个人令牌备用。 */
export function ConnectionDialog({ role }: { role: "ceo" | "member" }) {
  const [tokens, setTokens] = useState<TokenView[]>([]);
  /** 本次撤销掉的连接；刚生成的那个被撤销时，表单不再给已失效的说明。 */
  const [revokedIds, setRevokedIds] = useState<string[]>([]);
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
  const revoke = async (token: TokenView) => {
    if (!await ask(`撤销「${token.name}」？使用它的工具会立即断开。`, "撤销")) return;
    setBusy(true); setError("");
    try {
      const { response, error: failure } = await browserApi.DELETE("/api/me/tokens/{id}", { params: { path: { id: token.id } } });
      if (response.status !== 204) throw new Error(failure?.message ?? "撤销失败，请重试");
      setTokens((current) => current.filter((item) => item.id !== token.id));
      setRevokedIds((current) => [...current, token.id]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "撤销失败，请重试"); }
    finally { setBusy(false); }
  };
  const copy = async (label: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(label); }
    catch { setError("复制失败，请手动选择文本"); }
  };
  const isActive = (token: TokenView) => !token.expiresAt || Date.parse(token.expiresAt) > Date.now();
  const activeCount = tokens.filter(isActive).length;
  const connected = tokens.filter((token) => isActive(token) && token.lastUsedAt);
  const others = tokens.filter((token) => !connected.includes(token));
  const commandBlock = (label: string, value: string) => <div key={label} className={s.commandBlock}><strong>{label}</strong><div className={s.command}><code>{value}</code><button type="button" onClick={() => void copy(label, value)}>复制</button></div></div>;
  const tokenRow = (token: TokenView) => <li key={token.id}>
    <span><strong>{token.name}</strong> · {isActive(token) ? connectionState(token) : `已过期 ${expiryText(token.expiresAt)}`}</span>
    <Button variant="ghost" className={s.revoke} isDisabled={busy} onPress={() => void revoke(token)}>撤销</Button>
  </li>;
  const form = <ConnectAgentForm role={role} activeCount={activeCount} revokedIds={revokedIds}
    onCreated={(view) => setTokens((current) => [view, ...current])}
    onUpdated={(view) => setTokens((current) => current.map((item) => item.id === view.id ? view : item))} />;
  return <div className={s.root}>
    {connected.length ? <>
      <section className={s.hero} aria-label="已连接">
        <h3 className={s.heroTitle}><span className={s.heroIcon}><Check size={18} strokeWidth={3.2} aria-hidden /></span>已连接</h3>
        <ul className={s.heroList}>{connected.map(tokenRow)}</ul>
      </section>
      <details className={s.more}><summary>连接另一个工具</summary><div className={s.moreBody}>{form}</div></details>
    </> : form}
    {role === "member" ? <details className={s.more}><summary>同步进展</summary>
      <div className={s.manualBody}>
        <div className={s.commandBlock}><strong>同步指令</strong><div className={s.command}><code>{SYNC_INSTRUCTION}</code><button type="button" onClick={() => void copy("同步指令", SYNC_INSTRUCTION)}>复制指令</button></div></div>
        {commandBlock("Codex 每天定时运行", syncCommand("codex", DAILY_SYNC_INSTRUCTION))}
        {commandBlock("Claude Code 每天定时运行", syncCommand("claude", DAILY_SYNC_INSTRUCTION))}
      </div>
    </details> : null}
    {others.length ? <details className={s.more}><summary>未连上 {others.length}</summary>
      <ul className={s.heroList}>{others.map(tokenRow)}</ul>
    </details> : null}
    {copied ? <p role="status" className={s.muted}>已复制：{copied}</p> : null}
    {error ? <p role="alert" className={s.error}>{error}</p> : null}
    {dialog}
  </div>;
}
