"use client";

import { useState } from "react";

import { ResearchStepLine } from "@/components/research-step-line";
import { ApiError } from "@/lib/data/client";
import { cn } from "@/lib/utils";

/**
 * 这条请求还在路上那一段说的话。**它管的是「收下」这一段，不是后面那两段。**
 *
 * 括号里那半句不能省：贴进来的文字这一步是一瞬间的事，而一份一小时的录音要在这一步里
 * 转三分钟。不说的话，那三分钟看起来就是「传一个文件传了三分钟」。
 *
 * 提出来是因为**两处要说同一句**：这一格自己（没人替它画等待时的退路），以及议题栏那块
 * 会议块（`SlotBlock`，它把这一段画成流动的底，那一行字由它写）。抄两份的下场是其中一处
 * 哪天改了措辞，而同一件事在屏幕上成了两件。
 */
export const INTAKE_SENDING = "正在收下这份材料（录音要先在这一步转成文字）";

/**
 * 会开完了，交材料。**录音，或者一份已经转好的文字。**
 *
 * ## 为什么这一步要人来交
 *
 * 会中自动记录那条路还没有。所以散会之后系统手上什么都没有 —— 它连这场会开没开完都不
 * 知道（粒度只到上午/下午，时钟答不出散会）。这一格因此挂在「已经标记结束」那一场会上：
 * 标记结束是他按的，交材料也是他交的，两下之间没有任何一个系统能自己走完的环节。
 *
 * ## 两种输入不是主次关系
 *
 * 贴文字不是录音失败时的退路。他手上可能本来就有一份转写（别的工具出的、助理记的），
 * 那时再让机器听一遍只是白等几分钟。两条路走到同一个地方：后面按议题提炼那一步完全一样。
 *
 * ## 等的那一段说清在等什么，不给进度条
 *
 * 一份录音要转多久取决于它有多长，而这里没有一个能被核对的分母。所以只有一句「此刻在办
 * 什么」加一只秒表 —— 编一个会走到 100% 却什么都不会发生的进度条，比不给更糟。
 *
 * ## 这条请求现在只管**收下**
 *
 * 判材料有没有用、按议题提炼，都挪进了后台任务（见 `api/meeting/audio` 那段注释与
 * `ingestMeetingNotes`）。留在这条请求里的只有「传上去」，以及**录音那一路的转写**。
 * 所以这里那句等待的话不能再写「正在转写并按议题提炼」—— 提炼早就不在这条请求里了，
 * 那句话会在提炼还没开始的时候先说它在跑。
 *
 * ## 等的那一段**由谁画**，从外面给
 *
 * 这一格现在长在议题栏那块深色的会议块上（`IssueColumn` 的 `SlotBlock`），而那一块自己
 * 有一整块面可以拿来说「它在办」（底变成流动的马赛克）。同一件事画两遍 —— 一块在流的底
 * 加一行在扫光的字 —— 是两个东西同时在动，读起来像两件事各自在跑。
 *
 * 所以这里多一条 `onBusyChange`：**请求一发出就说一声**，外面那一层决定这一段谁来画。
 * 不给这条口子的做法试过一版：让外面轮询 `slotIntakeState` 自己发现 —— 那中间有半秒到
 * 几分钟的空窗（他松手了，录音还在这条请求里转写，服务端那边什么任务都还没起），屏幕上
 * 那一块此刻什么都没变，看起来像那一下没按上。
 *
 * ## 键和面板拆成两件，开合由外面持有
 *
 * 会议块改版之后这颗键站到了卡片的**右上角**，而它展开的那一格（选文件 / 贴文字）必须
 * 铺在卡片**底部整宽**上 —— 挤在右上角那几十像素里放不下一个文件选择器，而绝对定位的
 * 浮层会被那张卡的 `overflow-hidden` 裁掉。两处离得这么远，`open` 就不能再藏在这个
 * 组件自己肚子里：`MeetingIntakeTrigger` 是那颗键，这里只剩那一格，开合由 `SlotBlock` 持有。
 */
export function MeetingIntakeTrigger({
  open,
  onToggle,
  label = "上传纪要",
  title,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  /** 折叠时那颗键上的字。默认是最短的那句。 */
  label?: string;
  /** 键上那几个字说不全时的全称（悬停与读屏都读它）。 */
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={title}
      title={title}
      onClick={onToggle}
      /*
       * 皮肤走 `.meet-btn-quiet`，不再自己写一个 `[color:…]` 加 `hover:opacity-80`。
       * 两个理由：它此刻和另一颗键并排站在同一角上，两颗键的悬停反应必须是同一种；
       * 而颜色由那一族从 `--meet-fg` 上取，会褪成 `.meet-past` 时它自己跟着褪。
       */
      className={cn(
        "meta meet-btn-quiet rounded-[3px] underline decoration-current/40 underline-offset-4 transition-colors duration-fast",
        className,
      )}
    >
      {open ? "取消" : label}
    </button>
  );
}

export function MeetingIntake({
  slotId,
  open,
  onClose,
  onDone,
  onBusyChange,
  className,
}: {
  slotId: string;
  /** 那一格展开着没有。**由外面持有** —— 键在右上角，格子在卡片底下。 */
  open: boolean;
  /** 交成了，把那一格收回去。 */
  onClose: () => void;
  onDone: () => Promise<unknown>;
  /**
   * 这一份的请求出去了（`true`）/ 落地了（`false`）。外面那一层据此把它那块面切成
   * 「正在办」。
   *
   * **落地不分成不成**：失败那一档也要收回「正在办」，那句为什么没成由这里自己写在
   * 下面（服务端每一句错都带着是哪一段没成，见 `api/meeting/audio`）。
   */
  onBusyChange?: (busy: boolean) => void;
  className?: string;
}) {
  const [text, setText] = useState("");
  /** 开跑那一刻。有值 = 正在办，秒表从这里走。 */
  const [busyAt, setBusyAt] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const send = async (file: File | null) => {
    const form = new FormData();
    form.set("slotId", slotId);
    if (file) form.set("file", file);
    else form.set("transcript", text.trim());
    setBusyAt(new Date().toISOString());
    setFailure(null);
    onBusyChange?.(true);
    try {
      const res = await fetch("/api/meeting/audio", { method: "POST", body: form });
      const payload = (await res.json()) as { error?: string };
      if (!res.ok) throw new ApiError(payload.error ?? "这一份没处理成。");
      onClose();
      setText("");
      await onDone();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "这一份没处理成。");
    } finally {
      setBusyAt(null);
      onBusyChange?.(false);
    }
  };

  if (busyAt) {
    return (
      <ResearchStepLine
        className={cn("meta [color:var(--meet-fg-dim)]", className)}
        startedAt={busyAt}
        fallback={INTAKE_SENDING}
      />
    );
  }

  if (!open && !failure) return null;

  return (
    <div className={className}>
      {open ? (
        <div className="animate-panel space-y-2">
          <input
            type="file"
            accept=".wav,.txt,.md,.srt,.vtt,audio/wav,text/plain"
            aria-label="这场会的录音或会议记录"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void send(f);
            }}
            className="block w-full text-sm [color:var(--meet-fg-dim)] file:mr-3 file:h-7 file:cursor-pointer file:rounded-md file:border file:border-current/30 file:bg-transparent file:px-2.5 file:text-sm file:[color:var(--meet-fg)]"
          />
          <textarea
            aria-label="或者把会议记录的文字贴进来"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="或粘贴会议记录全文"
            className="scroll-slim field-sizing-content max-h-40 w-full resize-none overflow-y-auto rounded-md border border-current/25 bg-transparent px-2.5 py-2 text-sm [color:var(--meet-fg)] outline-none transition-colors duration-fast placeholder:[color:var(--meet-fg-dim)] focus:border-current/50"
          />
          {text.trim().length > 0 && (
            <button
              type="button"
              onClick={() => void send(null)}
              className="inline-flex h-7 items-center rounded-md bg-white/15 px-2.5 text-sm font-medium [color:var(--meet-fg)] transition-colors duration-fast hover:bg-white/25"
            >
              提炼
            </button>
          )}
        </div>
      ) : null}

      {failure ? (
        <p role="alert" className="meta mt-2 [color:var(--meet-fg)]">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
