"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ArrowRight, Check, Mic, Square } from "lucide-react";
import { TianshuMark } from "@/components/TianshuMark";
import { useVoiceprintEnrollment, VOICEPRINT_SCRIPT, VOICEPRINT_CONSENT } from "@/components/member/useVoiceprintEnrollment";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { onboardingDestination, onboardingReturnPath } from "@/lib/access-paths";
import { monthDayTime } from "@/lib/companyTime";
import { useRoundNow } from "@/components/missionCards/useRoundNow";
import { RadarSettingsEditor } from "@/components/radar/RadarSettingsEditor";
import { ConnectAgentForm } from "@/components/ConnectAgentForm";
import { CollectorInstallPanel, ScanProgress, scanSteps, useCollectorStatus } from "./CollectorSetup";
import { loadReviewLists, reviewEmpty, ReviewSummary, submitReview, type ReviewLists, type ReviewPicks } from "./ReviewLists";
import { DelegationPanel } from "./DelegationPanel";
import { MorningCanvas } from "./MorningCanvas";
import { CoAgentCapsule } from "./CoAgentCapsule";
import { OnboardingProgress } from "./OnboardingProgress";
import { WorkspaceSchematic } from "./WorkspaceSchematic";
import { MissionFlow } from "./MissionFlow";
import { useOnboardingData } from "./useOnboardingData";
import f from "./foundation.module.css";
import s from "./welcome.module.css";

export type OnboardingData = components["schemas"]["OnboardingResponse"];
type Step = "hello" | "tour-notifications" | "tour-board" | "mission-flow" | "work" | "radar" | "voiceprint" | "connect" | "collector" | "scan" | "review" | "delegation" | "start";

/**
 * 两种角色都先看工作台；成员接着看每月 Mission 的形成与执行。
 * 连上 AI 工具之后：安装本机采集器 → 后台扫描 → 确认清单（10a 第 2–4 步；扫完三项都没有可确认的就跳过）；委托授权（第 7 步）由配置打开。
 */
export function onboardingSteps(data: OnboardingData, skipReview = false): Step[] {
  return ["hello", "tour-notifications", "tour-board", ...(data.role === "member" ? ["mission-flow" as const, "work" as const] : []), "radar", ...(data.voiceprint.configured ? ["voiceprint" as const] : []), "connect",
    "collector", "scan", ...(skipReview ? [] : ["review" as const]), ...(data.delegationStep ? ["delegation" as const] : []), "start"];
}

/** 扫描等第一次盘点最多这么久；超时就停在那一步，用已有的数据整理清单，不让人卡在这一页。 */
export const SCAN_TIMEOUT_MS = 120_000;

/** 结束页设置摘要里的雷达一行：成员写开没开；CEO 的公司雷达不能关，写补充了几个方向。 */
export function radarSummaryLine(role: OnboardingData["role"], radar: { enabled: boolean; directions: number }): string {
  if (role === "ceo") return radar.directions ? `雷达 · 已补充 ${radar.directions} 个方向` : "雷达 · 按本月目标自动关注";
  return radar.enabled ? "雷达 · 已开启" : "雷达 · 未开启";
}

export function monthTargetCopy(status: "none" | "draft" | "negotiating" | "confirmed", target: string | null): string {
  if (status === "none") return "本月目标还没出来";
  if (status !== "confirmed") return "本月目标还在协商";
  return target || "这个战场的本月目标还没有登记";
}

type WorkMissionCard = Extract<OnboardingData, { role: "member" }>["work"]["missionCards"][number];

function WorkMissionCard({ card, onRefresh }: { card: WorkMissionCard; onRefresh?: () => void }) {
  useRoundNow(card.closesAt, card.serverNow, card.phase === "open" ? onRefresh : undefined);
  return <li className={s.personalCard}>
    <div className={s.personalCardHeading}><strong>{Number(card.period.slice(5))} 月 Mission Card</strong>{card.placeholder ? <span className={s.placeholder}>占位</span> : null}</div>
    <p>{card.battlefieldName} · {card.missionCount} 项个人任务</p>
    <p className={s.cardStatus}>{card.status}</p>
    {card.closesAt ? <p className={s.cardDeadline}><time dateTime={card.closesAt}>{card.phase === "open" ? `${monthDayTime(card.closesAt)} 截止` : `讨论截止于 ${monthDayTime(card.closesAt)}`}</time></p> : <p className={s.cardDeadline}>本轮未开放</p>}
  </li>;
}

export function WorkSnapshot({ data, onRefresh }: { data: Extract<OnboardingData, { role: "member" }>; onRefresh?: () => void }) {
  const { work } = data;
  const unassigned = work.missions.filter((mission) => !mission.battlefieldIds.some((id) => work.battlefields.some((battlefield) => battlefield.id === id)));
  const groupedMissions = work.battlefields.map((battlefield) => ({ ...battlefield, missions: work.missions.filter((mission) => mission.battlefieldIds.includes(battlefield.id)) })).filter((group) => group.missions.length);
  const missionList = (missions: typeof work.missions) => <><ul className={s.missions}>{missions.slice(0, 3).map((mission) => <li key={mission.id}>{mission.title}</li>)}</ul>{missions.length > 3 ? <p className={s.more}>另 {missions.length - 3} 条</p> : null}</>;
  return <div className={`${f.glass} ${s.snapshot} ${s.workSnapshot}`}>
    <p className={s.period}>{Number(work.period.slice(5))} 月 · 与你有关的工作</p>
    {work.battlefields.length ? work.battlefields.map((battlefield) => <section className={s.workSection} key={battlefield.id}>
        <h2>{battlefield.name}</h2>
        <p className={s.targetLabel}>本月目标</p>
        <p className={s.clampThree}>{monthTargetCopy(work.planStatus, battlefield.monthTarget)}</p>
      </section>) : <p className={s.empty}>这个月还没有登记你参与的战场。</p>}
    <section className={`${s.workSection} ${s.myCards}`} aria-label="我的本月卡">
      <h2>我的本月卡</h2>
      {work.missionCards.length ? <ul className={s.personalCards}>{work.missionCards.map((card) => <WorkMissionCard key={card.cardId} card={card} onRefresh={onRefresh} />)}</ul> : <p>这个月还没有你的卡；定下来之后，会出现在首页。</p>}
    </section>
    {work.missions.length ? <section className={`${s.workSection} ${s.workMissions}`}>
      <h2>我的 Mission</h2>
      {groupedMissions.map((group) => <div key={group.id} className={s.missionGroup}>
        {groupedMissions.length > 1 || unassigned.length ? <p className={s.targetLabel}>{group.name}</p> : null}
        {missionList(group.missions)}
      </div>)}
      {unassigned.length ? <div className={s.missionGroup}>{groupedMissions.length ? <p className={s.targetLabel}>未关联战场</p> : null}{missionList(unassigned)}</div> : null}
    </section> : <p className={s.emptyMission}>这个月还没有登记你的 Mission</p>}
  </div>;
}

export function WelcomeFlow({ data: initial, nextPath }: { data: OnboardingData; nextPath?: string }) {
  const { data, refresh, refreshError } = useOnboardingData(initial);
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
  /** 本次上手生成的采集器令牌：前后翻页不丢，也不重复生成。 */
  const [collectorToken, setCollectorToken] = useState<string | null>(null);
  const [scanTimedOut, setScanTimedOut] = useState(false);
  /** 扫描页结束时读好的两份清单；确认清单提交后换成服务端返回的最新一份。 */
  const [reviewLists, setReviewLists] = useState<ReviewLists | null>(null);
  /** 确认清单提交过（之后默认勾选按入库的来）、明细里改过的勾选、提交中、提交失败。 */
  const [reviewed, setReviewed] = useState(false);
  const [reviewPicks, setReviewPicks] = useState<ReviewPicks>({});
  const [reviewSaving, setReviewSaving] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  // 确认清单在扫描之后：跳不跳过，采集器、扫描两步的位置都一样。
  const unskipped = onboardingSteps(data)[index];
  const collector = useCollectorStatus(unskipped === "collector" || unskipped === "scan");
  const collectorConnected = Boolean(collector?.devices.length);
  const memoryFiles = collectorConnected && collector!.consent ? collector!.inventory.memoryFiles : null;
  const steps = onboardingSteps(data, !reviewed && reviewLists !== null && reviewEmpty(reviewLists, memoryFiles));
  const step = steps[index];
  const scanFinished = Boolean(collector) && (!collectorConnected || !collector?.consent || Boolean(collector?.scannedAt) || scanTimedOut);
  const scanReady = scanFinished && reviewLists !== null;
  const voice = useVoiceprintEnrollment({ initialStatus: data.voiceprint });
  const current = useRef(0);
  const completing = useRef(false);
  const title = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const outgoing = useRef<HTMLElement | null>(null);
  const outgoingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const recordResult = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    content.current?.parentElement?.scrollTo({ top: 0, behavior: "instant" });
    title.current?.focus({ preventScroll: true });
  }, [index]);
  useEffect(() => {
    if (step !== "voiceprint" || voice.phase !== "recorded" || !window.matchMedia("(max-width: 759px)").matches) return;
    // 手机读完长稿后，把时长和重录入口带回视野，避免被固定操作区遮住。
    recordResult.current?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  }, [step, voice.phase]);
  useEffect(() => () => { outgoing.current?.remove(); if (outgoingTimer.current) clearTimeout(outgoingTimer.current); }, []);
  useEffect(() => {
    if (step !== "scan" || !collectorConnected || !collector?.consent || collector?.scannedAt || scanTimedOut) return;
    const timer = window.setTimeout(() => setScanTimedOut(true), SCAN_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [step, collectorConnected, collector?.scannedAt, scanTimedOut]);
  useEffect(() => {
    if (step !== "scan" || !scanFinished || reviewLists) return;
    // 扫完才整理清单：读不到就隔几秒再读，步骤停在「整理清单」。
    let alive = true;
    let timer: number | undefined;
    const load = () => void loadReviewLists().then((lists) => { if (alive) setReviewLists(lists); })
      .catch(() => { if (alive) timer = window.setTimeout(load, 3_000); });
    load();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [step, scanFinished, reviewLists]);

  function move(delta: number) {
    const next = Math.max(0, Math.min(steps.length - 1, current.current + delta));
    if (next === current.current || completing.current || voice.phase === "saving") return;
    voice.cancel();
    outgoing.current?.remove();
    if (outgoingTimer.current) clearTimeout(outgoingTimer.current);
    const old = steps[next].startsWith("tour-") && steps[current.current].startsWith("tour-") ? undefined : content.current?.cloneNode(true) as HTMLElement | undefined;
    if (old && content.current?.parentElement) {
      old.inert = true;
      old.setAttribute("aria-hidden", "true");
      old.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
      old.classList.add(s.outgoing);
      old.style.setProperty("--direction", String(delta));
      content.current.parentElement.appendChild(old);
      outgoing.current = old;
      outgoingTimer.current = setTimeout(() => { old.remove(); if (outgoing.current === old) outgoing.current = null; }, 200);
    }
    current.current = next;
    setDirection(delta);
    setIndex(next);
    setAcknowledge((value) => value + 1);
    setError(null);
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

  async function forward() {
    if (step === "start" || error) return finish();
    if (step === "review" && reviewLists) {
      setReviewSaving(true);
      setReviewError(null);
      try {
        setReviewLists(await submitReview(reviewLists, reviewed, reviewPicks));
        setReviewPicks({});
        setReviewed(true);
        move(1);
      } catch (cause) {
        setReviewError(cause instanceof Error ? cause.message : "没有存上，请重试");
      } finally {
        setReviewSaving(false);
      }
      return;
    }
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

  const heading = step === "collector" ? "安装本机采集器" : step === "scan" ? scanReady ? "扫描完成" : "正在扫描" : step === "review" ? "确认清单" : step === "delegation" ? "授权天枢替你记进本体" : step === "hello" ? `你好，${data.displayName}` : step === "tour-notifications" ? "左边是通知栏" : step === "tour-board" ? data.role === "ceo" ? "右边是公司全局" : "右边是你的工作" : step === "mission-flow" ? "每个月的 Mission，这样定下来" : step === "work" ? "你这个月的工作" : step === "radar" ? data.role === "ceo" ? "公司雷达，还要看什么？" : "你想关注哪些变化？" : step === "voiceprint" ? "让我在会上认出你的声音" : step === "connect" ? "连上你自己的 AI 工具" : "可以开始了";
  // 手机首页是一条滚动：最上面是通知，往下 CEO 是公司全局、成员是自己的工作。
  const phoneHeading = step === "tour-notifications" ? "最上面是通知" : step === "tour-board" ? data.role === "ceo" ? "往下是公司全局" : "往下是你的工作" : null;
  const busy = finishing || voice.phase === "saving" || reviewSaving;
  const voiceReady = voice.status?.enrolled && !rerecord && voice.phase === "idle";
  const primaryDisabled = busy || (!error && ((step === "voiceprint" && !voiceReady && (voice.phase !== "recorded" || voice.tooShort))
    || (step === "collector" && !collectorConnected) || (step === "scan" && !scanReady)));
  const disabledHint = step === "voiceprint" && primaryDisabled && !busy
    ? voice.recording ? "录好后再继续，也可以选「稍后」" : voice.tooShort ? "请重新录满 15 秒，或者选「稍后」" : voice.consent ? "录好一段 15–30 秒的朗读，或者选「稍后」" : "先勾选同意并录好，或者选「稍后」"
    : null;
  const primaryLabel = finishing ? "正在进入…" : step === "hello" ? "开始" : step === "start" ? returnPath ? "继续刚才的页面" : data.next.action : step === "review" ? reviewSaving ? "正在保存…" : "完成" : step === "voiceprint" ? voice.phase === "saving" ? "正在保存…" : voice.phase === "recorded" ? "保存并继续" : voiceReady ? "下一步" : "录好后继续" : "下一步";

  return <main className={s.page} onKeyDown={onKeyDown} style={{ "--direction": direction } as CSSProperties}>
    <MorningCanvas progress={index} />
    <header className={s.header}>
      <div className={s.brand} aria-label="天枢"><TianshuMark /><span>天枢</span></div>
      {step !== "start" ? <button type="button" className={f.textButton} onClick={() => void finish()} disabled={busy}>先进入工作台</button> : null}
    </header>
    <div className={s.flow} data-step={step} data-role={data.role}>
      <CoAgentCapsule acknowledge={acknowledge} state={voice.recording ? "listening" : "idle"} level={voice.level} />
      <div className={s.stage}>
        <div className={s.content} key={step.startsWith("tour-") ? "tour" : step} ref={content} data-step={step}>
          <div className={s.intro}>
            <h1 ref={title} tabIndex={-1}>{phoneHeading ? <><span className={s.desktopTourCopy}>{heading}</span><span className={s.mobileTourCopy}>{phoneHeading}</span></> : heading}</h1>
            {step === "hello" ? <><p className={s.subtitle}>欢迎使用天枢。</p><p className={s.description}>{data.role === "ceo" ? "先花一分钟看看工作台。" : <>先花一分钟看看工作台，再看看每个月的 Mission 怎么定下来。<br /></>}{data.voiceprint.configured ? "雷达、声纹和外部工具" : "雷达和外部工具"}，可以现在设，也可以以后再说。</p></> : null}
            {step === "tour-notifications" ? <><p className={`${s.description} ${s.desktopTourCopy}`}>{data.role === "ceo" ? "要你拍板的事、会议安排和需要研究的问题" : "任务卡的讨论、分给你的事和别人的回复"}，按轻重排在这里。点开一条，右边展开详情；看完关掉，回到原处。</p><p className={`${s.description} ${s.mobileTourCopy}`}>{data.role === "ceo" ? "要你拍板的事、会议安排和需要研究的问题" : "任务卡的讨论、分给你的事和别人的回复"}，按轻重排在这里。</p></> : null}
            {step === "tour-board" ? <><p className={`${s.description} ${s.desktopTourCopy}`}>{data.role === "ceo" ? <>战略议题、雷达和各个战场都在这里。<br />底部是你的 Agent：问公司的事，它查了再答。</> : <>约会议、等回复、战场进展、复盘在最上面一行。<br />下面是本月的 Mission 和每一天，执行事项分已完成、本周、之后三栏。<br />底部是你的 Agent：问这个月的事，它查了再答。</>}</p><p className={`${s.description} ${s.mobileTourCopy}`}>{data.role === "ceo" ? "各个战场和雷达都在通知下面，一个一行。点开任何一条，详情铺满屏幕，左上角返回；底部是你的 Agent。" : "约会议、等回复、战场进展、复盘在最上面；往下是本月的 Mission 和执行事项，本周的排在最前。"}</p></> : null}
            {step === "mission-flow" ? <p className={s.description}>月初一起定方向，之后由你拆成每天的事。</p> : null}
            {/* 「这里改的是公司雷达。」由编辑器顶部那一行说，同一屏不重复。 */}
            {step === "radar" && data.role === "ceo" ? <p className={s.description}>我会按你签发的本月目标自动关注；你还可以补充方向和来源。</p> : null}
            {step === "voiceprint" ? <p className={s.description}>录一段 15–30 秒的朗读，帮我在会后建议哪些发言可能来自你——最后仍由人核对。</p> : null}
            {step === "connect" ? <p className={s.description}>{data.role === "ceo" ? "Codex、Claude Code 这类工具连上天枢后，可以直接问它今天有什么要你拍板、这周各战场怎么样。它只能看，拍板仍在天枢里做。" : "Codex、Claude Code 这类工具连上天枢后，能读你的执行事项、帮你写进展。需要每周自动同步时，可以再设置定时任务。"}</p> : null}
            {step === "start" && !returnPath ? <p className={s.description}>{data.next.text}</p> : null}
          </div>
          <div className={s.details}>
            {(step === "tour-notifications" || step === "tour-board") ? <WorkspaceSchematic role={data.role} focus={step === "tour-notifications" ? "notifications" : "board"} /> : null}
            {step === "mission-flow" && data.role === "member" ? <MissionFlow /> : null}
            {step === "work" && data.role === "member" ? <WorkSnapshot data={data} onRefresh={refresh} /> : null}
            {step === "radar" ? <RadarSettingsEditor
              mode={data.role === "ceo" ? "company" : "person"}
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
            {step === "collector" ? <CollectorInstallPanel token={collectorToken} onToken={setCollectorToken} status={collector} /> : null}
            {step === "scan" ? <ScanProgress steps={scanSteps(collector, reviewLists && { basis: reviewLists.basis.length, schedules: reviewLists.schedules.length }, scanTimedOut)} /> : null}
            {step === "review" && reviewLists ? <ReviewSummary lists={reviewLists} reviewed={reviewed} picks={reviewPicks} memoryFiles={memoryFiles}
              onPick={(key, checked) => setReviewPicks((current) => ({ ...current, [key]: checked }))} saving={reviewSaving} error={reviewError} /> : null}
            {step === "delegation" ? <DelegationPanel /> : null}
            {step === "start" ? <p className={s.summary}>
              <span className={s.summaryItem}>{radarSummaryLine(data.role, radarSaved ?? data.radar)}</span>
              {data.voiceprint.configured ? <span className={s.summaryItem}>声纹 · {voice.status?.enrolled ? "已录好" : "稍后在个人菜单里录"}</span> : null}
              <span className={s.summaryItem}>外部工具 · {connectDownloaded ? "连接步骤已准备" : "稍后在个人菜单里连"}</span>
              <span className={s.summaryItem}>本机采集器 · {collectorConnected ? "已连接" : "未连接"}</span>
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
          {step === "voiceprint" || step === "connect" || step === "collector" || step === "delegation" ? <button className={f.textButton} type="button" onClick={() => move(1)} disabled={busy}>稍后</button> : null}
          {step === "radar" ? <span ref={setRadarLater} className={s.radarSlot} /> : null}
        </div>
      </footer>
    </div>
  </main>;
}
