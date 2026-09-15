"use client";

import { useEffect, useRef, useState } from "react";

import { AsyncBoundary } from "@/components/async-boundary";
import { Panel, PanelEmpty, PanelHead } from "@/components/panel";
import { retryRecording } from "@/components/recording/actions";
import {
  STATUS_LABEL,
  WAITING_NOTE,
  canRetry,
  formatHms,
  isTerminal,
} from "@/components/recording/status";
import { Transcript } from "@/components/recording/transcript";
import { api, ApiError } from "@/lib/data/client";
import { formatStamp } from "@/lib/format";
import type { RecordingDetail } from "@/lib/recording/types";
import { useResource } from "@/lib/use-resource";

/**
 * 一份录音 (`/recordings/[id]`)。
 *
 * 上面是音频，下面是逐字稿，两边连着：点一句话音频跳到那一秒，音频走到哪一句那一句
 * 亮着。这一页存在的理由就是这条连线 —— 一份逐字稿如果不能回到声音上去核对，它就只是
 * 一堆可能记错的字。
 *
 * 转写没完成时**不显示逐字稿区**，屏幕上只有当前那一档在等什么。摆一个空的正文框在
 * 那儿，读起来是「转完了，但一个字都没有」—— 那和「还在转」是两件完全不同的事。
 */
export function RecordingView({ id }: { id: string }) {
  const resource = useResource<RecordingDetail | null>(`recording:${id}`, () =>
    api.getRecording(id),
  );
  const mutate = resource.mutate;
  const data = resource.data;

  // 轮询的开关和列表页同一条：有在途状态才开，走到终态就停。
  const pending = data ? !isTerminal(data.recording.status) : false;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void mutate(), 5000);
    return () => clearInterval(t);
  }, [pending, mutate]);

  return (
    <Panel>
      <AsyncBoundary resource={resource} skeleton={<RecordingSkeleton />}>
        {(detail) =>
          detail === null ? (
            <>
              <PanelHead eyebrow="录音与逐字稿" title="没有这一份录音。" />
              <PanelEmpty
                title={`库里找不到 ${id}。`}
                note="它可能被删了，也可能这个编号抄错了一位。"
              />
            </>
          ) : (
            <RecordingScreen detail={detail} mutate={mutate} />
          )
        }
      </AsyncBoundary>
    </Panel>
  );
}

function RecordingScreen({
  detail,
  mutate,
}: {
  detail: RecordingDetail;
  mutate: (
    data?: RecordingDetail | null,
    opts?: { revalidate?: boolean },
  ) => Promise<unknown>;
}) {
  const rec = detail.recording;
  const audio = useRef<HTMLAudioElement>(null);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryFailed, setRetryFailed] = useState<string | null>(null);

  /**
   * 点了一句话：跳到那一秒，接着放。
   *
   * 放在这一层而不是逐字稿那一层，是因为 `<audio>` 长在这里 —— 控制播放的只有一个
   * 地方，逐字稿只负责报「他点的是第几毫秒」。
   */
  const seek = (startMs: number) => {
    const el = audio.current;
    if (!el) return;
    el.currentTime = startMs / 1000;
    // 播放被浏览器拒了（比如这一页还没有过用户手势）不该冒一个未捕获的 Promise 出来。
    void el.play().catch(() => {});
  };

  const retry = async () => {
    if (retryBusy) return;
    setRetryBusy(true);
    setRetryFailed(null);
    try {
      await retryRecording(rec.id);
      await mutate();
    } catch (e) {
      setRetryFailed(e instanceof ApiError ? e.message : "这一下没有走完。");
    } finally {
      setRetryBusy(false);
    }
  };

  /**
   * 改说话人的名字。**先改屏幕，再问服务端，失败就退回去。**
   *
   * 这一处值得乐观更新，是因为改名往往是连着改好几个人（认完一遍谁是谁）。每改一个
   * 等一次往返，那一段就是改一下停一下；而这件事失败的代价很小 —— 退回原名再说一句
   * 话，没有任何东西被写坏。
   */
  const renameSpeaker = async (speakerId: string, displayName: string) => {
    const before = detail;
    const speakers = before.speakers.some((s) => s.speakerId === speakerId)
      ? before.speakers.map((s) => (s.speakerId === speakerId ? { ...s, displayName } : s))
      : // 厂商给了这个号但 `speakers` 里没有它（只在句子里出现过）时补一条，
        // 否则改完名之后这一格还是「说话人 3」，看起来像没保存。
        [...before.speakers, { speakerId, displayName }];

    void mutate({ ...before, speakers }, { revalidate: false });
    try {
      await api.renameRecordingSpeaker(before.recording.id, speakerId, displayName);
    } catch (e) {
      void mutate(before, { revalidate: false });
      throw e;
    }
  };

  const showRetry = rec.status === "failed" && canRetry(rec.failStage, rec.error);

  return (
    <>
      <PanelHead
        eyebrow={`录音与逐字稿 · ${rec.id}`}
        title={
          <RecordingTitle
            id={rec.id}
            title={rec.title}
            onRenamed={(next) =>
              void mutate({ ...detail, recording: { ...rec, title: next } }, { revalidate: false })
            }
          />
        }
        sub={
          <>
            {formatStamp(rec.startedAt)} ·{" "}
            <span className="tabular-nums">{formatHms(rec.durationMs)}</span> ·{" "}
            {STATUS_LABEL[rec.status]}
            {rec.participants.length > 0 ? ` · ${rec.participants.join("、")}` : null}
          </>
        }
      />

      {rec.status === "failed" ? (
        <div className="rounded-lg border border-counter/25 bg-counter-wash px-4 py-3.5">
          {/* 原话，不改写。「ffmpeg 不在 PATH 上」和「TOS 拒绝了这次上传：403」
              指向两条完全不同的排查路径，而「转写失败」两条都不指。 */}
          <p className="text-sm leading-relaxed text-ink">
            转写失败：{rec.error ?? "没有留下原因。"}
          </p>
          {showRetry ? (
            <button
              type="button"
              disabled={retryBusy}
              onClick={() => void retry()}
              className="meta mt-2 rounded-[3px] px-1.5 py-0.5 text-counter underline underline-offset-4 transition-colors hover:bg-counter/10 disabled:opacity-40"
            >
              {retryBusy ? "正在重来…" : "重试"}
            </button>
          ) : null}
          {retryFailed ? (
            <p className="meta mt-2 text-counter" role="alert">
              {retryFailed}
            </p>
          ) : null}
        </div>
      ) : null}

      {/*
        音频一直在，即使还在转写 —— 传进来的那一份此刻就能听，不必等文字。
        `preload="metadata"` 而不是 `auto`：一份一小时的会几十兆，开页就全量拉下来
        是替他做了一个他没要的决定。
      */}
      <audio
        ref={audio}
        controls
        preload="metadata"
        src={`/api/recordings/${rec.id}/audio`}
        className="mt-6 w-full"
      />

      <div className="mt-7">
        {rec.status === "done" ? (
          <Transcript
            recordingId={rec.id}
            utterances={detail.utterances}
            speakers={detail.speakers}
            audio={audio}
            onSeek={seek}
            onRenameSpeaker={renameSpeaker}
          />
        ) : rec.status === "failed" ? null : (
          <p className="text-sm text-ink-muted" aria-live="polite">
            {WAITING_NOTE[rec.status]}
          </p>
        )}
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * 标题，点一下就能改。
 *
 * 这里和议题标题（`components/issue-title.tsx`）故意不一样：那一页上标题是最大的
 * 一行字，眼睛落上去鼠标跟过去是常事，所以改题走旁边一颗单独的键。这一页的标题是
 * 一个**默认拼出来的名字**（「会议 2026-08-31 14:20」），它天生就是等着被改的 ——
 * 一份录音传进来，第一件事往往就是给它起个名。所以这里点标题直接进编辑态。
 *
 * 失焦即提交（不是「算了」）：进编辑态是他自己点的，中途点到别处多半是改完了。
 * 反悔走 Esc —— 那一下先清掉草稿，随后的 blur 就没有东西可提交。
 */
function RecordingTitle({
  id,
  title,
  onRenamed,
}: {
  id: string;
  title: string;
  onRenamed: (next: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const save = async () => {
    if (draft === null || busy) return;
    const next = draft.trim();
    // 空标题、或者压根没改，都当作没这回事：不为一次空操作跑一趟服务端。
    if (!next || next === title) {
      setDraft(null);
      return;
    }
    setBusy(true);
    setFailed(null);
    try {
      await api.renameRecording(id, next);
      onRenamed(next);
      setDraft(null);
    } catch (e) {
      setFailed(e instanceof ApiError ? e.message : "这个标题没有改成。");
    } finally {
      setBusy(false);
    }
  };

  if (draft !== null) {
    return (
      <span className="block">
        <input
          autoFocus
          value={draft}
          disabled={busy}
          aria-label="录音标题"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") setDraft(null);
          }}
          className="w-full rounded-md border border-hairline bg-paper px-2 py-1 text-lg font-medium text-ink focus:border-ink focus:outline-none disabled:opacity-50"
        />
        {failed ? (
          <span className="meta mt-1 block text-counter" role="alert">
            {failed}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <button
      type="button"
      title="改名"
      onClick={() => setDraft(title)}
      className="block w-full truncate rounded-[3px] text-left transition-colors duration-fast hover:text-ink-muted"
    >
      {title}
    </button>
  );
}

function RecordingSkeleton() {
  return (
    <div aria-live="polite">
      <span className="skeleton block h-2.5 w-40" />
      <span className="skeleton mt-3 block h-5 w-[52%]" />
      <span className="skeleton mt-2.5 block h-2.5 w-56" />
      <span className="skeleton mt-6 block h-10 w-full" />
      <div className="mt-8 space-y-4">
        {[0, 1, 2].map((i) => (
          <div key={i}>
            <span className="skeleton block h-3 w-24" />
            <span className="skeleton mt-2 block h-3.5 w-[92%]" />
            <span className="skeleton mt-1.5 block h-3.5 w-[68%]" />
          </div>
        ))}
      </div>
    </div>
  );
}
