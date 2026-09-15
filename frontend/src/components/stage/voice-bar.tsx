"use client";

import { Mic, MicOff, PanelsTopLeft } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { setMode } from "@/lib/mode";
import type { ListenerState } from "@/lib/stage/listener";
import { VOICE_LABEL, type VoiceState } from "@/lib/stage/events";
import { cn } from "@/lib/utils";

import { useStage } from "./stage-provider";

/**
 * 底下那一条。三段。
 *
 * 左边一盏灯：聆听中 / 取证中 / 呈报中。**不做拟人头像** —— 一个会呼吸的小圆点是状态，
 * 一张脸是角色；这个产品的立场是他才是那个角色，参谋只负责有据可查。
 *
 * 中间一行字幕：最新那一句，很淡，说完 8 秒自己退掉。它是给听不清的人兜的，不是给他看
 * 的 —— 所以它绝不能长成一列聊天气泡。整屏任何地方都没有对话列表：一旦有，客户的眼睛
 * 就会去读那一列，而他正在说的话就白说了。
 *
 * 右边一个很小的输入框：回车发出去。这是**操作员救生通道**，会上语音识别一挂、模型一卡，
 * 他或者秘书打一行字就能把流程接回来。它必须永远能用 —— 所以它不依赖任何在飞的状态，
 * 也不会因为「正在呈报」被禁用。
 */

const TONE: Record<VoiceState, string> = {
  listening: "bg-factual",
  retrieving: "bg-judgment",
  presenting: "bg-confirmed",
};

/** 字幕退场：说完之后 8 秒。他还在说的时候（`partial`）不数这 8 秒。 */
const CAPTION_LINGER_MS = 8000;

export function VoiceBar() {
  const { state, say, stop, busy, linked, mic, micNote, toggleMic } = useStage();
  const caption = state.caption;
  const heard = state.heard;

  /*
   * 淡出的定时器挂在 `seq` 上。
   *
   * `seq` 只在句子真的换了的时候才变（见 reducer），所以流里一个字一个字长出来的过程中
   * 定时器不会被反复重置成新的 —— 但只要还在长，`partial` 就是 true，那时候根本不起表。
   *
   * 记的是「哪一句已经退掉了」，不是一个 `faded` 开关。换句话的时候不需要先把开关拨回
   * 去：`seq` 一变，`faded` 自己就是 false 了。开关那一版要在 effect 里同步 setState 把
   * 它拨回来，那是一次白渲染，而且新句子的第一帧仍然带着上一句的 `faded=true` ——
   * 屏幕上是新字幕闪一下才亮。
   */
  const [fadedSeq, setFadedSeq] = useState<number | null>(null);
  // 还在长的句子不起表：`null` 的意思是「现在没有在数的这一句」。
  const settled = caption && !caption.partial ? caption.seq : null;
  const faded = settled !== null && fadedSeq === settled;

  useEffect(() => {
    if (settled === null) return;
    const t = setTimeout(() => setFadedSeq(settled), CAPTION_LINGER_MS);
    return () => clearTimeout(t);
  }, [settled]);

  return (
    <footer className="flex items-center gap-6 border-t border-hairline bg-surface/40 px-8 py-4">
      {/* ① 那盏灯 */}
      <div className="flex shrink-0 items-center gap-2.5">
        <span
          className={cn(
            "size-2.5 rounded-full",
            TONE[state.voice],
            busy && "animate-breathe",
          )}
          aria-hidden
        />
        <span className="meta-stage text-ink-muted">{VOICE_LABEL[state.voice]}</span>
      </div>

      {/*
        * ② 中间那一行。
        *
        * 两样东西轮着占它：**他说的话**（识别出来的）和**参谋说的话**（字幕）。他说的优先 ——
        * 从识别出第一个字，一直留到参谋开口回答（那一下会 `HEARD_CLEAR`）。
        *
        * 为什么不并排放两行：投影上两行字会盖住卡片下沿，而卡片才是主角。而且这一格本来就是
        * 给听不清的人兜的，不是一个对话记录 —— 一旦长成两行、能往上翻，客户的眼睛就会去读
        * 它，而他正在说的话就白说了。
        */}
      {heard ? (
        <p
          aria-live="polite"
          className={cn(
            "min-w-0 flex-1 truncate text-stage-meta transition-opacity duration-slow ease-swift",
            // 还在长的时候更淡一点：那是「听着呢」，落定了才是「听清了」。
            heard.final ? "text-ink-muted opacity-100" : "text-ink-faint opacity-80",
          )}
        >
          {heard.text}
        </p>
      ) : (
        <p
          aria-live="polite"
          className={cn(
            "min-w-0 flex-1 truncate text-stage-meta text-ink-faint transition-opacity duration-slow ease-swift",
            faded || !caption ? "opacity-0" : "opacity-100",
          )}
        >
          {caption?.text}
        </p>
      )}

      {/* ③ 救生通道 */}
      <div className="flex shrink-0 items-center gap-3">
        {/*
         * 麦克风那一头出的事写在这儿，不写进字幕。
         *
         * 一句话，counter 色，不会自己退掉 —— 「没给权限」这种事他得一直看得见，直到解决。
         */}
        {micNote && <span className="meta-stage max-w-64 truncate text-counter">{micNote}</span>}
        <MicToggle state={mic} onToggle={toggleMic} />
        {busy && (
          <button
            type="button"
            onClick={stop}
            className="meta-stage rounded-md px-3 py-1.5 text-ink-faint transition-colors duration-fast ease-swift hover:bg-neutral-wash hover:text-ink"
          >
            停
          </button>
        )}
        <Rescue onSend={say} takeover={mic === "failed"} />
        {/*
         * 控制台接上了才亮这一点。秘书那边显示的是「有几块屏在听」，这边显示的是「控制台
         * 那条线活着」—— 两头各自看得见对方，会上才敢用热键。
         */}
        <span
          className={cn("size-1.5 rounded-full", linked ? "bg-confirmed/60" : "bg-hairline")}
          title={linked ? "控制台已连接" : "控制台未连接"}
        />
        <ModeToggle />
      </div>
    </footer>
  );
}

/**
 * 麦克风那个开关。
 *
 * 五个状态各有一个说法，因为这五个状态在会上要做的事完全不同：没开（点一下开）、正在开
 * （等权限）、在听（他说话会被识别）、参谋在念（这半分钟不听，见半双工）、这条路不通
 * （用旁边那个输入框）。
 *
 * 它不做「一直听着」的默认值：开会前就热着的麦克风不该存在，而且浏览器也不给 —— 权限必须
 * 挂在一次真实点击上。
 */
const MIC_LABEL: Record<ListenerState, string> = {
  off: "开麦",
  starting: "正在打开麦克风",
  listening: "在听 · 点一下关麦",
  muted: "参谋在念，这会儿不听",
  failed: "麦克风这条路不通",
};

function MicToggle({ state, onToggle }: { state: ListenerState; onToggle: () => void }) {
  const on = state === "listening" || state === "muted";
  return (
    <button
      type="button"
      onClick={onToggle}
      title={MIC_LABEL[state]}
      aria-label={MIC_LABEL[state]}
      aria-pressed={on}
      className={cn(
        "flex items-center gap-1.5 rounded-md p-1.5 transition-colors duration-fast ease-swift",
        state === "failed"
          ? "text-counter hover:bg-counter-wash"
          : on
            ? "text-ink-muted hover:bg-neutral-wash hover:text-ink"
            : "text-ink-faint/40 hover:bg-neutral-wash hover:text-ink-muted",
      )}
    >
      {on ? <Mic className="size-4" /> : <MicOff className="size-4" />}
      {/*
       * 在听的时候点一盏灯。
       *
       * 「麦克风到底开着没有」是这一场里他唯一必须随时确认的一件事 —— 一个图标的深浅在投影
       * 上看不出来，一个会呼吸的绿点看得出来。参谋在念的时候它不呼吸（那半分钟确实没在听）。
       */}
      {on && (
        <span
          className={cn(
            "size-1.5 rounded-full",
            state === "listening" ? "animate-breathe bg-confirmed" : "bg-ink-faint/50",
          )}
          aria-hidden
        />
      )}
    </button>
  );
}

function Rescue({
  onSend,
  takeover,
}: {
  onSend: (text: string) => void;
  takeover: boolean;
}) {
  const [text, setText] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const said = text.trim();
    if (!said) return;
    setText("");
    onSend(said);
  };

  return (
    <form onSubmit={submit}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={takeover ? "语音没接上" : "替他说一句"}
        /*
         * 存在感压到最低：没有边框，只有底下一条发丝线，聚焦时才实一点。投影上这一格
         * 是唯一的「界面」痕迹，它越不像一个输入框越好 —— 但它必须一直在那儿。
         *
         * 只有一种情况它要跳出来：语音识别挂了。那时候它是唯一还能把会开下去的路，低调
         * 就成了错的 —— 边框实起来，让他和秘书都一眼看见该往哪儿打字。
         */
        className={cn(
          "text-stage-meta w-52 bg-transparent px-1 py-1 text-ink placeholder:text-ink-faint/60 focus:outline-none",
          takeover
            ? "rounded-md border border-counter/50 placeholder:text-counter/70 focus:border-counter"
            : "border-b border-hairline focus:border-hairline-strong",
        )}
      />
    </form>
  );
}

/**
 * 回桌面。
 *
 * 只有一个图标，没有文字，在整条语音条最右角 —— 规格里说「极低调、只有图标」。它不该
 * 被看见：会上有人问「这是什么软件」，答案应该是屏幕上那件事，而不是右下角一个按钮。
 *
 * 切回去是立刻的：`.desk` 只是被 `display: none` 藏着，对话栏和右栏那几个标签都还在原地。
 */
function ModeToggle() {
  return (
    <button
      type="button"
      onClick={() => setMode("manual")}
      title="回工作台"
      aria-label="回工作台"
      className="rounded-md p-1.5 text-ink-faint/40 transition-colors duration-fast ease-swift hover:bg-neutral-wash hover:text-ink-muted"
    >
      <PanelsTopLeft className="size-4" />
    </button>
  );
}
