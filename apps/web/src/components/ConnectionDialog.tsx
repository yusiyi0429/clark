"use client";

import { useEffect, useState } from "react";
import { Button } from "ts-design/primitives";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";
import { useConfirm } from "@/components/ConfirmDialog";
import { ConnectAgentForm, connectionState, expiryText } from "@/components/ConnectAgentForm";
import { monthDayTime } from "@/lib/companyTime";
import { SYNC_INSTRUCTION, clientName, syncCommand } from "@/lib/connectionGuide";
import s from "@/styles/connection-dialog.module.css";

type TokenView = components["schemas"]["PersonalTokenView"];

/** 连接到外部工具：主路径是下载一份说明文件发给自己的 Codex、Claude Code 或其他 AI 工具，由它完成设置；命令行步骤收在「手动设置」里。 */
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
  const activeCount = tokens.filter((token) => !token.expiresAt || Date.parse(token.expiresAt) > Date.now()).length;
  const commandBlock = (label: string, value: string) => <div key={label} className={s.commandBlock}><strong>{label}</strong><div className={s.command}><code>{value}</code><button type="button" onClick={() => void copy(label, value)}>复制</button></div></div>;
  return <div className={s.root}>
    <p className={s.lead}>{role === "ceo"
      ? "让你自己用的 AI 工具（Codex、Claude Code 等）连上天枢，随时问它：今天有什么要我拍板、某个议题进展如何、这周各战场怎么样。它只能看，拍板、签发、确认仍在天枢里做。"
      : "让你自己用的 AI 工具（Codex、Claude Code、OpenCode 等）连上天枢：它能读你的执行事项、帮你写进展。"}</p>
    <section className={s.section} aria-label="连接一个 Agent"><h3>连接一个 Agent</h3>
      <ConnectAgentForm role={role} activeCount={activeCount} revokedIds={revokedIds}
        onCreated={(view) => setTokens((current) => [view, ...current])}
        onUpdated={(view) => setTokens((current) => current.map((item) => item.id === view.id ? view : item))} />
    </section>
    {role === "member" ? <section className={s.section} aria-label="每周同步进展"><h3>每周同步进展</h3>
      <p className={s.muted}>连上以后，随时对你的 Agent 说「同步本周进展」就行；生成连接说明时打开「每周五自动同步」，它会一并设好定时任务。天枢每周汇总后同步给本体。</p>
      <details className={s.manual}><summary>同步指令和定时命令</summary>
        <div className={s.manualBody}>
          <div className={s.commandBlock}><strong>同步指令</strong><div className={s.command}><code>{SYNC_INSTRUCTION}</code><button type="button" onClick={() => void copy("同步指令", SYNC_INSTRUCTION)}>复制指令</button></div></div>
          {commandBlock("Codex 定时运行", syncCommand("codex"))}
          {commandBlock("Claude Code 定时运行", syncCommand("claude"))}
          <p className={s.muted}>放进系统定时任务（Windows 任务计划程序，macOS 的 LaunchAgent，Linux 的 crontab），工作目录设成你放项目的目录，装着多个仓库的上级目录也行。</p>
        </div>
      </details>
    </section> : null}
    <section className={s.section}><h3>已连接</h3>
      {tokens.length ? <ul className={s.list}>{tokens.map((token) => <li key={token.id}>
        <div><strong>{token.name}</strong><span>{clientName(token.client)} · 创建 {monthDayTime(token.createdAt)}</span><span>到期 {expiryText(token.expiresAt)} · {connectionState(token)}</span></div>
        <Button variant="ghost" isDisabled={busy} onPress={() => void revoke(token)}>撤销</Button>
      </li>)}</ul> : <p className={s.muted}>还没有连接。</p>}
    </section>
    {copied ? <p role="status" className={s.muted}>已复制：{copied}</p> : null}
    {error ? <p role="alert" className={s.error}>{error}</p> : null}
    {dialog}
  </div>;
}
