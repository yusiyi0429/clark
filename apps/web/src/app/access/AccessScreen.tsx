"use client";

import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { TianshuMark } from "@/components/TianshuMark";
import a from "@/styles/access.module.css";

/** 登录入口：只有品牌与口令，没有 seat、DRI 身份或旧空间选择。 */
export function AccessScreen({ nextPath }: { nextPath: string }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const time = now
    ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(now)
    : "--:--";
  const date = now
    ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "long" }).format(now)
    : "";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (response.ok) {
      window.location.assign(nextPath);
      return;
    }
    setBusy(false);
    const body = (await response.json().catch(() => ({}))) as { message?: string; code?: string };
    setError(body.code === "INVALID_CREDENTIALS" ? "口令不正确" : body.message ?? "登录失败");
  }

  return (
    <main className={a.shell}>
      <div className={a.backdrop} data-image-ready="true" aria-hidden="true">
        <div
          className={a.renderStage}
          style={{
            opacity: 1,
            transform: "none",
            background: "url('/brand/tianshu-flow-lock-v2.webp') center 54% / cover no-repeat",
          }}
        />
        <div className={a.depthVeil} />
      </div>

      <div className={a.brand} aria-label="天枢">
        <TianshuMark className={a.brandMark} />
        <span className={a.brandName}>天枢</span>
      </div>

      <section className={a.lockscreen} aria-labelledby="access-title">
        <h1 id="access-title" className={a.srOnly}>
          进入 CEO WarMap
        </h1>
        <div className={a.clockGroup}>
          <div className={a.lockGlyph} aria-hidden="true">
            <Lock size={16} />
          </div>
          <time className={a.clock} dateTime={now?.toISOString()} aria-label={`当前时间 ${time}`}>
            {time}
          </time>
          <p className={a.date}>{date}</p>
        </div>

        <form className={a.accessForm} onSubmit={submit}>
          <div className={a.codeGroup}>
            <label className={a.codeLabel} htmlFor="ceo-password">
              访问口令
            </label>
            <input
              id="ceo-password"
              className={a.passwordField}
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
          <div className={a.errorSlot}>
            {error ? <p role="alert">{error}</p> : null}
          </div>
          <button className={a.unlockButton} type="submit" disabled={busy || !password}>
            {busy ? "验证中…" : "进入 WarMap"}
          </button>
        </form>
      </section>

      <footer className={a.panelFooter}>
        <span>CEO WarMap · 单公司单 CEO 决策驾驶舱</span>
      </footer>
    </main>
  );
}
