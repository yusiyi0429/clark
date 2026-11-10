"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ArrowRight, Check, Mic, Square } from "lucide-react";
import { TianshuMark } from "@/components/TianshuMark";
import { useVoiceprintEnrollment, VOICEPRINT_SCRIPT, VOICEPRINT_CONSENT } from "@/components/member/useVoiceprintEnrollment";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { landingPath, onboardingDestination, onboardingReturnPath } from "@/lib/access-paths";
import { RadarSettingsEditor } from "@/components/radar/RadarSettingsEditor";
import { ConnectAgentForm } from "@/components/ConnectAgentForm";
import { BuddyNameInput } from "@/components/buddy/BuddyPicker";
import { BUDDY_PERSONALITIES } from "@/components/buddy/PersonalityPicker";
import { buddyNameValid, saveBuddy, type Buddy } from "@/components/buddy/useBuddy";
import { PresenceCapsule } from "@/components/coagent/PresenceCapsule";
import { useSimulatedLevel } from "@/components/coagent/SkinPicker";
import { COAGENT_SKINS, readStoredSkin } from "@/components/coagent/skin";
import { BuddyCarousel, BuddyFigure, PersonalityCard } from "./BuddyCarousel";
import { DelegationPanel } from "./DelegationPanel";
import { CoAgentCapsule } from "./CoAgentCapsule";
import { OnboardingProgress } from "./OnboardingProgress";
import { WorkspaceSchematic } from "./WorkspaceSchematic";
import { MissionFlow } from "./MissionFlow";
import { useOnboardingData } from "./useOnboardingData";
import f from "./foundation.module.css";
import s from "./welcome.module.css";

export type OnboardingData = components["schemas"]["OnboardingResponse"];
/**
 * 选伙伴的四页，按先后排（设计稿 17.1）：选形象 → 选性格 → 授权 → 起名字。起名字放在最后，那时台上已经是选好的形象。
 * 每一页都是引导里的一步，底下的步骤点一页一个。
 */
const BUDDY_STEPS = ["buddy-form", "buddy-personality", "buddy-consent", "buddy-name"] as const;
type Step = (typeof BUDDY_STEPS)[number] | "hello" | "tour-notifications" | "tour-board" | "mission-flow" | "radar" | "voiceprint" | "connect" | "delegation" | "start";

/**
 * CEO 只看工作台三页（你好 → 通知栏 → 公司全局和对话），最后一页直接进工作台；雷达、外部工具都在个人菜单里。
 * 成员看完工作台，接着看每月 Mission 的形成与执行，再连上 AI 工具；委托授权（第 7 步）由配置打开。
 * 天枢不再在本机收东西（spec 5.1：本机采集器整体下线），安装采集器、本机盘点、确认清单这三步拿掉了。
 * 还没有伙伴的人，最前面先「选择你的伙伴」（spec 5.5）；已经引导过、只差伙伴的人只走这一步。
 */
export function onboardingSteps(data: OnboardingData, buddyStep: "none" | "first" | "only" = "none"): Step[] {
  if (buddyStep === "only") return [...BUDDY_STEPS];
  const first: Step[] = buddyStep === "first" ? [...BUDDY_STEPS] : [];
  if (data.role === "ceo") return [...first, "hello", "tour-notifications", "tour-board"];
  return [...first, "hello", "tour-notifications", "tour-board", "mission-flow", "radar", ...(data.voiceprint.configured ? ["voiceprint" as const] : []), "connect",
    ...(data.delegationStep ? ["delegation" as const] : []), "start"];
}


/** 结束页设置摘要里的雷达一行（只有成员走到结束页）：写开没开。 */
export function radarSummaryLine(radar: { enabled: boolean }): string {
  return radar.enabled ? "雷达 · 已开启" : "雷达 · 未开启";
}

/** buddy：本人的伙伴，null 是还没选（undefined 当作已经有了）；buddyOnly：已经引导过、只差伙伴。 */
export function WelcomeFlow({ data: initial, nextPath, buddy, buddyOnly = false }: { data: OnboardingData; nextPath?: string; buddy?: Buddy | null; buddyOnly?: boolean }) {
  const { data, refreshError } = useOnboardingData(initial);
  const buddyStep = buddy !== null ? "none" : buddyOnly ? "only" : "first";
  const returnPath = onboardingReturnPath(data.role, nextPath);
  const [index, setIndex] = useState(0);
  const [acknowledge, setAcknowledge] = useState(0);
  const [direction, setDirection] = useState(1);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rerecord, setRerecord] = useState(false);
  /** 连接外部工具这一步：下载了连接说明才算连过，否则是「稍后」。 */
  const [connectDownloaded, setConnectDownloaded] = useState(false);
  /** 连接这一步的主按钮（生成 → 下载）由表单放进底栏这个位置；下载后换回「下一步」。 */
  const [connectPrimary, setConnectPrimary] = useState<HTMLDivElement | null>(null);
  /** 本步保存后的雷达摘要；没保存过就用服务端的。 */
  const [radarSaved, setRadarSaved] = useState<{ enabled: boolean; directions: number } | null>(null);
  /** 雷达这一步由编辑器负责前进：它的主按钮与「稍后」放进下面的底栏，位置和其他步骤一样。 */
  const [radarPrimary, setRadarPrimary] = useState<HTMLDivElement | null>(null);
  const [radarLater, setRadarLater] = useState<HTMLSpanElement | null>(null);
  /** 选伙伴的草稿：名字空着等本人起；样子在浏览器里再换成这台电脑原来选过的那颗；性格默认沉稳靠谱。 */
  const [buddyDraft, setBuddyDraft] = useState<Buddy>({ name: "", form: "classic", personality: "steady" });
  const [buddySaving, setBuddySaving] = useState(false);
  const [buddyError, setBuddyError] = useState<string | null>(null);
  /** 选形象那一页按下「选定」：两边的影子退开、中间那个应一声，然后才翻页。 */
  const [sealing, setSealing] = useState(false);
  const buddyName = useRef<HTMLInputElement>(null);
  const steps = onboardingSteps(data, buddyStep);
  const step = steps[index];
  const choosing = step.startsWith("buddy-");
  const last = index === steps.length - 1;
  const voice = useVoiceprintEnrollment({ initialStatus: data.voiceprint });
  const current = useRef(0);
  const completing = useRef(false);
  const title = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const outgoing = useRef<HTMLElement | null>(null);
  const outgoingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const recordResult = useRef<HTMLDivElement>(null);
  const naming = step === "buddy-name";
  /** 本人的伙伴：这次刚选的（选伙伴几页存好了才往下走），或者以前就选好的；不知道时（undefined）是默认胶囊。 */
  const own = buddy === null ? buddyDraft : buddy;
  /** 伙伴那几页之后的每一页，顶上一直是本人的伙伴（选的是默认那颗就还是原来的大胶囊）。 */
  const heroSkin = choosing ? null : own && own.form !== "classic" ? own.form : null;
  /** 选伙伴几页里台上那个伙伴的模拟声音；选性格那页它在说话，下面的话像是它说的。 */
  const buddyLevel = useSimulatedLevel(choosing);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    content.current?.parentElement?.scrollTo({ top: 0, behavior: "instant" });
    // 起名字那一页直接落在名字框上，其余页落在标题上。
    (naming ? buddyName.current : title.current)?.focus({ preventScroll: true });
  }, [index, naming]);
  // 使用周报的上手漏斗：打开哪一步报一次，报不上不影响上手。选伙伴的四页在漏斗里仍算「buddy」一步。
  const usageStep = choosing ? "buddy" : step as Exclude<Step, (typeof BUDDY_STEPS)[number]>;
  useEffect(() => {
    void browserApi.POST("/api/me/usage/onboarding-step", { body: { step: usageStep } }).catch(() => undefined);
  }, [usageStep]);
  useEffect(() => {
    if (step !== "voiceprint" || voice.phase !== "recorded" || !window.matchMedia("(max-width: 759px)").matches) return;
    // 手机读完长稿后，把时长和重录入口带回视野，避免被固定操作区遮住。
    recordResult.current?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [step, voice.phase]);
  useEffect(() => () => { outgoing.current?.remove(); if (outgoingTimer.current) clearTimeout(outgoingTimer.current); }, []);
  useEffect(() => { setBuddyDraft((draft) => ({ ...draft, form: readStoredSkin() })); }, []);

  /** 当前这一页滑出去：复制一份留在原处播退场，新的一页按 direction 进来。clone 为 false 时只收掉上一份退场。 */
  function slideOut(delta: number, clone = true) {
    outgoing.current?.remove();
    if (outgoingTimer.current) clearTimeout(outgoingTimer.current);
    const old = clone ? content.current?.cloneNode(true) as HTMLElement | undefined : undefined;
    if (!old || !content.current?.parentElement) return;
    old.inert = true;
    old.setAttribute("aria-hidden", "true");
    old.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
    old.classList.add(s.outgoing);
    old.style.setProperty("--direction", String(delta));
    content.current.parentElement.appendChild(old);
    outgoing.current = old;
    outgoingTimer.current = setTimeout(() => { old.remove(); if (outgoing.current === old) outgoing.current = null; }, 200);
  }

  function move(delta: number) {
    const next = Math.max(0, Math.min(steps.length - 1, current.current + delta));
    if (next === current.current || completing.current || voice.phase === "saving") return;
    voice.cancel();
    slideOut(delta, !(steps[next].startsWith("tour-") && steps[current.current].startsWith("tour-")));
    current.current = next;
    setDirection(delta);
    setIndex(next);
    setAcknowledge((value) => value + 1);
    setError(null);
    setBuddyError(null);
  }

  /** 选定形象：先播完那一下再翻页；减少动态效果时直接翻页。 */
  function sealForm() {
    if (sealing) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return move(1);
    setSealing(true);
    setTimeout(() => { setSealing(false); move(1); }, 560);
  }

  async function finish() {
    if (completing.current || voice.phase === "saving") return;
    completing.current = true;
    voice.cancel();
    setFinishing(true);
    setError(null);
    try {
      const { response, error: failure } = await browserApi.POST("/api/me/onboarding/complete");
      if (!response.ok) throw new Error(failure?.message ?? "还没能保存，请再试一次。");
      window.location.replace(onboardingDestination(data.role, nextPath, data.next.href));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "网络连接失败，请再试一次。");
      completing.current = false;
      setFinishing(false);
    }
  }

  async function saveBuddyStep() {
    if (buddySaving || !buddyNameValid(buddyDraft.name)) return;
    setBuddySaving(true);
    setBuddyError(null);
    try {
      await saveBuddy(buddyDraft);
      if (buddyOnly) { window.location.replace(landingPath(data.role, nextPath)); return; }
      setBuddySaving(false);
      move(1);
    } catch (cause) {
      setBuddyError(cause instanceof Error ? cause.message : "没有存上，请重试");
      setBuddySaving(false);
    }
  }

  /** 授权页点「同意」：伙伴代本人做事的授权打开（full），存上再往下走；「稍后」不调接口，保持 none，以后在偏好页里还能开。 */
  async function grantAuthority() {
    if (buddySaving) return;
    setBuddySaving(true);
    setBuddyError(null);
    try {
      const { data: saved, error: failure } = await browserApi.PUT("/api/me/buddy-authority", { body: { authority: "full" } });
      if (!saved) throw new Error(failure?.message ?? "没有存上，请重试");
      setBuddySaving(false);
      move(1);
    } catch (cause) {
      setBuddyError(cause instanceof Error ? cause.message : "没有存上，请重试");
      setBuddySaving(false);
    }
  }

  async function forward() {
    // 名字页回车也走这里，名字不合格不存。
    if (naming) return saveBuddyStep();
    if (step === "buddy-form") return sealForm();
    if (step === "buddy-consent") return grantAuthority();
    if (choosing) return move(1);
    if (last || error) return finish();
    if (step === "voiceprint" && voice.phase === "recorded") {
      const saved = await voice.save();
      if (saved) { setRerecord(false); move(1); }
      return;
    }
    move(1);
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Enter" || event.defaultPrevented || event.nativeEvent.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, button, a, [contenteditable=true]")) return;
    event.preventDefault();
    (step === "radar" ? radarPrimary?.querySelector<HTMLButtonElement>("[data-radar-submit]")
      : step === "connect" && !connectDownloaded ? connectPrimary?.querySelector<HTMLButtonElement>("button") : primary.current)?.click();
  }

  const heading = step === "buddy-form" ? "选择你的伙伴" : step === "buddy-personality" ? "选择性格" : step === "buddy-consent" ? "伙伴可以替你做你能做的事" : naming ? "给伙伴起个名字" : step === "delegation" ? "授权天枢替你记进本体" : step === "hello" ? `你好，${data.displayName}` : step === "tour-notifications" ? "左边是通知栏" : step === "tour-board" ? data.role === "ceo" ? "右边是公司全局" : "右边是你的工作" : step === "mission-flow" ? "每个月的 Mission，这样定下来" : step === "radar" ? "你想关注哪些变化？" : step === "voiceprint" ? "让我在会上认出你的声音" : step === "connect" ? "连上你自己的 AI 工具" : "可以开始了";
  // 手机首页是一条滚动：最上面是通知，往下 CEO 是公司全局、成员是自己的工作。
  const noticeCopy = data.role === "ceo" ? "会后要你确认的会议卡、月末的复盘与拆解，到时候会出现在这里。" : "任务卡的讨论、分给你的事和别人的回复，按轻重排在这里。";
  const phoneHeading = step === "tour-notifications" ? "最上面是通知" : step === "tour-board" ? data.role === "ceo" ? "往下是公司全局" : "往下是你的工作" : null;
  /**
   * 深色跟系统（设计稿 5.2）只在整段引导都是伙伴四页时开；后面那些旧步骤（导览示意图等）还是写死的浅色，
   * 第一次引导就整段先用浅色，不半深半浅。
   */
  const scheme = steps.every((item) => item.startsWith("buddy-")) ? "auto" : "light";
  const busy = finishing || voice.phase === "saving" || buddySaving || sealing;
  const voiceReady = voice.status?.enrolled && !rerecord && voice.phase === "idle";
  const primaryDisabled = busy || (naming && !buddyNameValid(buddyDraft.name)) || (!error && ((step === "voiceprint" && !voiceReady && (voice.phase !== "recorded" || voice.tooShort))));
  const disabledHint = step === "voiceprint" && primaryDisabled && !busy
    ? voice.recording ? "录好后再继续，也可以选「稍后」" : voice.tooShort ? "请重新录满 15 秒，或者选「稍后」" : voice.consent ? "录好一段 15–30 秒的朗读，或者选「稍后」" : "先勾选同意并录好，或者选「稍后」"
    : null;
  const primaryLabel = finishing ? "正在进入…" : buddySaving ? "正在保存…" : naming ? "完成" : step === "buddy-consent" ? "同意" : choosing ? "选定" : step === "hello" ? "开始" : step === "start" ? returnPath ? "继续刚才的页面" : data.next.action : last ? returnPath ? "继续刚才的页面" : "进入工作台" : step === "voiceprint" ? voice.phase === "saving" ? "正在保存…" : voice.phase === "recorded" ? "保存并继续" : voiceReady ? "下一步" : "录好后继续" : "下一步";

  return <main className={s.page} onKeyDown={onKeyDown} style={{ "--direction": direction } as CSSProperties} data-scheme={scheme}>
    <header className={s.header}>
      <div className={s.brand} aria-label="天枢"><TianshuMark /><span>天枢</span></div>
      {!last && !choosing ? <button type="button" className={f.textButton} onClick={() => void finish()} disabled={busy}>先进入工作台</button> : null}
    </header>
    <div className={s.flow} data-step={step} data-role={data.role}>
      {choosing ? step === "buddy-form" ? null : <div className={s.buddyStage}>
        <BuddyFigure size="hero" skin={buddyDraft.form} name={buddyDraft.name.trim()} pose={step === "buddy-personality" ? "speaking" : naming ? "listening" : "idle"} level={buddyLevel} />
      </div> : heroSkin ? <div key={heroSkin} className={f.buddyHero} aria-hidden="true">
        <PresenceCapsule skin={heroSkin} name={own?.name} pose={voice.recording ? "listening" : "idle"} level={voice.recording ? voice.level : 0} />
      </div> : <CoAgentCapsule acknowledge={acknowledge} state={voice.recording ? "listening" : "idle"} level={voice.level} />}
      <div className={s.stage}>
        <div className={s.content} key={step.startsWith("tour-") ? "tour" : step} ref={content} data-step={step}>
          <div className={s.intro}>
            <h1 ref={title} tabIndex={-1}>{phoneHeading ? <><span className={s.desktopTourCopy}>{heading}</span><span className={s.mobileTourCopy}>{phoneHeading}</span></> : heading}</h1>
            {step === "hello" ? <><p className={s.subtitle}>欢迎使用天枢。</p><p className={s.description}>{data.role === "ceo" ? "先花一分钟看看工作台。" : <>先花一分钟看看工作台，再看看每个月的 Mission 怎么定下来。<br />{data.voiceprint.configured ? "雷达、声纹和外部工具" : "雷达和外部工具"}，可以现在设，也可以以后再说。</>}</p></> : null}
            {step === "tour-notifications" ? <><p className={`${s.description} ${s.desktopTourCopy}`}>{noticeCopy}点开一条，右边展开详情；看完关掉，回到原处。</p><p className={`${s.description} ${s.mobileTourCopy}`}>{noticeCopy}</p></> : null}
            {step === "tour-board" ? <><p className={`${s.description} ${s.desktopTourCopy}`}>{data.role === "ceo" ? <>各个战场和雷达都在这里。<br />底部是你的 Agent：问公司的事，它查了再答；要约会议，也直接跟它说。</> : <>最上面是这个月的日历、你的 Mission 和约会议、等回复这些常用操作。<br />选一个 Mission，下面是它的 Task 和执行事项，分已完成、本周、之后三栏；再往下是最近进展。<br />底部是你的 Agent：问这个月的事，它查了再答。</>}</p><p className={`${s.description} ${s.mobileTourCopy}`}>{data.role === "ceo" ? "各个战场和雷达都在通知下面，一个一行。点开任何一条，详情铺满屏幕，左上角返回；底部是你的 Agent，问公司的事、约会议都跟它说。" : "约会议、等回复在最上面；往下是这个月的日历、Mission，再往下是 Mission 里的执行事项，本周的排在最前。"}</p></> : null}
            {step === "mission-flow" ? <p className={s.description}>月初一起定方向，之后由你拆成每天的事。</p> : null}
            {step === "voiceprint" ? <p className={s.description}>录一段 15–30 秒的朗读，帮我在会后建议哪些发言可能来自你——最后仍由人核对。</p> : null}
            {step === "connect" ? <p className={s.description}>Codex、Claude Code 这类工具连上天枢后，能读你的执行事项、帮你写进展。</p> : null}
            {step === "start" && !returnPath ? <p className={s.description}>{data.next.text}</p> : null}
          </div>
          <div className={s.details}>
            {step === "buddy-form" ? <BuddyCarousel kind="figure" label="伙伴形象" items={COAGENT_SKINS} value={buddyDraft.form} sealing={sealing}
              onChange={(form) => setBuddyDraft((draft) => ({ ...draft, form }))}>
              {(form, active) => <BuddyFigure size="stage" skin={form} name="" pose={active ? sealing ? "speaking" : "listening" : "idle"} level={active ? buddyLevel : 0} />}
            </BuddyCarousel> : null}
            {step === "buddy-personality" ? <BuddyCarousel kind="card" label="伙伴的性格" items={BUDDY_PERSONALITIES} value={buddyDraft.personality ?? "steady"}
              onChange={(personality) => setBuddyDraft((draft) => ({ ...draft, personality }))}>
              {(id) => <PersonalityCard id={id} />}
            </BuddyCarousel> : null}
            {naming ? <div className={s.buddyName}>
              <BuddyNameInput inputRef={buddyName} className={s.buddyNameInput} label="伙伴的名字" value={buddyDraft.name}
                onChange={(name) => setBuddyDraft((draft) => ({ ...draft, name }))} onEnter={() => void forward()} />
            </div> : null}
            {choosing && buddyError ? <p className={s.error} role="alert">{buddyError}</p> : null}
            {(step === "tour-notifications" || step === "tour-board") ? <WorkspaceSchematic role={data.role} focus={step === "tour-notifications" ? "notifications" : "board"} /> : null}
            {step === "mission-flow" && data.role === "member" ? <MissionFlow /> : null}
            {step === "radar" ? <RadarSettingsEditor
              mode="person"
              submitLabel="保存并继续"
              onSaved={(summary) => { setRadarSaved({ enabled: summary.enabled, directions: summary.directions }); move(1); }}
              onLater={() => move(1)}
              actionsTarget={{ primary: radarPrimary, secondary: radarLater }}
            /> : null}
            {step === "voiceprint" ? <>
              {voiceReady ? <div className={`${f.glass} ${s.enrolled}`}>
                <span className={s.successIcon}><Check size={24} /></span>
                <p>你的声纹已经录好</p>
                {voice.status?.updatedAt ? <p className={s.updated}>{new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric" }).format(new Date(voice.status.updatedAt))}更新</p> : null}
                <button type="button" className={f.textButton} onClick={() => setRerecord(true)}>重新录制</button>
              </div> : <>
                <label className={s.consent}><input type="checkbox" checked={voice.consent} disabled={voice.recording || busy} onChange={(event) => voice.setConsent(event.target.checked)} /><span>{VOICEPRINT_CONSENT}</span></label>
                <blockquote className={`${f.glass} ${s.script}`} aria-label="请朗读这段文字"><span>请用平时开会的语速朗读</span>{VOICEPRINT_SCRIPT}</blockquote>
                <div className={s.recordControl} ref={recordResult}>
                  <div className={s.recordRing}>
                    <svg viewBox="0 0 88 88" aria-hidden="true"><circle cx="44" cy="44" r="41" /><circle cx="44" cy="44" r="41" pathLength="30" strokeDasharray="30" strokeDashoffset={30 - Math.min(30, voice.seconds)} /></svg>
                    <button type="button" className={s.recordButton} disabled={busy || voice.starting || (!voice.recording && !voice.consent) || (voice.recording && !voice.canStop)} aria-label={voice.recording ? "停止录制" : voice.phase === "recorded" ? "重新录制" : "开始录制"} onClick={() => voice.recording ? voice.stop() : void voice.start()}>
                      {voice.recording ? <Square size={22} fill="currentColor" /> : <Mic size={26} />}
                    </button>
                  </div>
                  <p className={s.timer}>{voice.recording || voice.phase === "recorded" ? <><span>{String(voice.seconds).padStart(2, "0")}</span> / 30 秒</> : "15–30 秒"}</p>
                  <p className={s.recordHint} role="status">{voice.recording ? voice.canStop ? "读完了就可以停止" : "正在录音，15 秒后可以停止" : voice.phase === "recorded" ? voice.tooShort ? "这段太短了，请重新录制" : "录好了，可以保存或重录" : "找一个安静的地方，准备好就开始"}</p>
                </div>
              </>}
              {voice.error ? <p className={s.error} role="alert">{voice.error}</p> : null}
            </> : null}
            {step === "connect" ? <div className={`${f.glass} ${s.connectPanel}`}>
              <ConnectAgentForm role={data.role} defaultName="我的电脑" actionsTarget={connectDownloaded ? undefined : connectPrimary} onDownloaded={() => setConnectDownloaded(true)} />
            </div> : null}
            {step === "delegation" ? <DelegationPanel /> : null}
            {step === "start" ? <p className={s.summary}>
              <span className={s.summaryItem}>{radarSummaryLine(radarSaved ?? data.radar)}</span>
              {data.voiceprint.configured ? <span className={s.summaryItem}>声纹 · {voice.status?.enrolled ? "已录好" : "稍后在个人菜单里录"}</span> : null}
              <span className={s.summaryItem}>外部工具 · {connectDownloaded ? "连接步骤已准备" : "稍后在个人菜单里连"}</span>
              <span>都可以在个人菜单里改</span>
            </p> : null}
          </div>
        </div>
      </div>
      <footer className={s.footer}>
        <OnboardingProgress current={index + 1} total={steps.length} />
        {error ? <p className={s.error} role="alert">{error}</p> : null}
        {refreshError ? <p className={s.footnote} role="status">{refreshError}</p> : null}
        {step === "start" && returnPath ? <p className={s.footnote}>{data.next.text}</p> : null}
        {disabledHint ? <p id="welcome-action-hint" className={s.actionHint}>{disabledHint}</p> : null}
        {step === "radar" && !error ? <div key={step} ref={setRadarPrimary} className={s.radarActions} />
          : step === "connect" && !connectDownloaded && !error ? <div key={step} ref={setConnectPrimary} className={s.radarActions} /> : <button key={step} ref={primary} className={f.primary} type="button" onClick={() => void forward()} disabled={primaryDisabled} aria-describedby={disabledHint ? "welcome-action-hint" : undefined}>{error ? "重试" : primaryLabel}{!busy ? <ArrowRight size={18} aria-hidden="true" /> : null}</button>}
        <div className={s.secondary}>
          {index > 0 ? <button className={f.textButton} type="button" onClick={() => move(-1)} disabled={busy}>上一步</button> : null}
          {step === "buddy-consent" || step === "voiceprint" || step === "connect" || step === "delegation" ? <button className={f.textButton} type="button" onClick={() => move(1)} disabled={busy}>稍后</button> : null}
          {step === "radar" ? <span ref={setRadarLater} className={s.radarSlot} /> : null}
        </div>
      </footer>
    </div>
  </main>;
}
