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
import { MorningCanvas } from "./MorningCanvas";
import { CoAgentCapsule } from "./CoAgentCapsule";
import { OnboardingProgress } from "./OnboardingProgress";
import { useOnboardingData } from "./useOnboardingData";
import f from "./foundation.module.css";
import s from "./welcome.module.css";

export type OnboardingData = components["schemas"]["OnboardingResponse"];
type Step = "hello" | "company" | "work" | "radar" | "voiceprint" | "start";

/** 雷达（工单 02）排在公司目标与分工／你这个月的工作之后、声纹之前；进度、前后导航与动效不依赖固定步数。 */
export function onboardingSteps(data: OnboardingData): Step[] {
  return ["hello", data.role === "ceo" ? "company" : "work", "radar", ...(data.voiceprint.configured ? ["voiceprint" as const] : []), "start"];
}

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

export function CompanySnapshot({ data }: { data: Extract<OnboardingData, { role: "ceo" }> }) {
  const { company } = data;
  return <>
    <div className={`${f.glass} ${s.snapshot}`}>
      {!company.sixMonthGoal && !company.battlefields.length ? <p className={s.empty}>公司的目标和战场还没登记。登记之后，这里会列出目标和分工。</p> : <>
        <section className={s.snapshotSection}>
          <h2>六个月目标</h2>
          <p className={s.clampThree}>{company.sixMonthGoal || "六个月目标还没有登记"}</p>
        </section>
        <section className={s.snapshotSection}>
          <h2>战场 <span>{company.battlefields.length}</span></h2>
          {company.battlefields.length ? <ul className={s.battlefields}>{company.battlefields.map((battlefield) => <li key={battlefield.id}>
            <span className={s.code}>{battlefield.code}</span><strong>{battlefield.name}</strong><span>{battlefield.ownerName ?? "待指派"}</span>
          </li>)}</ul> : <p>战场还没有登记</p>}
        </section>
      </>}
      {company.capabilities.length ? <section className={s.snapshotSection}><h2>能力 <span>{company.capabilities.length}</span></h2><p className={s.clampTwo}>{company.capabilities.map((item) => item.name).join(" · ")}</p></section> : null}
      <section className={`${s.snapshotSection} ${s.people}`}>
        <div className={s.avatars} aria-hidden="true">{company.people.slice(0, 5).map((person) => <span key={person.personId}>{Array.from(person.displayName)[0]}</span>)}</div>
        <p>{company.people.length} 位同事</p>
      </section>
    </div>
    <p className={s.footnote}>哪里不对，在个人菜单的「组织配置」里改。</p>
  </>;
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
  const steps = onboardingSteps(data);
  const returnPath = onboardingReturnPath(data.role, nextPath);
  const [index, setIndex] = useState(0);
  const [acknowledge, setAcknowledge] = useState(0);
  const [direction, setDirection] = useState(1);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rerecord, setRerecord] = useState(false);
  /** 本步保存后的雷达摘要；没保存过就用服务端的。 */
  const [radarSaved, setRadarSaved] = useState<{ enabled: boolean; directions: number } | null>(null);
  /** 雷达这一步由编辑器负责前进：它的主按钮与「稍后」放进下面的底栏，位置和其他步骤一样。 */
  const [radarPrimary, setRadarPrimary] = useState<HTMLDivElement | null>(null);
  const [radarLater, setRadarLater] = useState<HTMLSpanElement | null>(null);
  const step = steps[index];
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

  function move(delta: number) {
    const next = Math.max(0, Math.min(steps.length - 1, current.current + delta));
    if (next === current.current || completing.current || voice.phase === "saving") return;
    voice.cancel();
    outgoing.current?.remove();
    if (outgoingTimer.current) clearTimeout(outgoingTimer.current);
    const old = content.current?.cloneNode(true) as HTMLElement | undefined;
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
    (step === "radar" ? radarPrimary?.querySelector<HTMLButtonElement>("[data-radar-submit]") : primary.current)?.click();
  }

  const heading = step === "hello" ? `你好，${data.displayName}` : step === "company" ? `这是天枢里登记的${data.companyName || "公司"}` : step === "work" ? "你这个月的工作" : step === "radar" ? data.role === "ceo" ? "公司雷达，还要看什么？" : "你想关注哪些变化？" : step === "voiceprint" ? "让我在会上认出你的声音" : "可以开始了";
  const busy = finishing || voice.phase === "saving";
  const voiceReady = voice.status?.enrolled && !rerecord && voice.phase === "idle";
  const primaryDisabled = busy || (!error && step === "voiceprint" && !voiceReady && (voice.phase !== "recorded" || voice.tooShort));
  const disabledHint = step === "voiceprint" && primaryDisabled && !busy
    ? voice.recording ? "录好后再继续，也可以选「稍后」" : voice.tooShort ? "请重新录满 15 秒，或者选「稍后」" : voice.consent ? "录好一段 15–30 秒的朗读，或者选「稍后」" : "先勾选同意并录好，或者选「稍后」"
    : null;
  const primaryLabel = finishing ? "正在进入…" : step === "hello" ? "开始" : step === "start" ? returnPath ? "继续刚才的页面" : data.next.action : step === "voiceprint" ? voice.phase === "saving" ? "正在保存…" : voice.phase === "recorded" ? "保存并继续" : voiceReady ? "下一步" : "录好后继续" : "下一步";

  return <main className={s.page} onKeyDown={onKeyDown} style={{ "--direction": direction } as CSSProperties}>
    <MorningCanvas progress={index} />
    <header className={s.header}>
      <div className={s.brand} aria-label="天枢"><TianshuMark /><span>天枢</span></div>
      {step !== "start" ? <button type="button" className={f.textButton} onClick={() => void finish()} disabled={busy}>先进入工作台</button> : null}
    </header>
    <div className={s.flow} data-step={step}>
      <CoAgentCapsule acknowledge={acknowledge} state={voice.recording ? "listening" : "idle"} level={voice.level} />
      <div className={s.stage}>
        <div className={s.content} key={step} ref={content} data-step={step}>
          <div className={s.intro}>
            <h1 ref={title} tabIndex={-1}>{heading}</h1>
            {step === "hello" ? <><p className={s.subtitle}>我是你的 Co-Agent</p><p className={s.description}>我先带你看看这个月和你有关的工作。<br />{data.voiceprint.configured ? "雷达和声纹" : "雷达"}，可以现在设，也可以以后再说。</p></> : null}
            {/* 「这里改的是公司雷达。」由编辑器顶部那一行说，同一屏不重复。 */}
            {step === "radar" && data.role === "ceo" ? <p className={s.description}>我会按你签发的本月目标自动关注；你还可以补充方向和来源。</p> : null}
            {step === "voiceprint" ? <p className={s.description}>录一段 15–30 秒的朗读，帮我在会后建议哪些发言可能来自你——最后仍由人核对。</p> : null}
            {step === "start" && !returnPath ? <p className={s.description}>{data.next.text}</p> : null}
          </div>
          <div className={s.details}>
            {step === "company" && data.role === "ceo" ? <CompanySnapshot data={data} /> : null}
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
            {step === "start" ? <p className={s.summary}>
              <span className={s.summaryItem}>{radarSummaryLine(data.role, radarSaved ?? data.radar)}</span>
              {data.voiceprint.configured ? <span className={s.summaryItem}>声纹 · {voice.status?.enrolled ? "已录好" : "稍后在个人菜单里录"}</span> : null}
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
        {step === "radar" && !error ? <div key={step} ref={setRadarPrimary} className={s.radarActions} /> : <button key={step} ref={primary} className={f.primary} type="button" onClick={() => void forward()} disabled={primaryDisabled} aria-describedby={disabledHint ? "welcome-action-hint" : undefined}>{error ? "重试" : primaryLabel}{!busy ? <ArrowRight size={18} aria-hidden="true" /> : null}</button>}
        <div className={s.secondary}>
          {index > 0 ? <button className={f.textButton} type="button" onClick={() => move(-1)} disabled={busy}>上一步</button> : null}
          {step === "voiceprint" ? <button className={f.textButton} type="button" onClick={() => move(1)} disabled={busy}>稍后</button> : null}
          {step === "radar" ? <span ref={setRadarLater} className={s.radarSlot} /> : null}
        </div>
      </footer>
    </div>
  </main>;
}
