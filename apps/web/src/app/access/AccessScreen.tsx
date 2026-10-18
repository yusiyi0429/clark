"use client";

import { useEffect, useRef, useState } from "react";
import { TianshuMark } from "@/components/TianshuMark";
import { LockscreenClock } from "./LockscreenVisual";
import { MorningCanvas } from "@/components/onboarding/MorningCanvas";
import { loginDestination } from "@/lib/access-paths";
export { landingPath } from "@/lib/access-paths";
import { PinField, type PinFieldHandle } from "./PinField";
import { clearLastLogin, readLastLogin, rememberLastLogin, type LastLogin } from "./lastLogin";
import { feishuAutoLogin, inFeishuClient } from "@/lib/feishuLogin";
import a from "@/styles/access.module.css";

type Role = "ceo" | "member";
type Stage = { kind: "login" } | { kind: "set"; loginId: string; passcode: string };

/** 登录接口的失败说明：只说发生了什么、接下来怎么办。锁定与改口令的原因由服务端给出原话。 */
export function loginFailureCopy(status: number, serverMessage?: string): string {
  if (status === 401) return "ID 或口令不对";
  if ((status === 423 || status === 400) && serverMessage) return serverMessage;
  if (status === 429) return "尝试次数过多，请一分钟后再试";
  if (status === 403) return "请从正式访问地址打开天枢";
  return "暂时无法验证";
}

function navigationDelay() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 150 : 240;
}

type Result = { ok: true; mustChangePasscode: boolean; role?: Role; onboarded?: boolean } | { ok: false; message: string };

async function post(url: string, body: Record<string, string> = {}): Promise<Result> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => null)) as { mustChangePasscode?: boolean; role?: Role; onboarded?: boolean; message?: string } | null;
  if (response.ok) return { ok: true, mustChangePasscode: Boolean(data?.mustChangePasscode), role: data?.role, onboarded: data?.onboarded };
  return { ok: false, message: loginFailureCopy(response.status, data?.message) };
}

/**
 * 锁屏与引导共用晨光画布，解锁只让输入与时钟离场。
 * 天枢是「你的 ID + 4 位口令」：口令输满即提交；初始码登录后原地换成「设置你的 4 位口令」，输两遍。
 * 验证通过后以 replace 进入（不留锁屏历史）。
 */
export function AccessScreen({ nextPath, demoName = null }: { nextPath?: string; demoName?: string | null }) {
  const [stage, setStage] = useState<Stage>({ kind: "login" });
  const [loginId, setLoginId] = useState("");
  const [lastLogin, setLastLogin] = useState<LastLogin | null | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState("");
  const idInput = useRef<HTMLInputElement>(null);
  const pin = useRef<PinFieldHandle>(null);
  const newPin = useRef<PinFieldHandle>(null);
  const confirmPin = useRef<PinFieldHandle>(null);
  const inFlight = useRef(false);
  const busy = submitting || unlocking;

  useEffect(() => {
    setLastLogin(readLastLogin());
  }, []);

  // 在飞书客户端里打开：自动免登；不在飞书里、未配置或失败时照常用 ID + 口令（失败原因写在表单上）。
  useEffect(() => {
    if (!inFeishuClient(navigator.userAgent)) return;
    void run(async () => {
      const result = await feishuAutoLogin();
      if (!result) return;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      await enter(result.role ?? "member", result.onboarded);
    });
    // 只在打开锁屏时尝试一次
  }, []);

  async function run(task: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setError("");
    setSubmitting(true);
    try {
      await task();
    } catch {
      setError("网络连接失败");
      (stage.kind === "login" ? pin : confirmPin).current?.clear();
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  async function enter(role: Role, onboarded?: boolean) {
    setUnlocking(true);
    await new Promise((resolve) => window.setTimeout(resolve, navigationDelay()));
    window.location.replace(loginDestination(role, nextPath, onboarded));
  }

  const login = (passcode: string) =>
    run(async () => {
      const id = (lastLogin?.loginId ?? loginId).trim();
      if (!id) {
        setError("先输入你的 ID");
        pin.current?.clear(false);
        idInput.current?.focus();
        return;
      }
      const result = await post("/api/auth/login", { loginId: id, passcode });
      if (!result.ok) {
        setError(result.message);
        pin.current?.clear();
        return;
      }
      if (result.mustChangePasscode) {
        setStage({ kind: "set", loginId: id, passcode });
        return;
      }
      await rememberLastLogin(id);
      await enter(result.role ?? "member", result.onboarded);
    });

  function choose() {
    setError("");
    confirmPin.current?.focus();
  }

  const confirm = (code: string) =>
    run(async () => {
      if (stage.kind !== "set") return;
      const newPasscode = newPin.current?.value() ?? "";
      if (newPasscode.length !== 4 || code !== newPasscode) {
        setError("两次输入的口令不一致");
        confirmPin.current?.clear();
        return;
      }
      const result = await post("/api/auth/passcode", { loginId: stage.loginId, passcode: stage.passcode, newPasscode: code });
      if (!result.ok) {
        setError(result.message);
        confirmPin.current?.clear();
        newPin.current?.clear();
        return;
      }
      await rememberLastLogin(stage.loginId);
      await enter(result.role ?? "member", result.onboarded);
    });

  // 演示入口：免口令进入演示账号，之后的去向与正常登录一样；不记成「上次登录」，锁屏不留演示账号。
  const enterDemo = () =>
    run(async () => {
      const result = await post("/api/auth/demo");
      if (!result.ok) {
        setError(result.message);
        return;
      }
      await enter(result.role ?? "member", result.onboarded);
    });

  function switchAccount() {
    clearLastLogin();
    setLastLogin(null);
    setLoginId("");
    setError("");
  }

  return (
    <main className={a.shell} data-unlocking={unlocking}>
      <MorningCanvas />

      <div className={a.brand} aria-label="天枢">
        <TianshuMark className={a.brandMark} />
        <span className={a.brandName}>天枢</span>
      </div>

      <section className={a.lockscreen} aria-labelledby="access-title">
        <h1 id="access-title" className={a.srOnly}>
          进入天枢
        </h1>

        <LockscreenClock />

        <form className={a.accessForm} data-error={Boolean(error)} onSubmit={(event) => event.preventDefault()} aria-busy={submitting}>
          {stage.kind === "login" && lastLogin === undefined ? null : stage.kind === "login" ? (
            <>
              {lastLogin ? (
                <div className={a.returningAccount}>
                  <h2 className={a.welcome}>欢迎回来，{lastLogin.displayName}</h2>
                  <p className={a.accountLine}>
                    <span className={a.accountId}>{lastLogin.loginId}</span>
                    <button type="button" className={a.switchAccount} disabled={busy} onClick={switchAccount}>切换账号</button>
                  </p>
                </div>
              ) : (
                <div className={`${a.codeGroup} ${a.narrowGroup}`}>
                  <label className={a.codeLabel} htmlFor="access-id">
                    你的 ID
                  </label>
                  <div className={a.passwordField}>
                    <input
                      ref={idInput}
                      id="access-id"
                      className={a.passwordInput}
                      type="text"
                      value={loginId}
                      autoComplete="username"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      autoFocus
                      disabled={busy}
                      onChange={(event) => {
                        setLoginId(event.target.value);
                        if (error) setError("");
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        const code = pin.current?.value() ?? "";
                        if (code.length === 4) void login(code);
                        else pin.current?.focus();
                      }}
                    />
                  </div>
                </div>
              )}
              <div className={`${a.codeGroup} ${a.narrowGroup}`}>
                <p className={a.codeLabel}>4 位口令</p>
                <PinField
                  key="login"
                  ref={pin}
                  label="口令"
                  autoComplete="current-password"
                  autoFocus={Boolean(lastLogin)}
                  disabled={busy}
                  invalid={Boolean(error)}
                  describedBy={error ? "access-error" : undefined}
                  onComplete={(code) => void login(code)}
                />
              </div>
            </>
          ) : (
            <>
              <p className={a.setHint}>第一次登录，设置你自己的 4 位口令</p>
              <div className={`${a.codeGroup} ${a.narrowGroup}`}>
                <p className={a.codeLabel}>新口令</p>
                <PinField key="new" ref={newPin} label="新口令" autoComplete="new-password" autoFocus disabled={busy} onComplete={choose} />
              </div>
              <div className={`${a.codeGroup} ${a.narrowGroup}`}>
                <p className={a.codeLabel}>再输一遍</p>
                <PinField
                  ref={confirmPin}
                  label="确认口令"
                  autoComplete="new-password"
                  disabled={busy}
                  invalid={Boolean(error)}
                  describedBy={error ? "access-error" : undefined}
                  onComplete={(code) => void confirm(code)}
                />
              </div>
            </>
          )}
          <div className={a.errorSlot} aria-live="polite">
            {submitting ? <p className={a.verifying}>正在确认</p> : null}
            {error ? (
              <p id="access-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </form>
      </section>

      <footer className={a.panelFooter}>
        <span>天枢 · TKOS</span>
      </footer>

      {demoName ? (
        <button type="button" className={a.demoEntry} disabled={busy} onClick={() => void enterDemo()} aria-label={`天枢系统：演示入口，直接进入${demoName}的工作台`}>
          天枢系统
        </button>
      ) : null}

    </main>
  );
}
