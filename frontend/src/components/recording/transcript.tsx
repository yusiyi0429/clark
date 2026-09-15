"use client";

import { useEffect, useMemo, useState, type RefObject } from "react";

import { formatHms } from "@/components/recording/status";
import type { RecordingSpeaker, RecordingUtterance } from "@/lib/recording/types";
import { cn } from "@/lib/utils";

/**
 * 逐字稿。
 *
 * ## 合并只发生在这里
 *
 * 库里一句是一句（`lib/recording/types.ts` 的 `RecordingUtterance` 上写着为什么：
 * 合并会把「他停顿了三秒」这件事抹掉，而那是反着做不回来的）。屏幕上要读的东西是
 * 段落 —— 连着五句都是同一个人说的，摆成五行带五个名字，读起来是五个人在轮流说话。
 * 所以合并在这一层做，一次性的、只影响显示。
 *
 * ## 说话人的号是这里数出来的，不是厂商给的
 *
 * 厂商那个编号可能从 0 起、可能是 `speaker_2`、可能中间空号。屏幕上写「说话人 0」
 * 是把内部编号漏给了人看；写「说话人 2」而这份会一共只有两个人，读起来像丢了一个人。
 * 所以名字里那个 N 是**在这份逐字稿里第一次开口的次序**，从 1 起 —— 它对应的是
 * 「第一个说话的那位」，这是人能核对的一件事。
 *
 * ## 高亮为什么是二分
 *
 * `timeupdate` 一秒响四次，一小时的会两千句。每次线性扫一遍是每秒八千次比较，
 * 而且它落在主线程上、和滚动同一条通道 —— 播放时整页会发涩。二分是 11 次比较。
 * 这不是提前优化：两千句是这条路的常规量，不是极端情况。
 */

type Indexed = { u: RecordingUtterance; i: number };
type Segment = { key: string; speakerId: string; startMs: number; items: Indexed[] };

/**
 * 每个 speakerId 屏幕上叫什么。
 *
 * 人改过名就用那个名；没改过按第一次开口的次序拼「说话人 N」。`speakers` 里有、
 * 但逐字稿里一句话都没有的（厂商认出来又没分到句子），排在真正开过口的后面 ——
 * 前面那些号必须和「第几个说话的」对得上，不能被一个没出过声的人挤掉一位。
 */
export function speakerNames(
  utterances: RecordingUtterance[],
  speakers: RecordingSpeaker[],
): Map<string, string> {
  const order = new Map<string, number>();
  for (const u of utterances) {
    if (!order.has(u.speakerId)) order.set(u.speakerId, order.size + 1);
  }
  for (const s of speakers) {
    if (!order.has(s.speakerId)) order.set(s.speakerId, order.size + 1);
  }

  const given = new Map<string, string>();
  for (const s of speakers) {
    const name = s.displayName?.trim();
    if (name) given.set(s.speakerId, name);
  }

  const out = new Map<string, string>();
  for (const [id, n] of order) out.set(id, given.get(id) ?? `说话人 ${n}`);
  return out;
}

/**
 * 复制到剪贴板的那份文本：**一句一行，按原始分句**，不按屏幕上的段落。
 *
 * 屏幕上合并是为了读，粘出去的那份是为了被引用和被搜 —— 一行一句时间戳才落在
 * 每一句上，「这句话是几分几秒说的」才查得到。这两个格式故意不一样。
 */
export function transcriptText(
  utterances: RecordingUtterance[],
  names: Map<string, string>,
): string {
  return utterances
    .map((u) => `[${formatHms(u.startMs)}] ${names.get(u.speakerId) ?? u.speakerId}：${u.text}`)
    .join("\n");
}

/** 最后一句「已经开口」的话。要求数组按 `startMs` 升序 —— 调用方保证。 */
function lastStartedAt(items: RecordingUtterance[], ms: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let hit = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].startMs <= ms) {
      hit = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return hit;
}

export function Transcript({
  recordingId,
  utterances,
  speakers,
  audio,
  onSeek,
  onRenameSpeaker,
}: {
  recordingId: string;
  utterances: RecordingUtterance[];
  speakers: RecordingSpeaker[];
  /** 上面那个 `<audio>`。这里**只读**它 —— 高亮要问「现在放到第几秒」。 */
  audio: RefObject<HTMLAudioElement | null>;
  /**
   * 跳到第几毫秒并开始放。
   *
   * 拿一个回调而不是直接在这里写 `audio.current.currentTime`：那个 ref 是**别人的**，
   * 从这一层伸手改它，「谁在控制播放」就有了两个答案。播放归拥有 `<audio>` 的那一层，
   * 这一层只说「他点了这一句」。
   */
  onSeek: (startMs: number) => void;
  /** 改名。父层负责乐观更新和回滚，这里只负责把失败那句话摆上屏。 */
  onRenameSpeaker: (speakerId: string, displayName: string) => Promise<void>;
}) {
  /*
   * 按时间排一遍。**二分的前提是有序，而「厂商返回的次序」不是一个能拿来当前提的东西**
   * —— 分段识别的结果偶尔会把一句迟到的话排在后面。同一个数组既拿来显示也拿来查，
   * 于是屏幕上的顺序和高亮的顺序永远是同一个，不会出现「高亮跳到上面那句」。
   */
  const ordered = useMemo(
    () => [...utterances].sort((a, b) => a.startMs - b.startMs || a.idx - b.idx),
    [utterances],
  );

  const names = useMemo(() => speakerNames(ordered, speakers), [ordered, speakers]);

  const segments = useMemo(() => {
    const out: Segment[] = [];
    ordered.forEach((u, i) => {
      const last = out[out.length - 1];
      if (last && last.speakerId === u.speakerId) last.items.push({ u, i });
      else
        out.push({
          key: `${u.speakerId}:${u.idx}`,
          speakerId: u.speakerId,
          startMs: u.startMs,
          items: [{ u, i }],
        });
    });
    return out;
  }, [ordered]);

  const [active, setActive] = useState(-1);
  const [editing, setEditing] = useState<{ speakerId: string; draft: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    const sync = () => {
      const hit = lastStartedAt(ordered, el.currentTime * 1000);
      // 只在**换了一句**时 setState。不判这一下的话，播放中每秒四次重渲染整份逐字稿。
      setActive((prev) => (prev === hit ? prev : hit));
    };
    el.addEventListener("timeupdate", sync);
    el.addEventListener("seeked", sync);
    return () => {
      el.removeEventListener("timeupdate", sync);
      el.removeEventListener("seeked", sync);
    };
  }, [audio, ordered]);

  const saveName = async () => {
    if (!editing || busy) return;
    const next = editing.draft.trim();
    // 改成空的当作没改：空名字之后屏幕上那一格是一片空白，比「说话人 2」更难认。
    if (!next) {
      setEditing(null);
      return;
    }
    setBusy(true);
    setFailed(null);
    try {
      await onRenameSpeaker(editing.speakerId, next);
      setEditing(null);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "这个名字没有改成。");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(transcriptText(ordered, names));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 剪贴板被浏览器挡住（非安全上下文、没给权限）是一个真实结果，不是我们这一侧的错。
      setFailed("这台浏览器没让复制。用旁边那个下载。");
    }
  };

  if (ordered.length === 0) {
    return (
      <p className="text-sm text-ink-muted">
        这一场的正文没了 —— 记录还在，逐字稿那个文件不在。
      </p>
    );
  }

  return (
    <div>
      <div className="mb-2.5 flex items-baseline gap-2.5">
        <h2 className="flex-1 text-sm font-medium text-ink">逐字稿</h2>
        <span className="meta text-ink-faint">
          {ordered.length} 句 · {names.size} 人
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className="meta rounded-[3px] text-ink-faint underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink-muted"
        >
          {copied ? "已复制" : "复制文本"}
        </button>
        <a
          href={`/api/recordings/${recordingId}/transcript.txt`}
          className="meta rounded-[3px] text-ink-faint underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink-muted"
        >
          下载 .txt
        </a>
      </div>

      {failed ? (
        <p className="meta mb-2.5 text-counter" role="alert">
          {failed}
        </p>
      ) : null}

      <div className="border-t border-hairline">
        {segments.map((seg) => (
          <div key={seg.key} className="border-b border-hairline py-2.5">
            <div className="flex items-baseline gap-2">
              {editing?.speakerId === seg.speakerId ? (
                <input
                  autoFocus
                  value={editing.draft}
                  disabled={busy}
                  aria-label="说话人的名字"
                  onChange={(e) => setEditing({ speakerId: seg.speakerId, draft: e.target.value })}
                  onBlur={() => void saveName()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveName();
                    // Esc 先清掉编辑态，随后那一下 blur 就没有 `editing` 可提交了。
                    if (e.key === "Escape") setEditing(null);
                  }}
                  className="w-32 rounded-md border border-hairline bg-paper px-1.5 py-0.5 text-sm font-medium text-ink focus:border-ink focus:outline-none disabled:opacity-50"
                />
              ) : (
                <button
                  type="button"
                  title="改名"
                  onClick={() =>
                    setEditing({ speakerId: seg.speakerId, draft: names.get(seg.speakerId) ?? "" })
                  }
                  className="rounded-[3px] text-sm font-medium text-ink transition-colors duration-fast hover:text-ink-muted"
                >
                  {names.get(seg.speakerId)}
                </button>
              )}
              <span className="meta tabular-nums text-ink-faint">{formatHms(seg.startMs)}</span>
            </div>

            {/*
              一段里的句子仍然是一句一个可点的东西，只是排成连续的一段。
              用 `inline` 的 `<button>`：它得跟着行走排版（原生 button 是 inline-block，
              一句长话会整块换行、断在句子边界上，读起来是一列碎块），同时又得是键盘
              能到的 —— `<span onClick>` 这两样都做不到。
            */}
            <p className="report mt-1 text-md leading-relaxed text-ink">
              {seg.items.map(({ u, i }) => (
                <button
                  key={u.idx}
                  type="button"
                  onClick={() => onSeek(u.startMs)}
                  title={formatHms(u.startMs)}
                  className={cn(
                    "inline cursor-pointer rounded-[3px] text-left transition-colors duration-fast hover:bg-wash-hover",
                    i === active && "bg-neutral-wash",
                  )}
                >
                  {u.text}
                </button>
              ))}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
