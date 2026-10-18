"use client";

/**
 * 个人菜单：通知栏左下角点自己的名字（收起成窄条时是头像）弹出。本人能改的设置都收在这里 ——
 * 声纹（已配置时）、雷达、我的记忆（成员 /me/memory、CEO /memory）、Co-Agent 形象、修改口令、重看首次引导；双身份者还能切换工作台。
 * CEO 多一项组织配置，管理员多一项管理员视图；最后是退出登录。
 * 声纹、雷达和口令各开一个小弹窗，不离开当前页面。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Modal, Popover } from "ts-design/primitives";
import { TianshuPortalTheme } from "ts-design";
import { Activity, ArrowLeftRight, ArrowRight, AudioLines, Brain, KeyRound, LogOut, PlugZap, Radar, RotateCcw, Settings2, Smile, X } from "lucide-react";
import { browserApi } from "@/lib/api/client";
import { logout } from "@/lib/logout";
import { VoiceprintCard } from "@/components/member/VoiceprintCard";
import { RadarSettingsEditor } from "@/components/radar/RadarSettingsEditor";
import m from "@/styles/account-menu.module.css";
import { ConnectionDialog } from "@/components/ConnectionDialog";
import { CoAgentSkinPicker } from "@/components/coagent/SkinPicker";

export interface Account {
  displayName: string;
  loginId?: string;
  role: "ceo" | "member";
}

/** 头像上的一个字：三个字的名字写名里的第一个字（刘明华 → 明），两个字的写头一个（clark `initials`）。 */
export function avatarInitial(name: string): string {
  const chars = [...name];
  if (!/\p{Script=Han}/u.test(name)) return chars.slice(0, 1).join("").toUpperCase();
  // 「一号位」这类称谓不是人名：写头一个字（一），不写「号」。
  if (/^.号位$/u.test(name)) return chars[0];
  return chars.length >= 3 ? chars[1] : chars[0];
}

/** 菜单里名字下面那行小字。演示环境只给一号位用：不露登录 ID（democeo），名字本身已是身份，不再重复。 */
export function accountSubtitle(account: Account, demo: boolean): string {
  if (demo) return "";
  return [account.loginId, account.role === "ceo" ? "CEO" : "成员"].filter(Boolean).join(" · ");
}

type Dialog = "voiceprint" | "radar" | "connection" | "coagent" | "passcode" | null;

export function AccountMenu({ account, compact = false, onNavigate }: { account: Account; compact?: boolean; onNavigate?: (href: string) => void }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [leaving, setLeaving] = useState(false);
  const [leaveArmed, setLeaveArmed] = useState(false);
  const [canSwitchView, setCanSwitchView] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [voiceConfigured, setVoiceConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const radarTitle = account.role === "ceo" ? "雷达设置" : "我的雷达";
  const trigger = useRef<HTMLButtonElement>(null);
  // 通知上的「授权开始」要打开「连接到外部工具」；页面上可能同时挂着手机版和桌面版两份菜单，只让看得见的那份接。
  useEffect(() => {
    const openConnection = (event: Event) => {
      if (event.defaultPrevented || !trigger.current || trigger.current.offsetParent === null) return;
      event.preventDefault();
      setOpen(false);
      setDialog("connection");
    };
    window.addEventListener("open-connection-dialog", openConnection);
    return () => window.removeEventListener("open-connection-dialog", openConnection);
  }, []);
  const openMenu = (next: boolean) => {
    setOpen(next);
    setLeaveArmed(false);
    if (!next) return;
    setError(null);
    void Promise.all([browserApi.GET("/api/auth/session"), browserApi.GET("/api/me/voiceprint")]).then(([session, voiceprint]) => {
      setCanSwitchView(Boolean(session.response.ok && session.data?.authenticated && session.data.canSwitchView));
      setAdmin(Boolean(session.response.ok && session.data?.authenticated && session.data.admin));
      setVoiceConfigured(Boolean(voiceprint.response.ok && voiceprint.data?.configured));
    }).catch(() => setError("个人设置暂时无法读取，请重试。"));
  };
  const switchView = async () => {
    const view = account.role === "ceo" ? "member" : "ceo";
    setBusy(true);
    setError(null);
    try {
      const { response } = await browserApi.POST("/api/auth/view", { body: { view } });
      if (!response.ok) throw new Error("switch failed");
      window.location.assign(view === "ceo" ? "/" : "/me");
    } catch {
      setError("切换工作台失败，请重试。");
      setBusy(false);
    }
  };
  const replayOnboarding = async () => {
    setBusy(true);
    setError(null);
    try {
      const { response } = await browserApi.DELETE("/api/me/onboarding/complete");
      if (!response.ok) throw new Error("reset failed");
      window.location.assign("/welcome");
    } catch {
      setError("首次引导暂时无法重看，请重试。");
      setBusy(false);
    }
  };
  const pick = (next: Dialog) => {
    setOpen(false);
    setDialog(next);
  };

  return (
    <>
      <Popover isOpen={open} onOpenChange={openMenu}>
        <Button ref={trigger} variant="ghost" className={compact ? m.avatarButton : m.chip} aria-label={`${account.displayName}，打开个人菜单`} data-account-menu>
          <span className={m.avatar} aria-hidden="true">
            {avatarInitial(account.displayName)}
          </span>
          {compact ? null : <span className={m.name}>{account.displayName}</span>}
        </Button>
        <Popover.Content placement={compact ? "right bottom" : "top start"} offset={10} className={m.popover}>
          <TianshuPortalTheme>
            <Popover.Dialog className={m.menu} aria-label="个人菜单">
              <div className={m.who}>
                <span className={m.avatarLarge} aria-hidden="true">
                  {avatarInitial(account.displayName)}
                </span>
                <span>
                  <strong>{account.displayName}</strong>
                  {accountSubtitle(account, false) ? <small>{accountSubtitle(account, false)}</small> : null}
                </span>
              </div>
              {voiceConfigured ? <Button variant="ghost" className={m.item} onPress={() => pick("voiceprint")}>
                <AudioLines size={16} aria-hidden="true" />
                我的声纹
              </Button> : null}
              <Button variant="ghost" className={m.item} onPress={() => pick("radar")}>
                <Radar size={16} aria-hidden="true" />
                {radarTitle}
              </Button>
              {onNavigate ? (
                <Button variant="ghost" className={m.item} onPress={() => { setOpen(false); onNavigate(account.role === "ceo" ? "/memory" : "/me/memory"); }}>
                  <Brain size={16} aria-hidden="true" />
                  我的记忆
                </Button>
              ) : null}
              <Button variant="ghost" className={m.item} onPress={() => pick("connection")}>
                <PlugZap size={16} aria-hidden="true" />连接到外部工具
              </Button>
              <Button variant="ghost" className={m.item} onPress={() => pick("coagent")}>
                <Smile size={16} aria-hidden="true" />
                Co-Agent 形象
              </Button>
              <Button variant="ghost" className={m.item} onPress={() => pick("passcode")}>
                <KeyRound size={16} aria-hidden="true" />
                修改口令
              </Button>
              {account.role === "ceo" && onNavigate ? (
                <Button
                  variant="ghost"
                  className={m.item}
                  onPress={() => {
                    setOpen(false);
                    onNavigate("/config");
                  }}
                >
                  <Settings2 size={16} aria-hidden="true" />
                  组织配置
                </Button>
              ) : null}
              {admin && onNavigate ? (
                <Button variant="ghost" className={m.item} onPress={() => { setOpen(false); onNavigate(account.role === "ceo" ? "/admin" : "/me/admin"); }}>
                  <Activity size={16} aria-hidden="true" />
                  管理员
                </Button>
              ) : null}
              {canSwitchView ? <Button variant="ghost" className={m.item} isDisabled={busy} onPress={() => void switchView()}>
                <ArrowLeftRight size={16} aria-hidden="true" />
                {account.role === "ceo" ? "切换到负责人工作台" : "切换到 CEO 工作台"}
              </Button> : null}
              <Button variant="ghost" className={m.item} isDisabled={busy} onPress={() => void replayOnboarding()}>
                <RotateCcw size={16} aria-hidden="true" />
                重看首次引导
              </Button>
              {error ? <p className={m.error} role="alert">{error}</p> : null}
              <hr className={m.rule} />
              <Button
                variant="ghost"
                className={m.item}
                data-quiet
                isDisabled={leaving}
                onPress={() => {
                  setLeaving(true);
                  void logout();
                }}
              >
                <LogOut size={16} aria-hidden="true" />
                {leaveArmed ? "再按一次退出登录" : "退出登录"}
              </Button>
            </Popover.Dialog>
          </TianshuPortalTheme>
        </Popover.Content>
      </Popover>
      {dialog === "voiceprint" ? (
        <MenuDialog title="我的声纹" onClose={() => setDialog(null)}>
          <VoiceprintCard />
        </MenuDialog>
      ) : null}
      {dialog === "radar" ? (
        <MenuDialog title={radarTitle} wide onClose={() => setDialog(null)}>
          <RadarSettingsEditor mode={account.role === "ceo" ? "company" : "person"} />
          {account.role === "member" ? (
            <a
              className={m.dialogLink}
              href="/me/radar"
              onClick={(event) => {
                if (!onNavigate) return;
                event.preventDefault();
                setDialog(null);
                onNavigate("/me/radar");
              }}
            >
              看我的雷达信号
              <ArrowRight size={15} aria-hidden="true" />
            </a>
          ) : null}
        </MenuDialog>
      ) : null}
      {dialog === "passcode" ? (
        <MenuDialog title="修改口令" onClose={() => setDialog(null)}>
          <PasscodeForm loginId={account.loginId} onDone={() => setDialog(null)} />
        </MenuDialog>
      ) : null}
      {dialog === "coagent" ? <MenuDialog title="Co-Agent 形象" wide onClose={() => setDialog(null)}><CoAgentSkinPicker /></MenuDialog> : null}
      {dialog === "connection" ? <MenuDialog title="连接到外部工具" wide onClose={() => setDialog(null)}><ConnectionDialog role={account.role} /></MenuDialog> : null}
    </>
  );
}

/** 个人菜单里的小弹窗；雷达设置也从「我的雷达」页头和 CEO 雷达页的「监测范围」打开同一个（wide：内容栏 560px，可滚动）。 */
export function MenuDialog({ title, wide = false, onClose, children }: { title: string; wide?: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <Modal isOpen onOpenChange={(isOpen) => (isOpen ? undefined : onClose())}>
      <Modal.Backdrop className={m.backdrop} isDismissable>
        <Modal.Container size={wide ? "lg" : "md"}>
          <Modal.Dialog className={wide ? `${m.dialog} ${m.wide}` : m.dialog} aria-label={title}>
            <header className={m.dialogHead}>
              <h2>{title}</h2>
              <Button variant="ghost" isIconOnly className={m.close} onPress={onClose} aria-label={`关闭${title}`}>
                <X size={18} aria-hidden="true" />
              </Button>
            </header>
            {children}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

const FOUR_DIGITS = /^\d{4}$/;

/** 版本信息藏在「修改口令」底部（用户 2026-09-30 指定）：Web 与 API 各自的构建版本，一样时只写一个。 */
function BuildVersion() {
  const [text, setText] = useState("");
  useEffect(() => {
    let active = true;
    const sha = (url: string) => fetch(url).then((response) => response.json() as Promise<{ buildSha?: string }>).then((body) => (body.buildSha ?? "").slice(0, 7)).catch(() => "");
    void Promise.all([sha("/healthz"), sha("/api/healthz")]).then(([web, api]) => {
      if (active) setText(web && api && web !== api ? `版本 Web ${web} · API ${api}` : web || api ? `版本 ${web || api}` : "");
    });
    return () => { active = false; };
  }, []);
  return text ? <p className={m.version}>{text}</p> : null;
}

/** 修改口令：当前口令 + 新口令两遍。改好后这台电脑继续登录着，其他设备要用新口令重新登录（会话版本随口令递增）。 */
export function PasscodeForm({ loginId, onDone }: { loginId?: string; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const problem = !FOUR_DIGITS.test(current) || !FOUR_DIGITS.test(next) ? null : next === current ? "新口令不能和当前口令相同" : again && again !== next ? "两次输入的新口令不一致" : null;
  const ready = Boolean(loginId) && FOUR_DIGITS.test(current) && FOUR_DIGITS.test(next) && again === next && next !== current;

  const submit = async () => {
    if (!loginId || !ready) return;
    setBusy(true);
    setError(null);
    const { error: failed, response } = await browserApi.POST("/api/auth/passcode", { body: { loginId, passcode: current, newPasscode: next } });
    setBusy(false);
    if (response.ok) return setDone(true);
    setError(response.status === 401 ? "当前口令不对。" : ((failed as { message?: string } | undefined)?.message ?? "没改成，请重试。"));
  };

  if (done) {
    return (
      <div className={m.form}>
        <p className={m.done}>口令已改好</p>
        <div className={m.formActions}>
          <Button variant="ghost" className={m.primary} onPress={onDone}>
            好的
          </Button>
        </div>
      </div>
    );
  }
  const field = (label: string, value: string, set: (value: string) => void, autoComplete: string) => (
    <label className={m.field}>
      <span>{label}</span>
      <input
        type="password"
        inputMode="numeric"
        autoComplete={autoComplete}
        maxLength={4}
        value={value}
        onChange={(event) => set(event.target.value.replace(/\D/g, "").slice(0, 4))}
      />
    </label>
  );
  return (
    <form
      className={m.form}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {!loginId ? <p className={m.error}>这个账号还没有登录 ID，请联系管理员。</p> : null}
      {field("当前口令", current, setCurrent, "current-password")}
      {field("新口令（4 位数字）", next, setNext, "new-password")}
      {field("再输一次新口令", again, setAgain, "new-password")}
      {problem || error ? (
        <p className={m.error} role="alert">
          {problem ?? error}
        </p>
      ) : null}
      <div className={m.formActions}>
        <Button variant="ghost" className={m.primary} type="submit" isDisabled={!ready || busy}>
          {busy ? "修改中…" : "修改口令"}
        </Button>
      </div>
      <BuildVersion />
    </form>
  );
}
