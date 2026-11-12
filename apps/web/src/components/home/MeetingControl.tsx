"use client";

/**
 * 伙伴台上的「开会」（设计 2026-11-12 第二节）：伙伴就是陪你开会、替你记的那个，入口和会中状态都在伙伴台右下角。
 * - 平时：一颗小图标按钮（AudioLines），点开小弹层——我主持、现在能开的已约会议排最上（点一行就开那场），下面「新的一场」：
 *   标题、关于（挂点）预填好，CEO 多一行主持人；焦点在「开始」上，回车就开，Esc 关。
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
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { Popover } from "@heroui/react";
import { Button as Pressable } from "react-aria-components";
import { ArrowUpRight, AudioLines } from "lucide-react";
import type { TMeetingBookingRequest, TPickedWorldAnchor, TWorldAnchor, TWorldAnchorOption } from "@warmap/contracts";
import { browserApi, type Card } from "@/lib/api/client";
import type { Account } from "@/components/AccountMenu";
import { HeroButton } from "@/components/HeroButton";
import { Select } from "@/components/ui/Select";
import type { MeetingPayload } from "@/cards/payloads";
import { useMeetingRecorder } from "@/components/meeting/useMeetingRecorder";
import { BOOK_ERROR } from "@/components/meeting/MeetingBookingSheet";
import { bookMeeting, listPeople, listPersonDirectory, listWorldAnchorOptions, type DirectoryPerson } from "@/components/meeting/meetingDecisionApi";
import { WorldAnchorPicker } from "@/components/meeting/WorldAnchorPicker";
import { companyMonth } from "@/lib/companyTime";
import { SLOT_MS, announceMeeting, defaultAnchor, defaultMeetingTitle, elapsed, meetingHref, meetingSpan, startableMeetings, type BookedMeeting } from "@/lib/home/meeting";
import { ICON } from "./StateIcon";
import h from "@/styles/home.module.css";

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
const LAST_ANCHOR = "tianshu.homeMeeting.anchor";
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
  const role = account.role;
  const setPhase = useCallback((next: MeetingPhase) => {
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
  /** 打开这场会的会议页（新首页里的 /me/work/meetings/:id），伙伴台上的胶囊收起。 */
  const open = useCallback(() => {
    if (!meeting) return;
    go(meetingHref(meeting.id));
    setPhase({ kind: "idle" });
  }, [meeting, go, setPhase]);

  return {
    phase, start, resume, end, dismiss, open, account, navigate: go,
    /** 伙伴台上伙伴在听、光跟着响度动。 */
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

/** 伙伴台右下角那一颗：平时是图标按钮，开着会是走秒胶囊。 */
export function MeetingControl({ meeting, missionId }: { meeting: HomeMeeting; missionId?: string | null }) {
  const { phase } = meeting;
  const [open, setOpen] = useState(false);
  const now = useTick(phase.kind === "live" || phase.kind === "organizing");
  useEffect(() => { if (phase.kind === "organizing" || phase.kind === "ready" || phase.kind === "idle") setOpen(false); }, [phase.kind]);

  if (phase.kind === "organizing") {
    return <span className={h.meetSlot}><span className={h.meetPill} data-state="organizing" role="status" data-testid="meeting-pill">整理中 {elapsed(now - phase.since)}</span></span>;
  }
  if (phase.kind === "ready") {
    return <span className={h.meetSlot}><Pressable className={h.meetPill} data-state="ready" onPress={meeting.open} data-testid="meeting-pill">记录待确认</Pressable></span>;
  }

  let trigger;
  let body;
  if (phase.kind === "live") {
    const quiet = !phase.broken && !phase.meeting.audio;
    trigger = (
      <Pressable className={h.meetPill} data-state={phase.broken ? "broken" : quiet ? "quiet" : "live"} aria-label={`会议中 · ${phase.meeting.title}`} data-testid="meeting-pill">
        <i aria-hidden />{phase.broken ? "会议中 · 录音断了" : `${elapsed(now - phase.meeting.startedAt)}${quiet ? " · 没录上音" : ""}`}
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
              : <HeroButton variant="tertiary" onPress={meeting.dismiss}>收起</HeroButton>}
            <HeroButton variant="primary" autoFocus onPress={() => { setOpen(false); void meeting.end(); }}>重试</HeroButton>
          </> : <>
            <HeroButton variant="tertiary" onPress={meeting.dismiss}>收起</HeroButton>
            <HeroButton variant="primary" autoFocus onPress={meeting.open}>打开会议</HeroButton>
          </>}
        </div>
      </>
    );
  } else {
    trigger = (
      <HeroButton variant="ghost" size="sm" isIconOnly className={h.meetButton} title="开会" aria-label="开会" isDisabled={phase.kind === "starting"} data-testid="meeting-button">
        <AudioLines {...ICON} />
      </HeroButton>
    );
    body = <StartForm meeting={meeting} missionId={missionId ?? null} onStarted={() => setOpen(false)} />;
  }

  return (
    <span className={h.meetSlot} data-testid="meeting-slot">
      <Popover isOpen={open} onOpenChange={setOpen}>
        {trigger}
        <Popover.Content placement="bottom end" offset={6} className={`${h.pop} ${h.meetPop}`}>
          <Popover.Dialog aria-label="开会" className={h.meetDialog} data-testid="meeting-pop">{body}</Popover.Dialog>
        </Popover.Content>
      </Popover>
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

/** 弹层里：现在能开的已约会议 + 新的一场。 */
function StartForm({ meeting, missionId, onStarted }: { meeting: HomeMeeting; missionId: string | null; onStarted: () => void }) {
  const { account } = meeting;
  const me = account.personId ?? "";
  const ceo = account.role === "ceo";
  const [title, setTitle] = useState(() => defaultMeetingTitle(new Date()));
  const [booked, setBooked] = useState<BookedMeeting[]>([]);
  const [options, setOptions] = useState<TWorldAnchorOption[] | null>(null);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [anchors, setAnchors] = useState<TWorldAnchor[]>([]);
  const [picking, setPicking] = useState(false);
  const [people, setPeople] = useState<{ personId: string; displayName: string }[]>([]);
  const [hosts, setHosts] = useState<DirectoryPerson[]>([]);
  const [host, setHost] = useState(() => (ceo ? read<string>(LAST_HOST) ?? "" : me));
  const [error, setError] = useState("");
  const busy = meeting.phase.kind === "starting";
  const startButton = useRef<HTMLButtonElement>(null);
  const focused = useRef(false);

  useEffect(() => {
    let live = true;
    void listWorldAnchorOptions(companyMonth(new Date())).then((next) => {
      if (!live) return;
      setOptions(next);
      const first = defaultAnchor(next, { missionId, last: read<TWorldAnchor>(LAST_ANCHOR), me });
      setAnchors(first ? [first] : []);
    }, () => { if (live) setOptionsFailed(true); });
    void listPersonDirectory().then((next) => { if (live) setPeople(next); }, () => undefined);
    if (ceo) void listPeople().then((next) => { if (live) setHosts(next.filter((person) => person.roles.includes("dri"))); }, () => undefined);
    // 已约的会只有成员的「会议安排」给（CEO 没有这个接口）。
    else void browserApi.GET("/api/me/meetings").then(({ data }) => {
      if (live && data) setBooked(startableMeetings(data.meetings, account.displayName, Date.now()));
    }, () => undefined);
    return () => { live = false; };
  }, [ceo, me, missionId, account.displayName]);

  const ready = Boolean(title.trim() && anchors.length && host && !busy);
  // 焦点落在「开始」上（回车就开）：挂点读到、能开的那一刻放过去；人已经在标题框里打字就不抢。
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
  const startNew = () => {
    if (!ready) return;
    const at = Date.now();
    write(LAST_ANCHOR, anchors[0]);
    if (ceo) write(LAST_HOST, host);
    void go({ book: {
      title: title.trim(), scheduledAt: new Date(at).toISOString(), endsAt: new Date(at + SLOT_MS).toISOString(),
      ...(ceo ? { leadDriId: host } : {}),
      anchors: anchors.map(({ kind, id }) => ({ kind: kind as TPickedWorldAnchor["kind"], id })),
    } });
  };

  return (
    <>
      {booked.length ? (
        <ul className={h.meetBooked} aria-label="已约的会">
          {booked.map((entry) => (
            <li key={entry.meetingId}>
              <button type="button" className={h.menuItem} disabled={busy} onClick={() => void go({ meetingId: entry.meetingId, title: entry.title })} data-testid="meeting-booked">
                <span className={h.meetRowTitle}>{entry.title}</span><span className={h.menuFaint}>{meetingSpan(entry.startsAt, entry.endsAt)}</span>
              </button>
              <a className={h.icon} href={meetingHref(entry.meetingId)} aria-label={`打开「${entry.title}」`} data-testid="meeting-booked-open"
                onClick={(event) => { if (plainClick(event)) { event.preventDefault(); onStarted(); meeting.navigate(meetingHref(entry.meetingId)); } }}>
                <ArrowUpRight {...ICON} />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <p className={h.sectionTitle}>新的一场</p>
      <input className={h.projectName} aria-label="标题" value={title} maxLength={200} data-testid="meeting-title"
        onChange={(event) => setTitle(event.currentTarget.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); startNew(); } }} />
      <div className={h.meetField}>
        <span className={h.menuFaint}>关于</span>
        {anchors.length && !picking ? (
          <button type="button" className={h.meetAnchor} onClick={() => setPicking(true)} data-testid="meeting-anchor">{anchors[0].title}</button>
        ) : optionsFailed ? <span className={h.meetError}>没读到</span> : options ? null : <span className={h.menuFaint}>…</span>}
      </div>
      {options && (picking || !anchors.length) ? (
        <WorldAnchorPicker options={options} value={anchors} viewerId={me} nameOf={nameOf} company={ceo}
          onChange={(next) => { setAnchors(next); if (next[0]?.kind !== "po") setPicking(false); }} />
      ) : null}
      {ceo ? (
        <div className={h.meetField}>
          <span className={h.menuFaint}>主持人</span>
          <Select aria-label="主持人" value={host} placeholder="选主持人" options={hosts.map((person) => ({ value: person.personId, label: person.displayName }))} onChange={setHost} />
        </div>
      ) : null}
      {error ? <p className={h.meetError} role="alert">{error}</p> : null}
      <div className={h.dialogActions}>
        <HeroButton ref={startButton} variant="primary" isDisabled={!ready} onPress={startNew} data-testid="meeting-start">开始</HeroButton>
      </div>
    </>
  );
}
