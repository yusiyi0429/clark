"use client";

/**
 * 本机采集器的授权开关（D-02）：上手流程里本人同意上传会话，天枢才收采集器的工作段、整理成进展。
 * 读写 /api/me/collector/consent；点了先翻开关，没存成功翻回去。样式沿用连接表单里的开关行。
 */
import { useEffect, useState } from "react";
import { browserApi } from "@/lib/api/client";
import f from "./foundation.module.css";
import w from "./welcome.module.css";
import s from "@/styles/connection-dialog.module.css";

export function CollectorConsentSwitch() {
  const [granted, setGranted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void browserApi.GET("/api/me/collector/consent").then(({ data }) => { if (alive && data) setGranted(data.consent.granted); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const toggle = async () => {
    if (granted === null || busy) return;
    const next = !granted;
    setGranted(next); setBusy(true); setError("");
    try {
      const { data } = await browserApi.PUT("/api/me/collector/consent", { body: { granted: next } });
      if (!data) throw new Error("save failed");
      setGranted(data.consent.granted);
    } catch {
      setGranted(!next);
      setError("没有存上，请再试一次");
    } finally { setBusy(false); }
  };
  return <>
    <button type="button" role="switch" aria-checked={granted ?? false} className={s.switchRow} disabled={granted === null || busy} onClick={() => void toggle()}>
      <span className={s.switchText}><strong>上传会话用于整理进展</strong></span>
      <span className={f.switch} data-on={granted ?? false} aria-hidden="true"><span /></span>
    </button>
    {error ? <p className={w.error} role="alert">{error}</p> : null}
  </>;
}
