"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, SquareTerminal } from "lucide-react";
import { ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { Button } from "ts-design/primitives";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";
import { clientName, oauthConnectionGuide, type AgentClient } from "@/lib/connectionGuide";
import { AgentPair } from "@/components/AgentPair";
import s from "@/styles/connection-dialog.module.css";
import f from "@/components/onboarding/foundation.module.css";

type View = components["schemas"]["PersonalTokenView"];
export function OAuthConnectForm({ role, activeCount = 0, actionsTarget, onCreated, onUpdated, onDownloaded }: {
  role: "ceo" | "member"; activeCount?: number; actionsTarget?: HTMLElement | null;
  onCreated?: (view: View) => void; onUpdated?: (view: View) => void; onDownloaded?: () => void;
}) {
  const [client, setClient] = useState<AgentClient>("codex");
  const [attempt, setAttempt] = useState(0);
  const [endpoint, setEndpoint] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [connected, setConnected] = useState<AgentClient | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const callbacks = useRef({ onCreated, onUpdated });
  callbacks.current = { onCreated, onUpdated };
  const initial = useRef<Set<string> | null>(null);
  const announced = useRef(new Set<string>());
  useEffect(() => {
    let stopped = false;
    void browserApi.GET("/api/me/tokens").then(({ data }) => {
      if (!stopped && data) { initial.current ??= new Set(data.tokens.map((token) => token.id)); if (data.mcpUrl) setEndpoint(data.mcpUrl); }
    }).catch(() => { /* 复制前和轮询时会再次读取。 */ });
    return () => { stopped = true; };
  }, []);
  useEffect(() => {
    if (!attempt) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 10 * 60_000;
    const tick = async () => {
      try {
        const { data } = await browserApi.GET("/api/me/tokens");
        if (stopped) return;
        if (data && initial.current) {
          const view = data.tokens.find((token) => token.authType === "oauth" && !initial.current!.has(token.id));
          if (view) {
            if (!announced.current.has(view.id)) { announced.current.add(view.id); callbacks.current.onCreated?.(view); }
            callbacks.current.onUpdated?.(view);
            if (view.lastUsedAt) { setConnected(view.client); setStatus(""); return; }
            setStatus("已允许连接，等待工具完成验证…");
          }
        } else if (data) initial.current = new Set(data.tokens.map((token) => token.id));
      } catch { /* 下一轮恢复，不能把网络错误显示成连接成功。 */ }
      if (!stopped && Date.now() < deadline) timer = setTimeout(() => void tick(), 5_000);
      else if (!stopped) setStatus("暂未确认连接");
    };
    void tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [attempt]);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const guide = oauthConnectionGuide(role, client, endpoint || `${origin}/mcp/me`);
  const copy = async () => {
    let url = endpoint || `${origin}/mcp/me`;
    if (!initial.current) {
      try {
        const { data } = await browserApi.GET("/api/me/tokens");
        if (data) {
          initial.current ??= new Set(data.tokens.map((token) => token.id));
          if (data.mcpUrl) { url = data.mcpUrl; setEndpoint(url); }
        }
      } catch { /* 步骤仍可复制；网络恢复后再确认连接状态。 */ }
    }
    try { await navigator.clipboard.writeText(oauthConnectionGuide(role, client, url)); setAttempt((value) => value + 1); setError(""); setStatus("已复制，等待连接…"); onDownloaded?.();
      // 按钮上显示「已复制」两秒，再回到原样。
      setCopied(true); clearTimeout(copiedTimer.current); copiedTimer.current = setTimeout(() => setCopied(false), 2000); }
    catch { setError("复制失败，请选择下方步骤手动复制"); }
  };
  // Claude Code 注册了 claude-cli:// 链接：新开终端、把步骤填进输入框，用户按回车才发送。本机没注册时点了没反应，所以复制仍是主路径。
  const launch = () => { setAttempt((value) => value + 1); setError(""); setStatus("已在 Claude Code 中打开"); onDownloaded?.(); };
  const action = actionsTarget === undefined
    ? <Button variant="primary" isDisabled={activeCount >= 5} onPress={() => void copy()}>{copied ? "已复制" : "复制连接步骤"}</Button>
    : actionsTarget ? createPortal(<button type="button" className={f.primary} disabled={activeCount >= 5} onClick={() => void copy()}>{copied ? "已复制" : "复制连接步骤"}</button>, actionsTarget) : null;
  return <div className={s.form}>
    <div className={s.choice}><span id="oauth-client">你用的是</span><ToggleButtonGroup className={s.segmented} aria-labelledby="oauth-client" selectionMode="single" disallowEmptySelection selectedKeys={[client]}
      onSelectionChange={(keys) => { const next = [...keys][0]; if (next === "codex" || next === "claude" || next === "other") setClient(next); }}>
      <ToggleButton id="codex">Codex</ToggleButton><ToggleButton id="claude">Claude Code</ToggleButton><ToggleButton id="other">其他工具</ToggleButton>
    </ToggleButtonGroup></div>
    <div className={s.command}><code>{guide}</code><button type="button" aria-label={copied ? "已复制" : "复制步骤"} title="复制" onClick={() => void copy()}>{copied ? <><Check size={13} aria-hidden />已复制</> : <Copy size={13} aria-hidden />}</button></div>
    {client === "claude" ? <a className={s.launch} href={`claude-cli://open?q=${encodeURIComponent(guide)}`} onClick={launch}><SquareTerminal size={15} aria-hidden />在 Claude Code 中打开</a> : null}
    {action}
    {activeCount >= 5 ? <p className={s.muted}>最多 5 个连接</p> : null}
    {connected ? <div role="status" className={s.connected}><AgentPair client={connected} connected />
      <strong>已连上 {clientName(connected)}</strong></div> : null}
    {status ? <p role="status" className={s.muted}>{status}</p> : null}
    {error ? <p role="alert" className={s.error}>{error}</p> : null}
  </div>;
}
