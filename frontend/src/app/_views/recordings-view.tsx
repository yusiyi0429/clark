"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { AsyncBoundary } from "@/components/async-boundary";
import { Panel, PanelEmpty, PanelHead } from "@/components/panel";
import { finishRecording, retryRecording } from "@/components/recording/actions";
import { STATUS_LABEL, canRetry, formatHms, isTerminal } from "@/components/recording/status";
import { RecordingUpload } from "@/components/recording/upload";
import { api, ApiError } from "@/lib/data/client";
import { formatStamp } from "@/lib/format";
import type { RecordingSummary } from "@/lib/recording/types";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 录音与逐字稿的清单 (`/recordings`)。
 *
 * 这一页**不挂在顶栏导航上**。它此刻还是一条自己走的路：一份音频进来、变成一份带
 * 说话人和时间戳的文字，还没有接到议题上（`Recording.issueId` 留着但一律为空）。
 * 在它成为「某件议题的一场会」之前，往导航里加一格等于告诉一号位这是他日常的一站，
 * 而它不是 —— 进来的路是别人给的链接和这一页自己的地址。
 *
 * ## 轮询只在有事发生时开
 *
 * 全站的默认是不自动重取（`use-resource.ts` 开头那段：一次静默重取会把屏幕上
 * 「正在…」那句话变成假话）。这一页是那条规则的例外，因为它上面真的有东西在自己走：
 * 转码、上传、转写都是服务端在跑，浏览器没有别的途径知道它们走完了没有。
 *
 * 但**例外只在有在途的那一行时成立**。全部走到终态之后定时器就该停 —— 一个常驻的
 * 五秒定时器会在这一页被开着不管的时候一直问，而答案永远是同一份。
 */
export function RecordingsView() {
  const resource = useResource<RecordingSummary[]>("recordings", () => api.listRecordings());
  const mutate = resource.mutate;

  const pending = (resource.data ?? []).some((r) => !isTerminal(r.status));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void mutate(), 5000);
    return () => clearInterval(t);
  }, [pending, mutate]);

  return (
    <Panel>
      <AsyncBoundary resource={resource} skeleton={<RecordingsSkeleton />}>
        {(items) => <RecordingsScreen items={items} onChanged={() => void mutate()} />}
      </AsyncBoundary>
    </Panel>
  );
}

function RecordingsScreen({
  items,
  onChanged,
}: {
  items: RecordingSummary[];
  onChanged: () => void;
}) {
  const router = useRouter();

  return (
    <>
      <PanelHead
        eyebrow={`共 ${items.length} 份`}
        title="录音与逐字稿"
        sub="一份音频进来，出去的是一份带说话人和时间戳的文字。"
      />

      {/* 一份都没有时表单直接展开：那一刻这一页唯一能做的事就是这件。 */}
      <RecordingUpload
        defaultOpen={items.length === 0}
        onUploaded={(id) => router.push(`/recordings/${id}`)}
      />

      {items.length === 0 ? (
        <PanelEmpty
          title="还没有录音。"
          note="传一份会议音频进来，它会被转成逐字稿：每句话记着谁说的、第几分几秒说的。"
        />
      ) : (
        <ul className="card mt-6 overflow-hidden">
          {items.map((r, i) => (
            <Row key={r.id} rec={r} index={i} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */

function Row({
  rec,
  index,
  onChanged,
}: {
  rec: RecordingSummary;
  index: number;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setFailed(e instanceof ApiError ? e.message : "这一下没有走完。");
    } finally {
      setBusy(false);
    }
  };

  const retryable = rec.status === "failed" && canRetry(rec.failStage, rec.error);

  return (
    <li
      className="stagger row row-link concentric"
      style={{ "--i": index } as React.CSSProperties}
    >
      {/*
        整行不是一个 `<a>`：右边那颗「重试」/「结束并转写」是一个动作，套在链接里
        就成了「点它会跳页」。所以链接只包住左边那一块，按钮和它并排。
        `.row-link` 认 `:focus-within`，键盘 Tab 到任何一个上，整行照样亮。
      */}
      <div className="flex items-center gap-3 px-3.5 py-3">
        <Link href={`/recordings/${rec.id}`} className="min-w-0 flex-1 rounded-[3px]">
          <span className="block truncate text-sm text-ink" title={rec.title}>
            {rec.title}
          </span>
          <span className="meta mt-0.5 block text-ink-faint">
            {formatStamp(rec.startedAt)} · <span className="tabular-nums">{formatHms(rec.durationMs)}</span>
            {rec.speakerCount ? ` · ${rec.speakerCount} 人` : ""}
          </span>
        </Link>

        <span
          className={cn(
            "meta w-16 flex-none text-right",
            rec.status === "failed" ? "text-counter" : "text-ink-muted",
          )}
        >
          {STATUS_LABEL[rec.status]}
        </span>

        {retryable ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => retryRecording(rec.id))}
            className="meta flex-none rounded-[3px] px-1 text-ink-faint underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink disabled:opacity-40"
          >
            {busy ? "正在重来…" : "重试"}
          </button>
        ) : null}

        {/*
          「录音中」的那些是标签页被关掉留下的孤儿：录的那一侧没了，记录还停在录音中，
          自己不会往下走。给一颗手动收尾的键，而不是等一个永远不会到的结束事件。
        */}
        {rec.status === "recording" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => finishRecording(rec.id))}
            className="meta flex-none rounded-[3px] px-1 text-ink-faint underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink disabled:opacity-40"
          >
            {busy ? "正在收尾…" : "结束并转写"}
          </button>
        ) : null}
      </div>

      {/*
        失败原因摆原话。ffmpeg 那一档尤其：这一行上没有重试按钮，那句「ffmpeg 不在
        PATH 上」就是屏幕上唯一指向下一步的东西。
      */}
      {rec.status === "failed" && rec.error ? (
        <p className="meta px-3.5 pb-3 text-counter">{rec.error}</p>
      ) : null}
      {failed ? (
        <p className="meta px-3.5 pb-3 text-counter" role="alert">
          {failed}
        </p>
      ) : null}
    </li>
  );
}

function RecordingsSkeleton() {
  return (
    <div aria-live="polite">
      <span className="skeleton block h-2.5 w-20" />
      <span className="skeleton mt-3 block h-4 w-40" />
      <span className="skeleton mt-2.5 block h-2.5 w-72" />
      {/* 骨架跟真清单同一套结构，否则数据到手时布局会跳。 */}
      <div className="card mt-8 overflow-hidden">
        {[0, 1, 2].map((i) => (
          <div key={i} className="row concentric px-3.5 py-3">
            <span className="skeleton block h-3 w-[46%]" />
            <span className="skeleton mt-2 block h-2.5 w-40" />
          </div>
        ))}
      </div>
    </div>
  );
}
