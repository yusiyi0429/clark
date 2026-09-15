"use client";

import { TianshuMark } from '@/components/brand/tianshu-mark';
import { ReferenceButton } from './card-references';
import { cardReference } from '@/lib/warmap/card-reference';
import { signalReference } from './reference-model';
import { currentHeavyMaterials } from './heavy-workspace';
import { todayMeetings } from './meeting-model';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowUpRight, Check, RotateCcw, X } from "lucide-react";
import s from "./notifications.module.css";
import { decisionMeta, type DecisionRecords, type DecisionReceipt, type HeavyNoticeId } from "./decision-model";
import type { Signal } from '@/lib/warmap/radar-types';
import type { IssueId } from "./model";
import { LockScreenButton } from '@/components/log-out-button';

type NoticeId = "confirmation" | "agenda" | "inquiry" | "monthly";
type Receipt = { label: string; detail?: string };
type Receipts = Partial<Record<NoticeId, Receipt>>;
const STORAGE_KEY = "tianshu-warmap-notices-v1";
const DEFAULT_DECISION = "在交付力量有限的情况下，优先支持灯塔项目";
const INQUIRY = "首次交付承诺，是否必须包含语音体验？";
const NOTICE_ORDER: NoticeId[] = ["confirmation", "agenda", "inquiry", "monthly"];
// Retain the existing transparency score for queue order; card material and text no longer fade with this score.
const TRANSPARENCY: Record<NoticeId, number> = { confirmation: 0, agenda: 0.04, inquiry: 0.25, monthly: 0.3 };
const COLORS: Record<NoticeId, string> = { confirmation: "100 123 155", agenda: "65 68 74", inquiry: "100 123 155", monthly: "153 128 88" };

export function noticeOrder(receipts: Receipts): NoticeId[] {
  return [...NOTICE_ORDER].sort((a, b) =>
    noticeTransparency(a, receipts) - noticeTransparency(b, receipts) || NOTICE_ORDER.indexOf(a) - NOTICE_ORDER.indexOf(b));
}

export function noticeTransparency(id: NoticeId, receipts: Receipts): number {
  if (id === "inquiry" && ["已保存回复", "已升级为议题"].includes(receipts[id]?.label || "")) return TRANSPARENCY[id];
  return receipts[id] ? 0.68 : TRANSPARENCY[id];
}

export function readNoticeReceipts(raw: string | null): Receipts {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: Receipts = {};
    for (const id of NOTICE_ORDER) {
      const item = (value as Record<string, unknown>)[id];
      if (item && typeof item === "object" && "label" in item && typeof item.label === "string") {
        result[id] = { label: item.label, detail: "detail" in item && typeof item.detail === "string" ? item.detail : undefined };
      }
    }
    return result;
  } catch { return {}; }
}

function LocalDateTime({onHome,homeActive}:{onHome?:()=>void;homeActive?:boolean}) {
  // The server and initial client render reserve the same space; the clock is local to this browser.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    let timer: number;
    const update = () => {
      const current = new Date();
      setNow(current);
      timer = window.setTimeout(update, 60_000 - current.getTime() % 60_000 + 20);
    };
    const resume = () => {
      if (document.visibilityState !== "visible") return;
      window.clearTimeout(timer);
      update();
    };
    timer = window.setTimeout(update, 0);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, []);

  return <header className={s.railClock} data-testid="notification-clock">
    <LockScreenButton compact className={s.railLock}/>
    <button type="button" className={s.homeCapsule} onClick={onHome} aria-label="天枢，返回首页" aria-current={homeActive?'page':undefined}>
      <TianshuMark className={s.clockLogo}/>
      <span className={s.railDate}><span>{now?.toLocaleDateString("zh-CN", { month: "long", day: "numeric" })}</span><span className={s.railWeekday}>{now?.toLocaleDateString("zh-CN", { weekday: "long" })}</span></span>
      <time dateTime={now?.toISOString()}>{now?.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}</time>
    </button>

  </header>;
}

function NotificationGlassHeader({ scope, kind, time }: { scope: string; kind: string; time: string }) {
  return <header className={s.notificationGlassHeader}>
    <span className={s.notificationGlyph} aria-hidden="true"><TianshuMark className={s.notificationGlyphMark}/></span>
    <span className={s.notificationIdentity}><strong>天枢 · {scope}</strong><small>{kind}</small></span>
    <time>{time}</time>
  </header>;
}

export function NotificationRail({ onHome, homeActive, radarSignals, onRadarSignal, onPromote, onUndoPromote, onNoticeCaption, decisions, onDecision, onUndoDecision, heavyNotice, onOpenHeavy, heavyCompletions }: {
  onHome?:()=>void;
  homeActive?:boolean;
  radarSignals?: Signal[];
  onRadarSignal?: (id:string) => void;
  onPromote: (title: string) => void;
  onUndoPromote?: (title: string) => void;
  onOpenMonthly?: () => void;
  onNoticeCaption?: (text: string) => void;
  decisions?: DecisionRecords;
  onDecision?: (receipt: DecisionReceipt) => void;
  onUndoDecision?: (id: IssueId) => void;
  heavyNotice?: HeavyNoticeId | null;
  onOpenHeavy?: (id: HeavyNoticeId) => void;
  heavyCompletions?: Partial<Record<HeavyNoticeId, string>>;
}) {
  const [localReceipts, setReceipts] = useState<Receipts>({});
  const receipts: Receipts = { ...localReceipts };
  // Shared decisions are authoritative. Old notification receipts cannot revive a resolved issue.
  if (decisions !== undefined) {
    delete receipts.confirmation;
    if (localReceipts.inquiry?.label === "已确认交付范围") delete receipts.inquiry;
    for (const [issueId, noticeId] of [["capacity", "confirmation"], ["voice", "inquiry"]] as const) {
      const value = decisions[issueId];
      if (value) receipts[noticeId] = { label: value.status === "deferred" ? "已暂缓决策" : "已确认决策", detail: value.summary };
    }
  }
  const [open, setOpen] = useState<string | null>(null);
  const [active, setActive] = useState<NoticeId | null>(null);
  const [closing, setClosing] = useState(false);
  const [frozenReceipts, setFrozenReceipts] = useState<Receipts>({});
  const [draft, setDraft] = useState(DEFAULT_DECISION);
  const [reply, setReply] = useState("");
  const [voiceChoice, setVoiceChoice] = useState("");
  const [monthlyNote, setMonthlyNote] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [storageError, setStorageError] = useState(false);
  const rail = useRef<HTMLElement>(null);
  const floatingCard = useRef<HTMLElement>(null);
  const sourceCard = useRef<HTMLElement | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const motion = useRef<Animation | null>(null);
  const closingRef = useRef(false);
  const positions = useRef(new Map<string, number>());
  const restored = useRef(false);
  const order = noticeOrder(active || heavyNotice ? frozenReceipts : receipts);

  function openNotice(id: NoticeId, mode?: string) {
    if (id === "agenda") {
      openMeeting(todayMeetings.find(meeting => meeting.id === mode)?.reviewId || todayMeetings[0].reviewId);
      return;
    }
    if (id === "monthly" && onOpenHeavy) {
      if (!heavyNotice) setFrozenReceipts(receipts);
      setActive(null); setOpen(null); onOpenHeavy(id); return;
    }
    if (active === id) { setOpen(mode || null); return; }
    sourceCard.current = rail.current?.querySelector<HTMLElement>(`[data-notice="${id}"]`) || null;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFrozenReceipts(receipts);
    setAnnouncement("");
    closingRef.current = false;
    setClosing(false);
    setOpen(mode || ({ agenda: "meeting-1", inquiry: "inquiry", monthly: "monthly", confirmation: "review" } as const)[id]);
    setActive(id);
  }

  function openMeeting(id: HeavyNoticeId) {
    if (!onOpenHeavy) { setAnnouncement('预审工作区暂不可用，请稍后重试。'); return; }
    if (!heavyNotice) setFrozenReceipts(receipts);
    setActive(null); setOpen(null); onOpenHeavy(id);
  }

  function originTransform() {
    const from = sourceCard.current?.getBoundingClientRect();
    const to = floatingCard.current?.getBoundingClientRect();
    if (!from || !to) return "translateY(15px) scale(.95)";
    return `translate(${from.left + from.width / 2 - to.left - to.width / 2}px,${from.top + from.height / 2 - to.top - to.height / 2}px) scale(${from.width / to.width},${from.height / to.height})`;
  }

  function closeNotice() {
    if (!active || closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    const element = floatingCard.current;
    motion.current?.cancel();
    const finish = () => {
      setActive(null); setOpen(null); setClosing(false); closingRef.current = false;
      requestAnimationFrame(() => {
        if (document.activeElement?.closest('[data-testid="global-controls"]')) return;
        if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
        else sourceCard.current?.focus({ preventScroll: true });
      });
    };
    if (!element || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { finish(); return; }
    const target = originTransform();
    motion.current = element.animate([{ transform: "none", opacity: 1 }, { transform: target, opacity: 0.15 }], { duration: 250, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" });
    motion.current.finished.then(finish).catch(() => {});
  }

  useLayoutEffect(() => {
    const element = floatingCard.current;
    if (!active || !element) return;
    motion.current?.cancel();
    motion.current = element.animate([{ transform: originTransform(), opacity: .35 }, { transform: "none", opacity: 1 }], { duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 340, easing: "cubic-bezier(.22,1,.36,1)" });
    element.querySelector<HTMLButtonElement>("[data-close-notice]")?.focus({ preventScroll: true });
    return () => motion.current?.cancel();
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopImmediatePropagation(); closeNotice();
    };
    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  });

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (restored.current) return;
      restored.current = true;
      try {
        const saved = readNoticeReceipts(localStorage.getItem(STORAGE_KEY));
        setReceipts(saved);
        // Restore the shared issue entry once, including under Strict Mode effect replay.
        if (decisions === undefined) {
          if (saved.inquiry?.label === "已升级为议题") onPromote(INQUIRY);
          else onUndoPromote?.(INQUIRY);
        }
      }
      catch { setStorageError(true); }
    });
    return () => cancelAnimationFrame(frame);
  }, [onPromote, onUndoPromote, decisions]);

  function saveReceipts(next: Receipts) {
    setReceipts(next);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); }
    catch { setStorageError(true); }
  }

  useLayoutEffect(() => {
    if (!rail.current || active || heavyNotice) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rail.current.querySelectorAll<HTMLElement>("[data-notice]").forEach((node) => {
      const key = node.dataset.notice!;
      // FLIP must compare positions inside the scrollable list. Viewport
      // coordinates change when the user scrolls and were mistaken for a
      // reorder the first time a secondary workspace closed.
      const top = node.offsetTop;
      const previous = positions.current.get(key);
      if (!reduced && previous !== undefined && Math.abs(previous - top) > 1) {
        node.animate([{ transform: `translateY(${previous - top}px)` }, { transform: "translateY(0)" }], { duration: 420, easing: "cubic-bezier(.22,1,.36,1)" });
      }
      positions.current.set(key, top);
    });
  }, [localReceipts, decisions, active, heavyNotice]);

  function commit(id: NoticeId, label: string, detail?: string) {
    setOpen(null);
    saveReceipts({ ...localReceipts, [id]: { label, detail } });
    if (id === "confirmation") onDecision?.({ issueId: "capacity", status: "decided", summary: detail || DEFAULT_DECISION });
    if (id === "inquiry" && label === "已确认交付范围") onDecision?.({ issueId: "voice", status: "decided", summary: detail || "" });
    setAnnouncement(`${label}。仅保存在本机原型，可以撤回。`);
    onNoticeCaption?.(`${label}，仅保存为本机演示记录。`);
  }

  function undo(id: NoticeId) {
    if (id === "inquiry" && receipts.inquiry?.label === "已升级为议题") onUndoPromote?.(INQUIRY);
    if (id === "confirmation") onUndoDecision?.("capacity");
    if (id === "inquiry" && decisions?.voice) onUndoDecision?.("voice");
    const next = { ...localReceipts }; delete next[id]; saveReceipts(next);
    setAnnouncement("已撤回本机确认，通知恢复待处理。");
    setOpen(null);
  }

  function toggle(name: string) { setOpen((value) => value === name ? null : name); }

  useEffect(() => {
    if (open !== "amend" && open !== "reply") return;
    const frame = requestAnimationFrame(() => {
      rail.current?.querySelector<HTMLTextAreaElement>(`#notice-${open}`)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, active]);

  function receipt(id: NoticeId, floating: boolean, values: Receipts) {
    const value = values[id];
    return value ? <div className={s.receipt}>
      <span><Check size={14} aria-hidden="true" />{value.label}</span>
      <button type="button" onClick={() => floating ? undo(id) : openNotice(id, id === "inquiry" ? "inquiry" : "receipt")} aria-label={`${floating ? "撤回" : "查看"}${value.label}`}>{floating ? <RotateCcw size={13} aria-hidden="true" /> : <ArrowUpRight size={13} aria-hidden="true" />}{floating ? "撤回" : "查看"}</button>
    </div> : null;
  }

  function renderCards(floating: boolean, receipts: Receipts) {
  function expansion(name: string, children: React.ReactNode) {
    if (!floating && (active || !["amend", "reply"].includes(name))) return null;
    return <div data-notice-editor className={`${s.expansion} ${open === name ? s.expanded : ""}`} inert={open !== name} onKeyDown={(event) => { if (!floating && event.key === "Escape") { event.stopPropagation(); setOpen(null); } }}>
      <div><div className={s.expansionBody}>{children}</div></div>
    </div>;
  }

  const cards: Record<NoticeId, React.ReactNode> = {
    confirmation: <>
      <NotificationGlassHeader scope="公司能力" kind="会后确认" time="刚刚" />
      <div className={`${s.notificationBody} ${s.confirmationBody}`}>
        <div className={s.confirmationGrid}>
          <div className={s.confirmationLabel}><h2>决策回执</h2><p>资源分配</p><time>9:00 - 10:00</time></div>
          <div className={s.confirmationMain}><p>{receipts.confirmation?.detail || DEFAULT_DECISION}</p>
            {!receipts.confirmation && <small className={s.urgentReason}>{decisionMeta.capacity.reason}</small>}
            {!receipts.confirmation && open !== "amend" && <div className={s.actions}>
              <button type="button" onClick={() => commit("confirmation", "已确认共识", DEFAULT_DECISION)}>确认</button>
              <button type="button" aria-expanded={open === "amend"} onClick={() => { setDraft(DEFAULT_DECISION); toggle("amend"); }}>修改</button>
            </div>}
          </div>
        </div>
        {floating && open === "review" && !receipts.confirmation && <p className={s.reviewHint}>请核对这条共识后确认。仅保存在本机，不会调整真实部署。</p>}
        {expansion("amend", <>
          <label className={s.fieldLabel} htmlFor="notice-amend">修改这条共识</label>
          <textarea id="notice-amend" value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} />
          <p className={s.hint}>本机演示。修改后确认，不会调整真实部署。</p>
          <div className={s.inlineActions}><button type="button" onClick={() => floating ? closeNotice() : setOpen(null)}>取消</button><button type="button" disabled={!draft.trim()} onClick={() => commit("confirmation", "已确认修改", draft.trim())}>确认修改 <Check size={14} /></button></div>
        </>)}
        {receipt("confirmation", floating, receipts)}
      </div>
    </>,
    agenda: <>
      {todayMeetings.map((meeting, index) => <div key={meeting.id}>
        {index > 0 && <div className={s.meetingDivider} />}
        <button type="button" className={s.meeting} data-meeting-id={meeting.id} data-heavy-notice={meeting.reviewId} aria-haspopup="dialog" aria-expanded={heavyNotice === meeting.reviewId} onClick={() => openMeeting(meeting.reviewId)}>
          <span className={`${s.meetingMark} ${index ? s.amber : ''}`} /><span><strong>{meeting.title}</strong><time>{meeting.time}</time><small>{heavyCompletions?.[meeting.reviewId] || '会前阅读'}</small></span><ArrowUpRight size={15} />
        </button>
      </div>)}
    </>,
    inquiry: <>
      <NotificationGlassHeader scope="灯塔项目" kind="负责人提请" time="1 小时前" />
      <div className={`${s.notificationBody} ${s.inquiryBody}`}>
        <button type="button" className={s.inquiryHead} aria-expanded={floating && open === "inquiry"} onClick={() => floating ? toggle("inquiry") : openNotice("inquiry")}>
          <span className={s.inquiryText}>{INQUIRY}</span>
          {!decisions?.voice && <small className={s.inquiryReason}>{decisionMeta.voice.reason}</small>}
        </button>
        {expansion("inquiry", <><p>交付前需要明确客户承诺：首版是否必须具备语音体验，或先验证核心决策价值后再补齐。</p><p className={s.hint}>负责人提请 · 演练案例。选择后明确确认，才会更新待决策议题。</p>
          {!(decisions !== undefined ? decisions.voice : localReceipts.inquiry?.label === "已确认交付范围") && <div className={s.decisionOptions}>
            {["首版包含语音体验", "首版先验证核心决策价值，暂不承诺语音体验"].map(choice => <button type="button" key={choice} aria-pressed={voiceChoice === choice} onClick={() => setVoiceChoice(choice)}>{choice}{voiceChoice === choice && <Check size={14} />}</button>)}
            <button type="button" className={s.confirmChoice} disabled={!voiceChoice} onClick={() => commit("inquiry", "已确认交付范围", voiceChoice)}>确认这个决定 <Check size={14} /></button>
          </div>}
        </>)}
        {!receipts.inquiry && open !== "reply" && <div className={s.actions}>
          <button type="button" onClick={() => { onPromote(INQUIRY); commit("inquiry", "已升级为议题"); }}>升级为议题</button>
          <button type="button" onClick={() => toggle("reply")} aria-expanded={open === "reply"}>Reply</button>
        </div>}
        {expansion("reply", <>
          <label className={s.fieldLabel} htmlFor="notice-reply">回复这条提请</label>
          <textarea id="notice-reply" placeholder="先把客户承诺与可选方案梳理清楚。" value={reply} onChange={(e) => setReply(e.target.value)} rows={3} />
          <p className={s.hint}>回复只保存在本机，不向任何人发送。</p>
          <div className={s.inlineActions}><button type="button" onClick={() => floating ? closeNotice() : setOpen(null)}>取消</button><button type="button" disabled={!reply.trim()} onClick={() => commit("inquiry", "已保存回复", reply.trim())}>保存回复 <Check size={14} /></button></div>
        </>)}
        {receipts.inquiry?.detail && <p className={s.savedReply}>{receipts.inquiry.detail}</p>}
        {receipt("inquiry", floating, receipts)}
      </div>
    </>,
    monthly: <>
      <NotificationGlassHeader scope="公司目标" kind="月度协商" time="今日" />
      <div className={`${s.notificationBody} ${s.monthlyBody}`}>
        <button type="button" className={s.monthlyHead} onClick={() => floating && !onOpenHeavy ? toggle("monthly") : openNotice("monthly")} aria-expanded={heavyNotice === "monthly" || (floating && open === "monthly")}><h2>月度目标与任务</h2><ArrowUpRight size={18} /></button>
        <div className={s.monthlyPreview}><span>9 月 · {heavyCompletions?.monthly || (receipts.monthly ? (receipts.monthly.detail ? "已反馈意见" : "已确认") : "待协商")}</span><button type="button" onClick={() => floating && !onOpenHeavy ? toggle("monthly") : openNotice("monthly")}>查看协商稿 <ArrowUpRight size={15} /></button><small className={s.heavyCase}>演练协商稿</small></div>
        {expansion("monthly", <>
          <div className={s.monthlySections}><div><span>本月目标</span><p>在真实客户场景验证 CEO 的持续使用，以及关键共识到负责人行动的闭环。</p></div><div><span>灯塔项目</span><p>验证客户自主使用的价值；明确 DRI 参与闭环的必要条件。</p></div><div><span>TokenOps</span><p>通过真实调用样本，验证成本可见与使用优化的价值。</p></div></div>
          {!receipts.monthly && <><label className={s.fieldLabel} htmlFor="notice-monthly-note">补充意见（可选）</label><textarea id="notice-monthly-note" value={monthlyNote} onChange={(e) => setMonthlyNote(e.target.value)} placeholder="需要调整的目标或边界…" rows={2} /><p className={s.hint}>演练协商稿，不是真实下发的目标。确认仅保存在本机。</p><div className={s.inlineActions}><button type="button" onClick={closeNotice}>稍后再看</button><button type="button" onClick={() => commit("monthly", monthlyNote.trim() ? "已记录协商意见" : "已确认演练目标", monthlyNote.trim())}>{monthlyNote.trim() ? "保存意见" : "确认目标"}<Check size={14} /></button></div></>}
          {receipts.monthly?.detail && <p>已记录意见：{receipts.monthly.detail}</p>}
        </>)}
        {receipt("monthly", floating, receipts)}
      </div>
    </>,
  };
  return cards;
  }

  const cards = renderCards(false, active ? frozenReceipts : receipts);
  const titles: Record<NoticeId, string> = { confirmation: "会后共识", agenda: "会议安排", inquiry: "负责人提请", monthly: "月度协商" };

  const referenceFor=(id:NoticeId)=>cardReference(`notice:${id}`,titles[id],'通知',[
    id==='confirmation'?`公司能力 · 资源分配\n${receipts.confirmation?.detail||DEFAULT_DECISION}`:
    id==='inquiry'?`灯塔项目 · ${INQUIRY}\n${decisionMeta.voice.reason}\n${receipts.inquiry?.detail||''}`:
    id==='agenda'?todayMeetings.map(meeting=>`${meeting.title} · ${meeting.time}\n${currentHeavyMaterials(meeting.reviewId)}\n状态：${heavyCompletions?.[meeting.reviewId]||'待预审'}`).join('\n\n'):currentHeavyMaterials(id),
    `处理状态：${receipts[id]?.label||heavyCompletions?.[id as HeavyNoticeId]||'待处理'}；引用不代表确认或提交。`
  ].join('\n'));

  return <aside className={s.rail} ref={rail} aria-label="通知与日程">
    <LocalDateTime onHome={onHome} homeActive={homeActive}/>
    <div className={s.noticeList} inert={!!active} data-obscured={!!active}>
    {radarSignals?.filter(signal=>signal.issue?.status==="pending"&&signal.issue.urgency==="red").map(signal=><section key={signal.id} className={`${s.card} ${s.radarUrgent}`} data-radar-notice={signal.id}><ReferenceButton corner item={signalReference(signal)}/><small>雷达 · 需要尽快判断</small><h2>{signal.issue!.title}</h2><p>{signal.issue!.reason}</p><button onClick={()=>onRadarSignal?.(signal.id)}>查看判断与依据 <ArrowUpRight size={15}/></button></section>)}
    {order.map((id) => <section key={id} data-attention={id === "confirmation" ? (receipts.confirmation ? "done" : "urgent") : id === "inquiry" ? (decisions?.voice ? "done" : "urgent") : id === "monthly" ? (receipts.monthly ? "done" : "review") : undefined} data-notice={id} data-heavy-notice={id === "monthly" ? id : undefined} data-selected={id === "agenda" ? todayMeetings.some(meeting => meeting.reviewId === heavyNotice) : heavyNotice === id} tabIndex={0} aria-label={`查看${titles[id]}`} onClick={(event) => { if (!(event.target as HTMLElement).closest("button, input, textarea, label, [data-notice-editor]")) openNotice(id); }} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openNotice(id); } }} className={`${s.card} ${s[id]} ${noticeTransparency(id, active ? frozenReceipts : receipts) >= 0.68 ? s.processed : ""}`} style={{ "--notice-alpha": 1 - noticeTransparency(id, active ? frozenReceipts : receipts), "--notice-color": COLORS[id] } as CSSProperties}><ReferenceButton corner item={referenceFor(id)}/>{cards[id]}</section>)}
    <div className={s.railFoot}>演示通知 · 处理记录仅保存在本机{storageError && <span>浏览器存储不可用，刷新后将重置</span>}</div>
    <div className={s.announcement} role="status" aria-live="polite">{announcement}{announcement && <button type="button" aria-label="关闭操作提示" onClick={() => setAnnouncement("")}><X size={13} /></button>}</div>
    </div>
    {active && <div className={`${s.noticeOverlay} ${closing ? s.overlayClosing : ""}`}>
      <button type="button" className={s.overlayBackdrop} aria-label="返回通知列表" tabIndex={-1} onClick={closeNotice} />
      <section ref={floatingCard} role="dialog" aria-modal="false" aria-label={titles[active]} data-active-notice={active} data-attention={active === "confirmation" ? (receipts.confirmation ? "done" : "urgent") : active === "inquiry" ? (decisions?.voice ? "done" : "urgent") : active === "monthly" ? (receipts.monthly ? "done" : "review") : undefined} className={`${s.card} ${s[active]} ${s.floatingCard}`} style={{ "--notice-alpha": .97, "--notice-color": COLORS[active] } as CSSProperties}>
        <header className={s.floatingHeader}><span>{titles[active]}</span><ReferenceButton item={referenceFor(active)}/><button type="button" data-close-notice aria-label="关闭通知，返回列表" onClick={closeNotice} disabled={closing}><X size={18} /></button></header>
        <div className={s.floatingScroll}>{renderCards(true, receipts)[active]}{announcement && <p className={s.floatingAnnouncement} role="status">{announcement}</p>}</div>
      </section>
    </div>}
  </aside>;
}

