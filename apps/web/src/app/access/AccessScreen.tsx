"use client";

import { useRef, useState } from "react";
import { TianshuMark } from "@/components/TianshuMark";
import { LockscreenBackdrop, LockscreenClock } from "./LockscreenVisual";
import { PinField, type PinFieldHandle } from "./PinField";
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

/** 登录后去哪：成员只去 /me 下的页面；CEO 从 /me 来的回首页，回首页时带入场动画。 */
export function landingPath(role: Role, nextPath: string): string {
  const memberPath = nextPath === "/me" || nextPath.startsWith("/me/");
  if (role === "member") return memberPath ? nextPath : "/me";
  const target = memberPath ? "/" : nextPath;
  return target === "/" ? "/?_entry=unlock" : target;
}

function navigationDelay() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 40 : 520;
}

type Result = { ok: true; mustChangePasscode: boolean; role?: Role } | { ok: false; message: string };

async function post(url: string, body: Record<string, string>): Promise<Result> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => null)) as { mustChangePasscode?: boolean; role?: Role; message?: string } | null;
  if (response.ok) return { ok: true, mustChangePasscode: Boolean(data?.mustChangePasscode), role: data?.role };
  return { ok: false, message: loginFailureCopy(response.status, data?.message) };
}

/**
 * 锁屏（clark `access-screen.tsx` + `access-form.tsx`）：浅蓝壁纸、等高线与闪光、锁形时钟。
 * 天枢是「你的 ID + 4 位口令」：口令输满即提交；初始码登录后原地换成「设置你的 4 位口令」，输两遍。
 * 验证通过后解锁动画 520ms，再以 replace 进入（不留锁屏历史）。
 */
export function AccessScreen({ nextPath }: { nextPath: string }) {
  const [stage, setStage] = useState<Stage>({ kind: "login" });
  const [loginId, setLoginId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState("");
  const idInput = useRef<HTMLInputElement>(null);
  const pin = useRef<PinFieldHandle>(null);
  const newPin = useRef<PinFieldHandle>(null);
  const confirmPin = useRef<PinFieldHandle>(null);
  const chosen = useRef("");
  const inFlight = useRef(false);
  const busy = submitting || unlocking;

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

  async function enter(role: Role) {
    setUnlocking(true);
    await new Promise((resolve) => window.setTimeout(resolve, navigationDelay()));
    window.location.replace(landingPath(role, nextPath));
  }

  const login = (passcode: string) =>
    run(async () => {
      const id = loginId.trim();
      if (!id) {
        setError("先输入你的 ID");
        pin.current?.clear();
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
      await enter(result.role ?? "member");
    });

  function choose(code: string) {
    chosen.current = code;
    setError("");
    confirmPin.current?.focus();
  }

  const confirm = (code: string) =>
    run(async () => {
      if (stage.kind !== "set") return;
      if (code !== chosen.current) {
        setError("两次输入的口令不一致");
        confirmPin.current?.clear();
        return;
      }
      const result = await post("/api/auth/passcode", { loginId: stage.loginId, passcode: stage.passcode, newPasscode: code });
      if (!result.ok) {
        setError(result.message);
        chosen.current = "";
        confirmPin.current?.clear();
        newPin.current?.clear();
        return;
      }
      await enter(result.role ?? "member");
    });

  return (
    <main className={a.shell} data-unlocking={unlocking}>
      <LockscreenBackdrop />

      <div className={a.brand} aria-label="天枢">
        <TianshuMark className={a.brandMark} />
        <span className={a.brandName}>天枢</span>
      </div>

      <section className={a.lockscreen} aria-labelledby="access-title">
        <h1 id="access-title" className={a.srOnly}>
          进入天枢
        </h1>

        <LockscreenClock />

        <form className={a.accessForm} onSubmit={(event) => event.preventDefault()} aria-busy={submitting}>
          {stage.kind === "login" ? (
            <>
              <div className={`${a.codeGroup} ${a.narrowGroup}`}>
                <label className={a.codeLabel} htmlFor="access-id">
                  你的 ID
                </label>
                <div className={`${a.passwordField} ${a.idField}`}>
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
              <div className={`${a.codeGroup} ${a.narrowGroup}`}>
                <p className={a.codeLabel}>4 位口令</p>
                <PinField
                  ref={pin}
                  label="口令"
                  autoComplete="current-password"
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
                <PinField ref={newPin} label="新口令" autoComplete="new-password" autoFocus disabled={busy} onComplete={choose} />
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

      <div className={a.unlockWash} aria-hidden="true" />
    </main>
  );
}
