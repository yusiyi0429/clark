"use client";

/**
 * 个人菜单：通知栏左下角点自己的名字（收起成窄条时是头像）弹出。一级只放每天会点的和身份相关的（样稿 voice-keys-v3）——
 * 雷达、我的记忆（成员 /me/memory、CEO /memory）、定时任务（成员 /me/schedules、CEO /schedules）、「设置 ›」、CEO 的组织配置、双身份者切换工作台，最后是退出登录。
 * 配一次就不太动的收进「设置 ›」，在菜单右边弹出二级：语音输入、声纹（已配置时）、连接飞书（接了飞书时）、连接微信（接了微信时）、连接到外部工具、本机采集器、伙伴形象、修改口令、
 * 重看首次引导、管理员视图（管理员）。
 * 声纹、雷达、口令、语音输入各开一个小弹窗，不离开当前页面。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Modal, Popover } from "ts-design/primitives";
import { TianshuPortalTheme } from "ts-design";
import { Activity, ArrowLeftRight, ArrowRight, AudioLines, Brain, CalendarClock, ChevronRight, KeyRound, Link2, LogOut, Laptop, MessageCircle, Mic, PlugZap, Radar, RotateCcw, Settings, Settings2, Smile, X } from "lucide-react";
import { browserApi } from "@/lib/api/client";
import { feishuConnectHref, readFeishuConnection } from "@/lib/feishuLogin";
import { logout } from "@/lib/logout";
import { VoiceprintCard } from "@/components/member/VoiceprintCard";
import { RadarSettingsEditor } from "@/components/radar/RadarSettingsEditor";
import m from "@/styles/account-menu.module.css";
import { ConnectionDialog } from "@/components/ConnectionDialog";
import { CoAgentSkinPicker } from "@/components/coagent/SkinPicker";
import { VoiceKeysDialog } from "@/conversation/VoiceKeysDialog";
import { CollectorInstallPanel, useCollectorStatus } from "@/components/onboarding/CollectorSetup";
import { CollectorReview } from "@/components/onboarding/ReviewLists";
import { readTaskQualityEnabled } from "@/components/task-quality/taskQualityStatus";
import { PersonalProfileForm } from "@/components/PersonalProfileForm";
import { WechatConnectPanel, readWechatConnection, type WechatConnection } from "@/components/WechatConnect";

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

type Dialog = "voiceprint" | "radar" | "connection" | "collector" | "coagent" | "passcode" | "voice" | "profile" | "wechat" | null;

export function AccountMenu({ account, compact = false, onNavigate }: { account: Account; compact?: boolean; onNavigate?: (href: string) => void }) {
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [leaving, setLeaving] = useState(false);
  const [leaveArmed, setLeaveArmed] = useState(false);
  const [canSwitchView, setCanSwitchView] = useState(false);
  const [admin, setAdmin] = useState(false);
  const [voiceConfigured, setVoiceConfigured] = useState(false);
  const [feishu, setFeishu] = useState<{ enabled: boolean; connected: boolean } | null>(null);
  const [wechat, setWechat] = useState<WechatConnection | null>(null);
  const [taskQuality, setTaskQuality] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const radarTitle = account.role === "ceo" ? "雷达设置" : "我的雷达";
  const trigger = useRef<HTMLButtonElement>(null);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
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
    setSettingsOpen(false);
    setLeaveArmed(false);
    if (!next) return;
    setError(null);
    void Promise.all([browserApi.GET("/api/auth/session"), browserApi.GET("/api/me/voiceprint")]).then(([session, voiceprint]) => {
      setCanSwitchView(Boolean(session.response.ok && session.data?.authenticated && session.data.canSwitchView));
      setAdmin(Boolean(session.response.ok && session.data?.authenticated && session.data.admin));
      setVoiceConfigured(Boolean(voiceprint.response.ok && voiceprint.data?.configured));
    }).catch(() => setError("个人设置暂时无法读取，请重试。"));
    void readFeishuConnection().then(setFeishu);
    void readWechatConnection().then(setWechat);
    void readTaskQualityEnabled().then(setTaskQuality);
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
    setSettingsOpen(false);
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
              {onNavigate ? (
                <Button variant="ghost" className={m.item} onPress={() => { setOpen(false); onNavigate(account.role === "ceo" ? "/schedules" : "/me/schedules"); }}>
                  <CalendarClock size={16} aria-hidden="true" />
                  定时任务
                </Button>
              ) : null}
              {onNavigate && taskQuality ? <Button variant="ghost" className={m.item} onPress={() => { setOpen(false); onNavigate(account.role === "ceo" ? "/task-quality" : "/me/task-quality"); }}>
                <Activity size={16} aria-hidden="true" />任务数据质量
              </Button> : null}
              <Button ref={settingsTrigger} variant="ghost" className={m.item} data-settings aria-expanded={settingsOpen} onPress={() => setSettingsOpen((value) => !value)}>
                <Settings size={16} aria-hidden="true" />
                设置
                <ChevronRight size={15} className={m.more} aria-hidden="true" />
              </Button>
              <Popover isOpen={settingsOpen} onOpenChange={setSettingsOpen}>
                <Popover.Content triggerRef={settingsTrigger} placement="end top" offset={16} crossOffset={-8} className={m.popover}>
                  <TianshuPortalTheme>
                    <Popover.Dialog className={m.menu} aria-label="设置">
                      <Button variant="ghost" className={m.item} onPress={() => pick("profile")}>
                        <Settings2 size={16} aria-hidden="true" />
                        个人资料
                      </Button>
                      <Button variant="ghost" className={m.item} onPress={() => pick("voice")}>
                        <Mic size={16} aria-hidden="true" />
                        语音输入
                      </Button>
                      {voiceConfigured ? <Button variant="ghost" className={m.item} onPress={() => pick("voiceprint")}>
                        <AudioLines size={16} aria-hidden="true" />
                        我的声纹
                      </Button> : null}
                      {feishu?.enabled ? <FeishuConnectItem connected={feishu.connected} /> : null}
                      {wechat ? <Button variant="ghost" className={m.item} onPress={() => pick("wechat")}>
                        <MessageCircle size={16} aria-hidden="true" />
                        {wechat.state === "connected" ? "微信已连接" : "连接微信"}
                      </Button> : null}
                      <Button variant="ghost" className={m.item} onPress={() => pick("connection")}>
                        <PlugZap size={16} aria-hidden="true" />连接到外部工具
                      </Button>
                      <Button variant="ghost" className={m.item} onPress={() => pick("collector")}>
                        <Laptop size={16} aria-hidden="true" />本机采集器
                      </Button>
                      <Button variant="ghost" className={m.item} onPress={() => pick("coagent")}>
                        <Smile size={16} aria-hidden="true" />
                        伙伴形象
                      </Button>
                      <Button variant="ghost" className={m.item} onPress={() => pick("passcode")}>
                        <KeyRound size={16} aria-hidden="true" />
                        修改口令
                      </Button>
                      <Button variant="ghost" className={m.item} isDisabled={busy} onPress={() => void replayOnboarding()}>
                        <RotateCcw size={16} aria-hidden="true" />
                        重看首次引导
                      </Button>
                      {admin && onNavigate ? (
                        <Button variant="ghost" className={m.item} onPress={() => { setOpen(false); onNavigate(account.role === "ceo" ? "/admin" : "/me/admin"); }}>
                          <Activity size={16} aria-hidden="true" />
                          管理员
                        </Button>
                      ) : null}
                    </Popover.Dialog>
                  </TianshuPortalTheme>
                </Popover.Content>
              </Popover>
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
              {canSwitchView ? <Button variant="ghost" className={m.item} isDisabled={busy} onPress={() => void switchView()}>
                <ArrowLeftRight size={16} aria-hidden="true" />
                {account.role === "ceo" ? "切换到负责人工作台" : "切换到 CEO 工作台"}
              </Button> : null}
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
      {dialog === "profile" ? <MenuDialog title="个人资料" onClose={() => setDialog(null)}><PersonalProfileForm /></MenuDialog> : null}
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
      {dialog === "coagent" ? <MenuDialog title="伙伴形象" wide onClose={() => setDialog(null)}><CoAgentSkinPicker /></MenuDialog> : null}
      {dialog === "voice" ? <VoiceKeysDialog onClose={() => setDialog(null)} /> : null}
      {dialog === "connection" ? <MenuDialog title="连接到外部工具" wide onClose={() => setDialog(null)}><ConnectionDialog role={account.role} /></MenuDialog> : null}
      {dialog === "wechat" ? <MenuDialog title="连接微信" onClose={() => setDialog(null)}><WechatConnectPanel onChange={setWechat} /></MenuDialog> : null}
      {dialog === "collector" ? <MenuDialog title="本机采集器" wide onClose={() => setDialog(null)}><CollectorDialog /></MenuDialog> : null}
    </>
  );
}

/** 个人菜单里的本机采集器：和首次引导同一块安装面板，开着时读状态，令牌只在这次打开里留着；盘点到了，下面确认清单。 */
function CollectorDialog() {
  const [token, setToken] = useState<string | null>(null);
  const status = useCollectorStatus(true);
  const memoryFiles = status?.devices.length && status.consent ? status.inventory.memoryFiles : null;
  return <>
    <CollectorInstallPanel token={token} onToken={setToken} status={status} />
    <CollectorReview scannedAt={status?.scannedAt ?? null} memoryFiles={memoryFiles} />
  </>;
}

/** 个人菜单里的飞书：没连好时「连接飞书」，整页去飞书授权、授权完回到这一页；连好了只显示状态。 */
export function FeishuConnectItem({ connected }: { connected: boolean }) {
  return connected ? (
    <Button variant="ghost" className={m.item} isDisabled>
      <Link2 size={16} aria-hidden="true" />飞书已连接
    </Button>
  ) : (
    <Button variant="ghost" className={m.item} onPress={() => window.location.assign(feishuConnectHref(`${window.location.pathname}${window.location.search}`))}>
      <Link2 size={16} aria-hidden="true" />连接飞书
    </Button>
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
