"use client";

/**
 * 会议页「挂到」下面那一条进度线：这场会走到哪一步、此刻在发生什么。靠左一行，放不下按步折行。
 *
 * - 在飞书约上的会：已约好 → 等开会 → 进行中 → 等妙记 → 生成会议卡 → 待你确认（整卡确认后是已确认）；
 * - 没在飞书约上的会：等开会 → 进行中 → 待交记录 → 生成会议卡 → 待你确认。
 * - 「等妙记 / 待交记录」那一格：说话人待确认时写待确认说话人；自动取妙记失败、超时（或没在飞书约上的会）写待交记录，后面给上传入口。
 * - 「等开会」那一格：没开成时写没开成。已取消的会不画。
 *
 * 这一步：点会呼吸（进行中用页头同一个红），粗字，后面是走着的用时，能估的跟「· 约 N 分钟」；到点前的等开会、没开成、生成失败不呼吸。
 * `MinutesRecovery` 是待交记录后面那几样：上传会议记录、贴妙记链接、再读一次、连接飞书（后三样只给主持人和建会的人）。
 */
import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { TMeetingCardPayload, TMeetingMinutesFailure, TMeetingMinutesFetchResponse, TMeetingMinutesStatus } from "@warmap/contracts";
import { feishuConnectHref, readFeishuConnection } from "@/lib/feishuLogin";
import { readMeetingMinutesLink, refetchMeetingMinutes } from "./meetingDecisionApi";
import { CARD_EXPECTED_MS, MINUTES_EXPECTED_MS, elapsed, useNow, type FeishuLive } from "./MeetingHeader";
import p from "@/styles/meeting-progress.module.css";

export type ProgressStepKey = "booked" | "waiting" | "live" | "record" | "card" | "confirm";
export type ProgressStep = { key: ProgressStepKey; label: string; state: "done" | "current" | "todo" };
/** 这一步的点：breathe 品牌蓝呼吸、live 进行中的红呼吸、still 不动、fail 红色不动。 */
export type ProgressTone = "breathe" | "live" | "still" | "fail";

export type MeetingProgressModel = {
  steps: ProgressStep[];
  /** 正在哪一步；全部走完（已确认）为 null。 */
  current: ProgressStepKey | null;
  /** 这一步从哪一刻算起（走用时）；没有就不走。 */
  since: string | null;
  /** 这一步大约要多久；估不了为 null。 */
  expectedMs: number | null;
  tone: ProgressTone;
  /** 这一步后面给上传会议记录：自动取妙记失败或超时，或没在飞书约上的会到了待交记录。 */
  upload: boolean;
};

type ProgressPayload = Pick<TMeetingCardPayload, "status" | "scheduledAt" | "startedAt" | "feishuEvent" | "minutesStatus" | "minutesFailure"
  | "minutesWaitingSince" | "minutesManualImport" | "transcriptCandidate" | "outcome">;

/**
 * `ended` 与会议页同一个口径（在飞书约上的会按飞书会议结束，其余按预约时间或「结束会议」）；`now` 用来判断到没到开始时刻；
 * `mine`：看的人自己就是确认会议卡的人（主持人、建会的人），最后一步写待你确认，别人看到的是待确认。
 */
export function meetingProgress(payload: ProgressPayload, { live, ended, now, mine = true }: { live: FeishuLive | null; ended: boolean; now: number; mine?: boolean }): MeetingProgressModel | null {
  if (payload.status === "cancelled") return null;
  const booked = payload.feishuEvent?.status === "booked";
  const candidate = payload.transcriptCandidate ?? null;
  const awaiting = !candidate && (payload.minutesStatus === "waiting" || (payload.minutesStatus === "failed" && payload.minutesFailure === "not_ready"));
  const failed = payload.minutesStatus === "manual" || (payload.minutesStatus === "failed" && payload.minutesFailure !== "not_ready");
  const handIn = !candidate && !awaiting && (failed || Boolean(payload.minutesManualImport) || !booked);
  const keys: ProgressStepKey[] = booked ? ["booked", "waiting", "live", "record", "card", "confirm"] : ["waiting", "live", "record", "card", "confirm"];
  const labels: Record<ProgressStepKey, string> = {
    booked: "已约好",
    waiting: live === "missed" ? "没开成" : "等开会",
    live: "进行中",
    record: candidate ? "待确认说话人" : handIn ? "待交记录" : "等妙记",
    card: "生成会议卡",
    confirm: payload.status === "reviewed" ? "已确认" : mine ? "待你确认" : "待确认",
  };

  let current: ProgressStepKey | null = null;
  let since: string | null = null;
  let expectedMs: number | null = null;
  let tone: ProgressTone = "breathe";
  const due = Date.parse(payload.scheduledAt) <= now;
  const outcome = payload.outcome;
  if (payload.status === "held") {
    // 没参会的成员看不到会议卡生成到哪（只有已确认的条目）：有会后结果就当已生成。
    if (outcome && outcome.status !== "pending" && outcome.status !== "running" && outcome.status !== "failed") {
      current = "confirm";
      since = outcome.extractedAt ?? null;
    } else {
      current = "card";
      if (outcome?.status === "failed") tone = "fail";
      else {
        since = (outcome?.status === "running" ? outcome.startedAt : null) ?? outcome?.pendingSince ?? null;
        expectedMs = CARD_EXPECTED_MS;
      }
    }
  } else if (payload.status === "scheduled" && (ended || candidate)) {
    current = "record";
    if (candidate) since = candidate.createdAt;
    else if (awaiting) {
      since = payload.minutesWaitingSince ?? null;
      expectedMs = MINUTES_EXPECTED_MS;
    }
  } else if (payload.status === "scheduled" && (live === "live" || (live === null && due))) {
    current = "live";
    since = payload.startedAt ?? payload.scheduledAt;
    tone = "live";
  } else if (payload.status === "scheduled") {
    current = "waiting";
    if (live === "missed") tone = "fail";
    else if (due) since = payload.scheduledAt;
    else tone = "still";
  }

  const at = current ? keys.indexOf(current) : keys.length;
  return {
    steps: keys.map((key, index) => ({ key, label: labels[key], state: index < at ? "done" : index === at ? "current" : "todo" })),
    current,
    since,
    expectedMs,
    tone,
    upload: current === "record" && handIn,
  };
}

/** 走着的用时：一小时以内 mm:ss，再长写几小时几分钟；没超过预计时跟「· 约 N 分钟」；时钟偏差不出负数。 */
export function progressClock(since: string, now: number, expectedMs: number | null): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const minutes = Math.floor((seconds % 3600) / 60);
  const spent = seconds < 3600 ? elapsed(seconds) : `${Math.floor(seconds / 3600)} 小时${minutes ? ` ${minutes} 分钟` : ""}`;
  return expectedMs !== null && seconds * 1000 <= expectedMs ? `${spent} · 约 ${Math.round(expectedMs / 60_000)} 分钟` : spent;
}

function ProgressClock({ since, expectedMs }: { since: string; expectedMs: number | null }) {
  const now = useNow(1000);
  // role="timer"：读屏不每秒播报。
  return <time className={p.clock} role="timer" dateTime={since} suppressHydrationWarning>{progressClock(since, now, expectedMs)}</time>;
}

/** 进度线本身；`actions` 跟在这一步后面（进入飞书会议、重新安排会议、上传会议记录）。 */
export function MeetingProgress({ model, actions }: { model: MeetingProgressModel; actions?: ReactNode }) {
  return (
    <ol className={p.progress} aria-label="进度">
      {model.steps.map((step, index) => {
        const current = step.state === "current";
        return (
          <li key={step.key} className={p.step} data-step={step.key} data-state={step.state} data-tone={current ? model.tone : undefined}
            aria-current={current ? "step" : undefined}>
            {index ? <ChevronRight size={12} strokeWidth={2} aria-hidden className={p.arrow} /> : null}
            <i className={p.dot} aria-hidden />
            <span>{step.label}</span>
            {current && model.since ? <ProgressClock since={model.since} expectedMs={model.expectedMs} /> : null}
            {current && actions ? <span className={p.actions}>{actions}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** 再读、贴链接没成功时的短标签（不显示服务端原话）。 */
const FETCH_ERROR: Record<string, string> = { INVALID_MINUTES_URL: "不是妙记链接", MINUTE_TAKEN: "已对到别的会" };
/** 其实已经读完了（页面上的会议卡旧了）：直接重取会议卡。 */
const ALREADY_READ = new Set(["MINUTES_READY", "TRANSCRIPT_ALREADY_IMPORTED"]);

/**
 * 待交记录后面的几样，都是安静的文字链接：上传会议记录（能上传的人）；主持人和建会的人还有贴妙记链接（点开才有输入框）、
 * 读取失败时的再读一次；自己没连好飞书、因此没拿到（没授权退回手动、读的时候没权限）时是连接飞书，连上后这场会接着自动拿妙记。
 */
export function MinutesRecovery({ meetingId, status, failure, canFetch, onFetched, onUpload, uploading = false, uploadError = null }: {
  meetingId: string; status: TMeetingMinutesStatus; failure: TMeetingMinutesFailure | null;
  /** 主持人或创建人：能再读一次、贴妙记链接。 */
  canFetch: boolean;
  /** 再读、贴链接成功之后（会议页重取会议卡）。 */
  onFetched?: () => void;
  /** 能上传会议记录的人：打开会议页的选文件。 */
  onUpload?: () => void;
  uploading?: boolean;
  uploadError?: string | null;
}) {
  const [url, setUrl] = useState("");
  const [pasting, setPasting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const retry = canFetch && status === "failed" && failure !== "not_ready";
  const wantsConnect = canFetch && (status === "manual" || failure === "no_permission");
  const [feishu, setFeishu] = useState<{ enabled: boolean; connected: boolean } | null>(null);
  useEffect(() => {
    if (!wantsConnect) return;
    let alive = true;
    void readFeishuConnection().then((value) => { if (alive) setFeishu(value); });
    return () => { alive = false; };
  }, [wantsConnect]);
  const connectHref = wantsConnect && feishu?.enabled && !feishu.connected ? feishuConnectHref(`${window.location.pathname}${window.location.search}`) : null;
  const run = async (work: () => Promise<TMeetingMinutesFetchResponse | { code: string }>) => {
    setBusy(true); setError("");
    try {
      const result = await work();
      if ("code" in result && !ALREADY_READ.has(result.code)) setError(FETCH_ERROR[result.code] ?? "没有读到");
      else { setUrl(""); setPasting(false); onFetched?.(); }
    } catch { setError("没有读到"); }
    finally { setBusy(false); }
  };
  return (
    <>
      {onUpload ? <button type="button" className={p.quiet} disabled={uploading} onClick={onUpload}>{uploading ? "上传中…" : "上传会议记录"}</button> : null}
      {connectHref ? <a className={p.quiet} href={connectHref}>连接飞书</a> : null}
      {retry && !connectHref ? <button type="button" className={p.quiet} disabled={busy} onClick={() => void run(() => refetchMeetingMinutes(meetingId))}>再读一次</button> : null}
      {canFetch && !pasting ? <button type="button" className={p.quiet} onClick={() => setPasting(true)}>贴妙记链接</button> : null}
      {canFetch && pasting ? (
        <span className={p.link}>
          <input type="url" aria-label="妙记链接" placeholder="贴妙记链接" value={url} disabled={busy} onChange={(event) => setUrl(event.target.value)} />
          <button type="button" className={p.quiet} disabled={busy || !url.trim()} onClick={() => void run(() => readMeetingMinutesLink(meetingId, url.trim()))}>读取</button>
        </span>
      ) : null}
      {error || uploadError ? <span className={p.error} role="alert">{error || uploadError}</span> : null}
    </>
  );
}
