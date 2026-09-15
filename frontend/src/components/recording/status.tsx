/**
 * 录音这条路上「此刻走到哪一步」怎么写在屏幕上。
 *
 * 这几样单独拎出来，是因为列表页和详情页要**说同一句话**：同一份录音在两页上
 * 出现两个说法（一页写「处理中」一页写「转写中」），一号位会以为自己看的是两份
 * 东西。文案表只有这一份。
 *
 * 状态没有合并成「处理中」，理由在 `lib/recording/types.ts` 的 `RecordingStatus`
 * 上写着：三档卡住的原因不同，该给的下一步也不同。这里照抄那个分档，不做二次归并。
 */

import type { RecordingFailStage, RecordingStatus } from "@/lib/recording/types";

/** 屏幕上那两三个字。七档一一对应，不留兜底分支 —— 少一档 `tsc` 就报。 */
export const STATUS_LABEL: Record<RecordingStatus, string> = {
  recording: "录音中",
  uploaded: "排队中",
  transcoding: "转码中",
  uploading: "上传中",
  transcribing: "转写中",
  done: "已完成",
  failed: "转写失败",
};

/**
 * 走到头了没有。**轮询要不要继续，只看这一个函数。**
 *
 * 写成「不是 done 也不是 failed」而不是列举五档在途状态：以后后端加一档新的中间态，
 * 这里什么都不用改，而列举那种写法会把新状态当成终态，屏幕从此停在那一档不动。
 */
export const isTerminal = (status: RecordingStatus): boolean =>
  status === "done" || status === "failed";

/**
 * 这一次失败给不给重试按钮。
 *
 * 只有一种情况不给：**转码那一段倒下、而且原因是 ffmpeg**。那是本机没这个程序或者
 * 它啃不动这个格式，按十次是同一个结果 —— 一颗按下去必然再失败一次的按钮，比没有
 * 按钮更糟：他会以为是自己手气不好。这时候屏幕上剩下的就是 `error` 那句原话，
 * 那句话才指向真正的下一步（去装 ffmpeg）。
 *
 * 别的段（上传、转写、解析）一律给：网、凭据、厂商排队，都是重试真能翻盘的。
 */
export const canRetry = (failStage?: RecordingFailStage, error?: string): boolean =>
  failStage !== "transcode" || !/ffmpeg/i.test(error ?? "");

/**
 * `01:23:45`。**时、分、秒都补零，一位不省。**
 *
 * 和 `lib/format.ts` 的 `formatDuration`（「1 分 05 秒」）分工不同：那个是给倒计时
 * 读的一句话，这个是**一列数**。列表上十几行时长竖着排，只有等宽的三段才对得齐；
 * 「48 秒」和「1 小时 3 分」并排，眼睛没法比长短。逐字稿的段头时间戳也用它，于是
 * 时长和时间戳是同一种写法 —— 屏幕上不出现第二套时间格式。
 *
 * 没有时长（转码之前探不出来）返回破折号，不返回 `00:00:00` —— 后者是一个具体的
 * 断言（这份录音是空的），而事实是还不知道。
 */
export function formatHms(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "—";
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

/**
 * 非终态时正文区那一句话。
 *
 * 每一档说的是**这一步在等什么**，不是「请稍候」。一号位在这一页上唯一的问题是
 * 「还要多久、要不要现在管它」，而「处理中」对这两问都没有答案。
 */
export const WAITING_NOTE: Record<RecordingStatus, string> = {
  recording: "还在录。这一份要先结束才会开始转写。",
  uploaded: "已经排上队，等着转码。",
  transcoding: "正在把音频转成转写服务认的格式。",
  uploading: "正在把音频传给转写服务。",
  transcribing: "正在转写。这一步按音频时长走，一小时的会通常要几分钟。",
  done: "",
  failed: "",
};
