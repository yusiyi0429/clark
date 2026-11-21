"use client";

/**
 * 「开会」（设计 2026-11-12 第二节；11/17 设计 4.1 起在左栏「会议」行行尾）：伙伴就是陪你开会、替你记的那个。
 * - 平时：一颗小图标按钮（AudioLines），点开小弹层——我主持、现在能开的已约会议排最上（点一行就开那场），下面「新的一场」：
 *   「现场 | 远程」二选一，标题、关于（挂点）预填好，CEO 多一行主持人，远程多一行参会人；焦点在主按钮上，回车就开，Esc 关；
 *   左下「预约会议」打开约会议侧栏（以后开的会）。
 * - 开着会：按钮就地变成走秒胶囊「● 12:34」（麦克风没给是「没录上音」）；点胶囊出一小块，「这场会开完了」才停，不一按就停。
 * - 开完：停录、传完最后一片、通知服务端录完、记开完（meeting.end）；胶囊写「整理中 0:42」，录音转出会议记录候选后变「记录待确认」。
 *   没录上音的直接去这场会的会议页（贴妙记、传会议记录）。开始、录上、开完、整理完都发 MEETING_CHANGED，开着的会议页跟着重取。
 * - 录音挂在首页外壳上（useHomeMeeting 在 HomeFrame 里），新首页里切页不断；开着的会记在本机（localStorage），刷新后回来是「录音断了」，
 *   服务端那份录音还停在一半就能接着录，否则只给开完。离开新首页去旧页面时外壳卸下，录音照老规矩停下并交给服务端（不丢已录的）。
 * - 弹层里的会议标题、已约那几场行尾的箭头、「记录待确认」都去这场会的会议页（/me/work/meetings/:id）；
 *   服务端的「等你」要等说话人确认、出会议卡以后才有会议那一行，所以录音转完先在胶囊上提醒。
 * 服务端的录音、转写、会后抽取这条链一点不动，只接已有接口：POST /api/meetings、/api/meetings/:id/recordings…、GET /api/me/meetings、
 * GET /api/world-anchor-options、/api/actions/execute 的 meeting.end。
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Popover } from "@heroui/react";
import { Button as Pressable } from "react-aria-components";
import { ArrowUpRight, AudioLines, Pencil, X } from "lucide-react";
import type { TMeetingBookingRequest, TWorldAnchor, TWorldAnchorOption } from "@warmap/contracts";
import { browserApi, type Card } from "@/lib/api/client";
import type { Account } from "@/components/AccountMenu";
import { HeroButton } from "@/components/HeroButton";
import { SegmentedSwitch, type Segment } from "@/components/SegmentedSwitch";
import { Select } from "@/components/ui/Select";
import type { MeetingPayload } from "@/cards/payloads";
import { useMeetingRecorder } from "@/components/meeting/useMeetingRecorder";
import { BOOK_ERROR, MeetingBookingSheet } from "@/components/meeting/MeetingBookingSheet";
import { instantMeetingPayload } from "@/components/meeting/instantMeeting";
import { bookMeeting, listPeople, listPersonDirectory, listWorldAnchorOptions, type DirectoryPerson } from "@/components/meeting/meetingDecisionApi";
import { WorldAnchorPicker } from "@/components/meeting/WorldAnchorPicker";
import { companyMonth } from "@/lib/companyTime";
import { feishuConnectHref, readFeishuConnection, type FeishuConnection } from "@/lib/feishuLogin";
import { refreshWorkspace } from "@/lib/toast";
import { announceMeeting, defaultMeetingTitle, elapsed, meetingHref, meetingSpan, startableMeetings } from "@/lib/home/meeting";
import { usePartnerMeetings } from "@/lib/home/partnerMeetingFeed";
import { ICON } from "./StateIcon";
import { HomeMeetingContext, useHomeMeetingState, type HomeMeetingState } from "./meetingState";
import h from "@/styles/home.module.css";
import s from "./partner-meetings.module.css";

/**
 * 开着的这场会（本机记着，刷新后接上）。audio：这场会在录音（麦克风给了）；recordingId：服务端那份录音
 * （成员看的会议卡上没有录音状态，进度按这份录音查）。
 */
export type LiveMeeting = { id: string; title: string; startedAt: number; audio: boolean; recordingId?: string };
export type MeetingPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  /**
   * broken：录着的时候页面刷新、关过或离开过新首页，这台电脑上的录音停了；
   * resumable：服务端那份录音还停在一半（或还没录上），能在同一份上接着录。
   */
  | { kind: "live"; meeting: LiveMeeting; broken?: boolean; resumable?: boolean }
  | { kind: "organizing"; meeting: LiveMeeting; since: number }
  | { kind: "ready"; meeting: LiveMeeting }
  /**
   * retry：「end」是记开完那一下没成，「finish」是录音没交上服务端（服务端没配好转写时录音留着，再交一次就行），都能再按一次；
   * 没有是录音交上了、转写没成（服务端没有重试）。
   */
  | { kind: "failed"; meeting: LiveMeeting; error: string; retry?: "end" | "finish" };

type Recording = { status: "recording" | "uploading" | "transcoding" | "transcribing" | "done" | "failed"; error: string | null };

const STORE = "tianshu.homeMeeting";
const LAST_HOST = "tianshu.homeMeeting.host";
const POLL_MS = 5000;

const read = <T,>(key: string): T | null => {
  try { const raw = window.localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : null; } catch { return null; }
};
const write = (key: string, value: unknown) => {
  try { if (value === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存不下就只是刷新后接不上 */ }
};

async function loadCard(id: string, role: Account["role"]): Promise<Card | null> {
  try {
    if (role === "ceo") return (await browserApi.GET("/api/cards/meetings/{id}", { params: { path: { id } } })).data?.cards?.[0] ?? null;
    return (await browserApi.GET("/api/me/cards/meetings/{id}", { params: { path: { id } } })).data ?? null;
  } catch {
    return null;
  }
}
const payload = (card: Card) => card.payload as MeetingPayload;
const recordingBase = (meeting: LiveMeeting) => `/api/meetings/${encodeURIComponent(meeting.id)}/recordings/${encodeURIComponent(meeting.recordingId ?? "")}`;

/** 这场会的那份录音走到哪一步；没有录音、读不到为 null。 */
async function loadRecording(meeting: LiveMeeting): Promise<Recording | null> {
  if (!meeting.recordingId) return null;
  const response = await fetch(recordingBase(meeting)).catch(() => null);
  return response?.ok ? ((await response.json().catch(() => null)) as Recording | null) : null;
}
/** 录音已经交给服务端在转（转码、上传、识别）。 */
const handedOff = (recording: Recording | null) => Boolean(recording && ["uploading", "transcoding", "transcribing"].includes(recording.status));

/** 记「这场会开完了」（meeting.end）；已经记过算成。版本对不上时换最新的卡再来一次。 */
async function endMeeting(id: string, role: Account["role"]): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await loadCard(id, role);
    if (!current) return false;
    if (payload(current).endedAt || payload(current).status !== "scheduled") return true;
    const action = current.actions.find((entry) => entry.actionType === "meeting.end");
    if (!action) return false;
    const { response } = await browserApi.POST("/api/actions/execute", { body: { actionId: action.actionId, input: {} } }).catch(() => ({ response: null }));
    if (response?.ok) return true;
    if (response?.status !== 409) return false;
  }
  return false;
}

/** 首页外壳持有的开会状态：录音、计时、开完以后等记录，切页不断。 */
export function useHomeMeeting({ account, go }: { account: Account; go: (href: string) => void }) {
  const [phase, setPhaseState] = useState<MeetingPhase>({ kind: "idle" });
  const meeting = "meeting" in phase ? phase.meeting : null;
  const recorder = useMeetingRecorder(meeting?.id ?? "");
  const pendingStart = useRef(false);
  const currentPhase = useRef<MeetingPhase["kind"]>("idle");
  const role = account.role;
  const setPhase = useCallback((next: MeetingPhase) => {
    currentPhase.current = next.kind;
    setPhaseState(next);
    write(STORE, next.kind === "idle" || next.kind === "starting" ? null : next);
  }, []);

  // 刷新后接上：本机记着的会还开着，录着音的就是「录音断了」（没录音的照样走秒），开完了的接着等记录。
  useEffect(() => {
    const saved = read<MeetingPhase>(STORE);
    if (!saved || !("meeting" in saved)) return;
    let live = true;
    void Promise.all([loadCard(saved.meeting.id, role), loadRecording(saved.meeting)]).then(([card, recording]) => {
      if (!live) return;
      const now = card ? payload(card) : null;
      if (!now || now.status === "cancelled") return setPhase({ kind: "idle" });
      if (saved.kind === "live" && now.status === "scheduled" && !now.endedAt) {
        return setPhase(saved.meeting.audio
          ? { kind: "live", meeting: saved.meeting, broken: true, resumable: !recording || recording.status === "recording" }
          : { kind: "live", meeting: saved.meeting });
      }
      if (saved.kind === "live" || saved.kind === "organizing") {
        if (recording?.status === "done") return setPhase({ kind: "ready", meeting: saved.meeting });
        if (recording?.status === "failed") return setPhase({ kind: "failed", meeting: saved.meeting, error: recording.error ?? "没整理出来" });
        return setPhase(handedOff(recording) ? { kind: "organizing", meeting: saved.meeting, since: saved.kind === "organizing" ? saved.since : Date.now() } : { kind: "idle" });
      }
      if (saved.kind === "ready" && !now.transcriptCandidate) return setPhase({ kind: "idle" });
      setPhase(saved);
    });
    return () => { live = false; };
    // 只在打开首页时接一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 建好会、换好录音的会议 id 之后再开录（录音按会议 id 走）。
  useEffect(() => {
    if (!meeting?.id || !pendingStart.current) return;
    pendingStart.current = false;
    void recorder.start();
  }, [meeting?.id, recorder]);

  // 录上了：记下服务端那份录音（刷新后接着录、开完后查进度都按它）。麦克风没给、不支持、录音没起来：照样计时，记下没录音。
  const { status, recordingId } = recorder.state;
  useEffect(() => {
    if (phase.kind !== "live" || phase.broken) return;
    if (status === "recording" && recordingId && phase.meeting.recordingId !== recordingId) setPhase({ ...phase, meeting: { ...phase.meeting, recordingId, audio: true } });
    else if (phase.meeting.audio && (status === "denied" || status === "unsupported" || status === "failed")) setPhase({ ...phase, meeting: { ...phase.meeting, audio: false } });
  }, [status, recordingId, phase, setPhase]);
  // 录上了（开始、接着录）：开着的会议页重取一次。
  const meetingId = meeting?.id;
  useEffect(() => { if (status === "recording" && meetingId) announceMeeting(meetingId); }, [status, meetingId]);

  /** 开一场：已约的直接开，新的一场先建会。没开成回一句短话。 */
  const start = useCallback(async (target: { meetingId: string; title: string } | { book: TMeetingBookingRequest }): Promise<string | null> => {
    if (currentPhase.current !== "idle") return "已经有一场会在进行";
    setPhase({ kind: "starting" });
    let id: string;
    let title: string;
    if ("book" in target) {
      const result = await bookMeeting(target.book).catch(() => ({ code: "FAILED" }));
      if ("code" in result) { setPhase({ kind: "idle" }); return BOOK_ERROR[result.code] ?? "没开成"; }
      id = result.card.objectRef.id;
      title = target.book.title;
      window.dispatchEvent(new Event("meeting-changed"));
    } else {
      id = target.meetingId;
      title = target.title;
    }
    pendingStart.current = true;
    setPhase({ kind: "live", meeting: { id, title, startedAt: Date.now(), audio: true } });
    announceMeeting(id);
    return null;
  }, [setPhase]);

  /** 录音断了：在同一场会上接着录（服务端还是那一份录音，片的序号往后接）。 */
  const resume = useCallback(() => {
    if (phase.kind !== "live" || !phase.resumable) return;
    setPhase({ kind: "live", meeting: phase.meeting });
    void recorder.start();
  }, [phase, recorder, setPhase]);

  /** 这场会开完了：停录、传完、交给服务端转写，记开完；有录音的接着等记录。 */
  const end = useCallback(async () => {
    if (!meeting || (phase.kind !== "live" && !(phase.kind === "failed" && phase.retry))) return;
    const since = Date.now();
    setPhase({ kind: "organizing", meeting, since });
    let handed = false;
    let failure: string | null = null;
    if (status === "recording" || status === "starting") {
      handed = await recorder.stop();
      if (!handed) failure = "录音没交上";
    } else {
      const recording = await loadRecording(meeting);
      if (recording?.status === "recording") {
        // 刷新后停在一半的那份：告诉服务端录完了，已经传上去的照样转写。
        const response = await fetch(`${recordingBase(meeting)}/finish`, { method: "POST" }).catch(() => null);
        handed = Boolean(response?.ok);
        if (!handed) failure = "录音没交上";
      } else {
        handed = handedOff(recording) || recording?.status === "done";
      }
    }
    const ended = await endMeeting(meeting.id, role);
    window.dispatchEvent(new Event("meeting-changed"));
    announceMeeting(meeting.id);
    if (!ended) return setPhase({ kind: "failed", meeting, error: "没记上开完", retry: "end" });
    if (failure) return setPhase({ kind: "failed", meeting, error: failure, retry: "finish" });
    if (handed) return setPhase({ kind: "organizing", meeting, since });
    // 没录上音：没有记录可等，直接去这场会的会议页（贴妙记链接、上传会议记录都在那里），不然这场会就停在「待交记录」没人提醒。
    setPhase({ kind: "idle" });
    go(meetingHref(meeting.id));
  }, [meeting, phase, role, status, recorder, setPhase, go]);

  // 整理中：每 5 秒看一次这份录音走到哪一步；识别完（已写成会议记录候选）就是「记录待确认」。
  const organizing = phase.kind === "organizing" ? phase : null;
  useEffect(() => {
    if (!organizing) return;
    let live = true;
    const check = async () => {
      const recording = await loadRecording(organizing.meeting);
      if (!live || !recording) return;
      if (recording.status !== "done" && recording.status !== "failed") return;
      setPhase(recording.status === "done" ? { kind: "ready", meeting: organizing.meeting } : { kind: "failed", meeting: organizing.meeting, error: recording.error ?? "没整理出来" });
      announceMeeting(organizing.meeting.id);
    };
    const timer = window.setInterval(() => void check(), POLL_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [organizing, setPhase]);

  const dismiss = useCallback(() => setPhase({ kind: "idle" }), [setPhase]);
  /** 打开这场会的会议页（新首页里的 /me/work/meetings/:id），「会议」行上的胶囊收起。 */
  const open = useCallback(() => {
    if (!meeting) return;
    go(meetingHref(meeting.id));
    setPhase({ kind: "idle" });
  }, [meeting, go, setPhase]);

  return {
    phase, start, resume, end, dismiss, open, account, navigate: go,
    /** 开着会在录音：伙伴在听、跟着响度动。 */
    listening: phase.kind === "live" && status === "recording",
    /** 开着会（标签页标题前加「● 」）。 */
    live: phase.kind === "live",
  };
}
export type HomeMeeting = ReturnType<typeof useHomeMeeting>;

function useTick(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

/**
 * 外壳给名片、页头的开会状态（meetingState）：在录时每秒走一次，只让读它的地方跟着重画。
 * 「会议」行上的走秒胶囊也读这一份，和名片上的「● 12:34 在录」同一秒变。
 */
export function HomeMeetingProvider({ meeting, children }: { meeting: HomeMeeting; children: ReactNode }) {
  const live = meeting.listening && meeting.phase.kind === "live" ? meeting.phase.meeting : null;
  const now = useTick(Boolean(live));
  const value: HomeMeetingState = { listening: meeting.listening, clock: live ? elapsed(now - live.startedAt) : null, href: live ? meetingHref(live.id) : null };
  return <HomeMeetingContext.Provider value={value}>{children}</HomeMeetingContext.Provider>;
}

/** 「会议」行行尾那一颗：平时是图标按钮，开着会是走秒胶囊。 */
export function MeetingControl({ meeting, inline = false }: { meeting: HomeMeeting; inline?: boolean }) {
  const { phase } = meeting;
  const [open, setOpen] = useState(false);
  const [booking, setBooking] = useState(false);
  const slot = inline ? s.inlineSlot : h.meetSlot;
  const now = useTick(phase.kind === "live" || phase.kind === "organizing");
  const shared = useHomeMeetingState().clock;
  useEffect(() => { if (phase.kind === "organizing" || phase.kind === "ready") setOpen(false); }, [phase.kind]);

  if (phase.kind === "organizing") {
    return <span className={slot}><span className={h.meetPill} data-state="organizing" role="status" data-testid="meeting-pill">整理中 {elapsed(now - phase.since)}</span></span>;
  }
  if (phase.kind === "ready") {
    return <span className={slot}><Pressable className={h.meetPill} data-state="ready" onPress={meeting.open} data-testid="meeting-pill">记录待确认</Pressable></span>;
  }

  let trigger;
  let body;
  if (phase.kind === "live") {
    const quiet = !phase.broken && !phase.meeting.audio;
    trigger = (
      <Pressable className={h.meetPill} data-state={phase.broken ? "broken" : quiet ? "quiet" : "live"} aria-label={`会议中 · ${phase.meeting.title}`} data-testid="meeting-pill">
        <i aria-hidden />{phase.broken ? "会议中 · 录音断了" : `${shared ?? elapsed(now - phase.meeting.startedAt)}${quiet ? " · 没录上音" : ""}`}
      </Pressable>
    );
    body = (
      <>
        <MeetingLink id={phase.meeting.id} title={phase.meeting.title} go={(href) => { setOpen(false); meeting.navigate(href); }} />
        <p className={h.meetMeta}>已开 {elapsed(now - phase.meeting.startedAt)}</p>
        <div className={h.dialogActions}>
          {phase.broken ? phase.resumable ? <>
            <HeroButton variant="tertiary" onPress={() => { setOpen(false); void meeting.end(); }} data-testid="meeting-end">开完了</HeroButton>
            <HeroButton variant="primary" autoFocus onPress={() => { setOpen(false); meeting.resume(); }} data-testid="meeting-resume">接着录</HeroButton>
          </> : (
            <HeroButton variant="primary" autoFocus onPress={() => { setOpen(false); void meeting.end(); }} data-testid="meeting-end">开完了</HeroButton>
          ) : <>
            <HeroButton variant="tertiary" onPress={() => setOpen(false)}>继续开</HeroButton>
            <HeroButton variant="primary" autoFocus onPress={() => { setOpen(false); void meeting.end(); }} data-testid="meeting-end">这场会开完了</HeroButton>
          </>}
        </div>
      </>
    );
  } else if (phase.kind === "failed") {
    trigger = <Pressable className={h.meetPill} data-state="failed" data-testid="meeting-pill">{phase.retry === "end" ? "没开完" : "没整理出来"}</Pressable>;
    body = (
      <>
        <MeetingLink id={phase.meeting.id} title={phase.meeting.title} go={(href) => { setOpen(false); meeting.navigate(href); }} />
        <p className={h.meetMeta}>{phase.error}</p>
        <div className={h.dialogActions}>
          {phase.retry ? <>
            {phase.retry === "end"
              ? <HeroButton variant="tertiary" onPress={() => setOpen(false)}>取消</HeroButton>
              : <HeroButton variant="tertiary" onPress={() => { setOpen(false); meeting.dismiss(); }}>收起</HeroButton>}
            <HeroButton variant="primary" autoFocus onPress={() => { setOpen(false); void meeting.end(); }}>重试</HeroButton>
          </> : <>
            <HeroButton variant="tertiary" onPress={() => { setOpen(false); meeting.dismiss(); }}>收起</HeroButton>
            <HeroButton variant="primary" autoFocus onPress={() => { setOpen(false); meeting.open(); }}>打开会议</HeroButton>
          </>}
        </div>
      </>
    );
  } else {
    trigger = (
      <HeroButton variant="ghost" size="sm" isIconOnly={!inline} className={h.meetButton} title="现在开会" aria-label="现在开会" isDisabled={phase.kind === "starting"} data-testid="meeting-button">
        {inline ? "现在开会" : <AudioLines {...ICON} />}
      </HeroButton>
    );
    body = <StartForm meeting={meeting} onStarted={() => setOpen(false)} onBook={() => { setOpen(false); setBooking(true); }} />;
  }

  return (
    <span className={slot} data-testid="meeting-slot">
      <Popover isOpen={open} onOpenChange={setOpen}>
        {trigger}
        <Popover.Content placement="bottom end" offset={6} className={`${h.pop} ${h.meetPop}`}>
          <Popover.Dialog aria-label="开会" className={h.meetDialog} data-testid="meeting-pop">{body}</Popover.Dialog>
        </Popover.Content>
      </Popover>
      {booking && meeting.account.personId ? <MeetingBookingSheet open viewer={{ ...meeting.account, personId: meeting.account.personId }}
        onClose={() => setBooking(false)} /> : null}
    </span>
  );
}

/** 没按住修饰键的左键：站内跳转；按着 Ctrl/⌘/Shift 的照浏览器自己的（新标签页、新窗口）。 */
const plainClick = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/** 弹出那一小块里的会议标题：点了去这场会的会议页。 */
function MeetingLink({ id, title, go }: { id: string; title: string; go: (href: string) => void }) {
  return (
    <a className={h.meetTitle} href={meetingHref(id)} data-testid="meeting-title-link"
      onClick={(event) => { if (plainClick(event)) { event.preventDefault(); go(meetingHref(id)); } }}>{title}</a>
  );
}

type Mode = "local" | "remote";
const MODES: Segment<Mode>[] = [{ id: "local", label: "现场" }, { id: "remote", label: "远程" }];

/**
 * 弹层里：现在能开的已约会议 + 新的一场 + 左下「预约会议」（去约以后的会）。
 * 新的一场「现场 | 远程」二选一：现场是这台电脑录音；远程多一行参会人，按下就在飞书日历约一场现在开始的会、邀请他们，然后去会议页。
 * 远程要本人连好飞书日历（没连写「飞书日历未连接」和「去连接」，新标签页里连，回来窗口拿回焦点时再读一次）。
 */
export function StartForm({ meeting, onStarted, onBook }: { meeting: HomeMeeting; onStarted: () => void; onBook: () => void }) {
  const { account } = meeting;
  const me = account.personId ?? "";
  const ceo = account.role === "ceo";
  const [fallback] = useState(() => defaultMeetingTitle(new Date()));
  const [title, setTitle] = useState(fallback);
  const [naming, setNaming] = useState(false);
  const [mode, setMode] = useState<Mode>("local");
  const remote = mode === "remote";
  const feed = usePartnerMeetings();
  const booked = startableMeetings(feed.items, Date.now());
  const [options, setOptions] = useState<TWorldAnchorOption[] | null>(null);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [anchors, setAnchors] = useState<TWorldAnchor[]>([]);
  const [picking, setPicking] = useState(false);
  const [people, setPeople] = useState<{ personId: string; displayName: string }[]>([]);
  const [peopleFailed, setPeopleFailed] = useState(false);
  const [participants, setParticipants] = useState<string[]>([]);
  const [feishu, setFeishu] = useState<FeishuConnection | null>(null);
  const [hosts, setHosts] = useState<DirectoryPerson[]>([]);
  const [hostsFailed, setHostsFailed] = useState(false);
  const [host, setHost] = useState(() => (ceo ? read<string>(LAST_HOST) ?? "" : me));
  const [error, setError] = useState("");
  const [inviting, setInviting] = useState(false);
  const [retry, setRetry] = useState(0);
  const busy = meeting.phase.kind === "starting" || inviting;
  const startButton = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);
  const draftId = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    setOptionsFailed(false);
    setPeopleFailed(false);
    void listWorldAnchorOptions(companyMonth(new Date())).then((next) => {
      if (!live) return;
      setOptions(next);
    }, () => { if (live) setOptionsFailed(true); });
    void listPersonDirectory().then((next) => { if (live) setPeople(next); }, () => { if (live) setPeopleFailed(true); });
    if (ceo) {
      setHostsFailed(false);
      void listPeople().then((next) => {
        if (live) setHosts(next.filter((person) => person.roles.includes("dri")));
      }, () => { if (live) setHostsFailed(true); });
    }
    return () => { live = false; };
  }, [ceo, retry]);
  useEffect(() => {
    if (!remote) return;
    let live = true;
    const load = () => void readFeishuConnection().then((next) => { if (live) setFeishu(next); });
    load();
    window.addEventListener("focus", load);
    return () => { live = false; window.removeEventListener("focus", load); };
  }, [remote, retry]);

  const invitable = people.filter((person) => person.personId !== host && person.personId !== me && !participants.includes(person.personId));
  const canInvite = Boolean(feishu?.enabled && feishu.calendar && !peopleFailed);
  const ready = Boolean(title.trim() && host && (!ceo || hosts.some((person) => person.personId === host)) && !busy
    && (!remote || (canInvite && (participants.length || host !== me))));
  // 焦点落在主按钮上（回车就开）：挂点读到、能开的那一刻放过去；人已经在标题框里打字就不抢。
  useEffect(() => {
    if (!ready || focused.current) return;
    focused.current = true;
    if (document.activeElement?.tagName !== "INPUT") startButton.current?.focus();
  }, [ready]);
  const nameOf = (personId: string) => people.find((person) => person.personId === personId)?.displayName ?? "";
  const go = async (target: Parameters<HomeMeeting["start"]>[0]) => {
    setError("");
    const failed = await meeting.start(target);
    if (failed) { setError(failed); return; }
    onStarted();
  };
  // 远程：约一场现在开始的会、邀请参会人；没约成再按沿用同一预约（draftId），约成去会议页。
  const invite = async (book: TMeetingBookingRequest) => {
    setError(""); setInviting(true);
    try {
      const result = await bookMeeting(book);
      if ("code" in result) { setError(BOOK_ERROR[result.code] ?? "没有约成"); return; }
      window.dispatchEvent(new Event("meeting-changed"));
      refreshWorkspace();
      announceMeeting(result.card.objectRef.id);
      onStarted();
      meeting.navigate(result.card.navigation?.[0]?.href ?? meetingHref(result.card.objectRef.id));
    } catch {
      setError("没有约成");
    } finally {
      setInviting(false);
    }
  };
  const startNew = () => {
    if (!ready) return;
    if (ceo) write(LAST_HOST, host);
    draftId.current ??= crypto.randomUUID();
    const book = instantMeetingPayload({ title: title.trim(), at: Date.now(), participants: remote ? participants : [], anchors, draftId: draftId.current, ...(ceo ? { leadDriId: host } : {}) });
    void (remote ? invite(book) : go({ book }));
  };
  const switchMode = (next: Mode) => { setMode(next); setError(""); draftId.current = null; };
  // 改完名称：清空了回到默认名称；回车改完把焦点交回主按钮（再回车就开）。
  const doneNaming = (focusStart: boolean) => {
    if (!title.trim()) setTitle(fallback);
    setNaming(false);
    if (focusStart) startButton.current?.focus();
  };

  return (
    <>
      {booked.length ? (
        <ul className={h.meetBooked} aria-label="已约的会">
          {booked.map((entry) => (
            <li key={entry.meetingId}>
              <button type="button" className={h.menuItem} disabled={busy} onClick={() => void go({ meetingId: entry.meetingId, title: entry.title })} data-testid="meeting-booked">
                <span className={h.meetRowTitle}>{entry.title}</span><span className={h.menuFaint}>{meetingSpan(entry.at, entry.endsAt ?? null)}</span>
              </button>
              <a className={h.icon} href={meetingHref(entry.meetingId)} aria-label={`打开「${entry.title}」`} data-testid="meeting-booked-open"
                onClick={(event) => { if (plainClick(event)) { event.preventDefault(); onStarted(); meeting.navigate(meetingHref(entry.meetingId)); } }}>
                <ArrowUpRight {...ICON} />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {feed.error ? <p className={h.meetError} role="alert">{feed.error} <button type="button" onClick={feed.reload}>重试</button></p> : null}
      <div className={s.modeHead}>
        <p className={h.sectionTitle}>新的一场</p>
        {me ? <SegmentedSwitch label="怎么开" segments={MODES} selected={mode} onSelect={switchMode} /> : null}
      </div>
      {naming ? (
        <input className={h.projectName} aria-label="标题" value={title} maxLength={200} autoFocus data-testid="meeting-title"
          onChange={(event) => setTitle(event.currentTarget.value)} onBlur={() => doneNaming(false)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); doneNaming(true); } }} />
      ) : (
        <div className={h.meetNameRow}>
          <span className={h.meetName} title={title} data-testid="meeting-name">{title}</span>
          <button type="button" className={h.icon} aria-label="改名称" title="改名称" onClick={() => setNaming(true)}><Pencil {...ICON} /></button>
        </div>
      )}
      <div className={h.meetField} role="group" aria-label="关于">
        <span className={h.menuFaint}>关于</span>
        {anchors.length
          ? <span className={h.meetAnchor} title={anchors[0].title} data-testid="meeting-anchor">{anchors[0].title}</span>
          : <span className={h.meetAnchor} data-empty="">不挂</span>}
        {anchors.length ? <button type="button" className={h.icon} aria-label="不挂" title="不挂" onClick={() => { setAnchors([]); setPicking(false); }}><X {...ICON} /></button> : null}
        <button type="button" className={h.icon} aria-label="改关于" title="改关于" aria-pressed={picking} onClick={() => setPicking(!picking)}><Pencil {...ICON} /></button>
      </div>
      {picking ? options ? (
        <WorldAnchorPicker options={options} value={anchors} viewerId={me} nameOf={nameOf} company={ceo}
          onChange={(next) => { setAnchors(next); if (next[0]?.kind !== "po") setPicking(false); }} />
      ) : optionsFailed ? <p className={h.meetError}>没读到 <button type="button" onClick={() => setRetry(retry + 1)}>重试</button></p> : <p className={h.meetMeta}>正在读取</p> : null}
      {ceo ? (
        <div className={h.meetField}>
          <span className={h.menuFaint}>主持人</span>
          {hostsFailed ? <span className={h.meetError} role="alert">没读到主持人 <button type="button" onClick={() => setRetry(retry + 1)}>重试</button></span> :
            <Select aria-label="主持人" value={host} placeholder="选主持人" options={hosts.map((person) => ({ value: person.personId, label: person.displayName }))}
              onChange={(next) => { setHost(next); setParticipants((current) => current.filter((id) => id !== next)); }} />}
        </div>
      ) : null}
      {remote ? (
        <div className={h.meetField} role="group" aria-label="参会">
          <span className={h.menuFaint}>参会</span>
          {!feishu ? <span className={h.menuFaint}>正在读取</span>
            : !feishu.enabled ? <span className={h.meetError}>飞书日历暂不可用 <button type="button" onClick={() => setRetry(retry + 1)}>重试</button></span>
            : !feishu.calendar ? <span className={h.meetNote}>飞书日历未连接 <a href={feishuConnectHref(window.location.pathname)} target="_blank" rel="noopener">去连接</a></span>
            : peopleFailed ? <span className={h.meetError} role="alert">没读到同事 <button type="button" onClick={() => setRetry(retry + 1)}>重试</button></span>
            : (
              <div className={h.meetPeople}>
                {participants.map((personId) => (
                  <span key={personId} className={h.meetChip}>
                    {nameOf(personId)}
                    <button type="button" aria-label={`去掉 ${nameOf(personId)}`} onClick={() => setParticipants((current) => current.filter((id) => id !== personId))}>×</button>
                  </span>
                ))}
                <Select aria-label="添加参会人" size="compact" value="" placeholder="添加参会人" options={invitable.map((person) => ({ value: person.personId, label: person.displayName }))}
                  onChange={(personId) => { if (personId) setParticipants((current) => [...current, personId]); }} />
              </div>
            )}
        </div>
      ) : null}
      {error ? <p className={h.meetError} role="alert">{error}</p> : null}
      <div className={h.meetActions}>
        {me ? <HeroButton variant="tertiary" size="sm" isDisabled={busy} onPress={onBook}>预约会议</HeroButton> : <span />}
        <HeroButton ref={startButton} variant="primary" isDisabled={!ready} onPress={startNew} data-testid="meeting-start">{remote ? inviting ? "正在发起" : "发起会议" : "开始录音"}</HeroButton>
      </div>
    </>
  );
}
