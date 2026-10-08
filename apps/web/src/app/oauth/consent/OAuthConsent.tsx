"use client";
import { useState } from "react";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";
import { AgentPair, agentKind } from "@/components/AgentPair";
import { clientName } from "@/lib/connectionGuide";
import s from "./consent.module.css";

export function OAuthConsent({ requestId, consent, displayName }: { requestId: string;
  consent: components["schemas"]["OAuthConsentResponse"]; displayName: string }) {
  const [name, setName] = useState(consent.clientName.slice(0, 40));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [returning, setReturning] = useState("");
  const client = agentKind(consent.clientName);
  // 标题用干净的产品名；认不出的工具才用它自报的名字。
  const tool = client === "other" ? consent.clientName : clientName(client);
  const decide = async (allow: boolean) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const { data, error: failure, response } = await browserApi.POST("/api/mcp-oauth/requests/{id}", {
        params: { path: { id: requestId } }, body: { allow, name: name.trim(), csrfToken: consent.csrfToken },
      });
      if (!data) {
        if (response.status === 401) { window.location.assign(`/access?next=${encodeURIComponent(`/oauth/consent?request=${requestId}`)}`); return; }
        throw new Error(failure?.message ?? "授权未完成，请重试");
      }
      if (!allow) { window.location.assign(data.redirect); return; }
      // 先在天枢停留片刻展示连接成功，再交给工具的本机回调页。
      setReturning(data.redirect);
      setTimeout(() => window.location.assign(data.redirect), 1200);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "授权未完成，请重试"); setBusy(false); }
  };
  if (returning) return <main className={s.page}><section className={`${s.sheet} ${s.done}`} aria-labelledby="consent-done">
    <AgentPair client={client} connected />
    <h1 id="consent-done">已连接 {tool}</h1>
    <p role="status" className={s.sub}>正在回到 {tool}…</p>
    <a className={s.quiet} href={returning}>没有跳转？点这里</a>
  </section></main>;
  return <main className={s.page}><section className={s.sheet} aria-labelledby="consent-title">
    <AgentPair client={client} />
    <header className={s.head}>
      <h1 id="consent-title">允许 {tool} 访问你的天枢？</h1>
      <p className={s.sub}>以 {displayName} 的身份连接</p>
    </header>
    <ul className={s.scopes}>
      <li>读取你的事项、任务卡和复盘</li>
      {consent.scopes.includes("tianshu:write") ? <li>记录进展、更新事项、保存草稿</li> : null}
      <li className={s.limit}>不能替你拍板、签发或确认</li>
    </ul>
    <label className={s.field}><span>连接名称</span>
      <input value={name} maxLength={40} placeholder="比如：我的电脑" onChange={(event) => setName(event.target.value)} />
      <small>同名连接会被替换</small></label>
    <div className={s.actions}>
      <button type="button" className={s.allow} disabled={busy || !name.trim()} onClick={() => void decide(true)}>{busy ? "正在连接…" : "允许连接"}</button>
      <button type="button" className={s.cancel} disabled={busy} onClick={() => void decide(false)}>取消</button>
    </div>
    {error ? <p role="alert" className={s.error}>{error}</p> : null}
    <p className={s.foot}>有效期 90 天，可随时在天枢撤销</p>
  </section></main>;
}
