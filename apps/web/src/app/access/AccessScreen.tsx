"use client";

import { useEffect, useRef, useState } from "react";
import { TianshuMark } from "@/components/TianshuMark";
import { BuddyFigure } from "@/components/onboarding/BuddyCarousel";
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
 * 登录页（新首页设计稿 19 节）：和新首页同一套样子，一列居中。上面是小号的天枢标志；
 * 这台电脑登录过就请出他的伙伴和名字、只输口令，旁边一个「换个人」；不认得时是「你的 ID」加 4 个口令格。口令输满即提交。
 * 初始码登录后原地换成「设置你的 4 位口令」，输两遍。出错在口令格下一行写原因，口令格轻抖一下。
 * 通过后这一列淡出（约 240ms），以 replace 进入（不留登录页历史）。深色跟着外观走（外壳带 data-scheme="auto"）。
 */
export function AccessScreen({ nextPath, demoName = null }: { nextPath?: string; demoName?: string | null }) {
  const [stage, setStage] = useState<Stage>({ kind: "login" });
  const [loginId, setLoginId] = useState("");
  const [lastLogin, setLastLogin] = useState<LastLogin | null | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState("");
  /** 每出一次错加一，奇偶换一组同样的抖动，连着错也会再抖。 */
  const [shakes, setShakes] = useState(0);
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
        fail(result.message);
        return;
      }
      await enter(result.role ?? "member", result.onboarded);
    });
    // 只在打开登录页时尝试一次
  }, []);

  function fail(message: string) {
    setError(message);
    setShakes(shakes + 1);
  }

  async function run(task: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setError("");
    setSubmitting(true);
    try {
      await task();
    } catch {
      fail("网络连接失败");
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
        fail("先输入你的 ID");
        pin.current?.clear(false);
        idInput.current?.focus();
        return;
      }
      const result = await post("/api/auth/login", { loginId: id, passcode });
      if (!result.ok) {
        fail(result.message);
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
        fail("两次输入的口令不一致");
        confirmPin.current?.clear();
        return;
      }
      const result = await post("/api/auth/passcode", { loginId: stage.loginId, passcode: stage.passcode, newPasscode: code });
      if (!result.ok) {
        fail(result.message);
        confirmPin.current?.clear();
        newPin.current?.clear();
        return;
      }
      await rememberLastLogin(stage.loginId);
      await enter(result.role ?? "member", result.onboarded);
    });

  // 演示入口：免口令进入演示账号，之后的去向与正常登录一样；不记成「上次登录」，登录页不留演示账号。
  const enterDemo = () =>
    run(async () => {
      const result = await post("/api/auth/demo");
      if (!result.ok) {
        fail(result.message);
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

  const errorProps = { invalid: Boolean(error), describedBy: error ? "access-error" : undefined };
  const shake = shakes ? (shakes % 2 ? "a" : "b") : undefined;

  return (
    <main className={a.shell} data-unlocking={unlocking} data-scheme="auto">
      <section className={a.column} aria-labelledby="access-title" aria-busy={submitting}>
        <h1 id="access-title" className={a.srOnly}>
          进入天枢
        </h1>
        <TianshuMark className={a.mark} />

        <form className={a.form} onSubmit={(event) => event.preventDefault()}>
          {stage.kind === "login" && lastLogin === undefined ? null : stage.kind === "login" ? (
            <>
              {lastLogin ? (
                <div className={a.returning}>
                  {lastLogin.buddy ? (
                    <div className={a.buddy}>
                      <BuddyFigure size="hero" skin={lastLogin.buddy.form} name={lastLogin.buddy.name} pose="idle" level={0} />
                    </div>
                  ) : null}
                  <p className={a.person}>
                    <span className={a.personName}>{lastLogin.displayName}</span>
                    <button type="button" className={a.switchAccount} disabled={busy} onClick={switchAccount}>换个人</button>
                  </p>
                </div>
              ) : (
                <input
                  ref={idInput}
                  id="access-id"
                  className={a.idInput}
                  type="text"
                  value={loginId}
                  placeholder="你的 ID"
                  aria-label="你的 ID"
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
              )}
              <div className={a.pin} data-shake={shake}>
                <PinField key="login" ref={pin} label="口令" autoComplete="current-password" autoFocus={Boolean(lastLogin)} disabled={busy}
                  {...errorProps} onComplete={(code) => void login(code)} />
              </div>
            </>
          ) : (
            <>
              <h2 className={a.setTitle}>设置你的 4 位口令</h2>
              <div className={a.group}>
                <p className={a.label}>新口令</p>
                <PinField key="new" ref={newPin} label="新口令" autoComplete="new-password" autoFocus disabled={busy} onComplete={choose} />
              </div>
              <div className={a.group}>
                <p className={a.label}>再输一遍</p>
                <div className={a.pin} data-shake={shake}>
                  <PinField ref={confirmPin} label="确认口令" autoComplete="new-password" disabled={busy} {...errorProps} onComplete={(code) => void confirm(code)} />
                </div>
              </div>
            </>
          )}
          <div className={a.errorSlot} aria-live="polite">
            {error ? (
              <p id="access-error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </form>
      </section>

      {demoName ? (
        <button type="button" className={a.demoEntry} disabled={busy} onClick={() => void enterDemo()} aria-label={`天枢系统：演示入口，直接进入${demoName}的工作台`}>
          天枢系统
        </button>
      ) : null}
    </main>
  );
}
