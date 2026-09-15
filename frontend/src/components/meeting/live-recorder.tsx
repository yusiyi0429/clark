"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";

import { api, ApiError } from "@/lib/data/client";
import { cn } from "@/lib/utils";

/**
 * 会中收音 —— **这一页上他唯一要按的那颗键**，以及它按下之后的每一档。
 *
 * ## 一颗键，六档，全部照实说
 *
 * 从按下到屏幕上出现待确认的纪要，中间要走五段：收音 → 上传 → 转码 → 转写 → 提炼。
 * 每一段都可能停在半路，而它们停下来的原因和该做的下一步完全不同：麦克风没给权限是
 * 他在浏览器上点一下就能解的；转写排队只能等；ffmpeg 不在这台机器上重试一万次也一样。
 * 合成一个「处理中」的转圈，这几种情况在屏幕上长得一模一样。
 *
 * 所以这里每一档各说各的话，失败一律**照抄服务端原话**（那几句都带着是哪一段倒的，
 * 见 `Recording.error`）。
 *
 * ## 为什么整段录音存在浏览器里，不是边录边传
 *
 * 库里那条 live 链路（`startRecording` + 分片）现在还没有收分片的路由。而**这一版不需要
 * 它**：一小时的 opus 大约三十兆，存在标签页里没有问题，散会那一下一次传完，走的是
 * 上传录音那条已经跑通的流水线（`/api/recordings/upload`）。
 *
 * 代价写清楚：**这个标签页在会中不能关**。关了这一场就没了 —— 所以录着的时候页面会拦
 * 一道关闭确认（`beforeunload`），那是眼下唯一诚实的做法：假装它还在后台录着，比拦一下
 * 糟得多。要真的做到关了也不丢，得先有那条分片路由。
 *
 * ## 转写完还要再走一步
 *
 * 逐字稿不是终点 —— 他要的是「这场会谈出了什么、谁去做什么」。所以转写落地之后这里
 * 自己接着把全文喂给会后提炼（`ingestMeetingNotes`），提炼完首页右栏就会长出待确认的
 * 那几张卡。中间不停下来问他一句「要不要提炼」：他刚开完一场会，那个问题只有一个答案。
 */
type Phase =
  | { at: "idle" }
  /** 正在问麦克风权限。浏览器那个气泡挡在屏幕上，这一档只是为了让按钮别再被按第二下。 */
  | { at: "asking" }
  | { at: "recording"; since: number }
  | { at: "uploading" }
  /** 已经收下了，后台在转码/上传/转写。`note` 是这一刻走到哪一段。 */
  | { at: "transcribing"; recordingId: string; note: string }
  | { at: "summarizing" }
  | { at: "done" }
  | { at: "failed"; why: string; recordingId?: string };

/** 录音表上那几档状态在屏幕上叫什么。**一档一句**，理由见 `RecordingStatus`。 */
const STATUS_NOTE: Record<string, string> = {
  uploaded: "已经收下这一场，正在排队处理",
  transcoding: "正在把这一场转成识别用的格式",
  uploading: "正在把音频送去识别",
  transcribing: "正在转成文字（一小时的会大约要几分钟）",
};

/** 几秒问一次录音走到哪儿了。 */
const POLL_MS = 5000;

/**
 * 录了多久。**这里不用 `formatDuration`** —— 那个函数写的是「1 分 09 秒」这种人话，
 * 给「上一轮跑了多久」用；而一颗正在走的秒表要的是等宽的钟面（`07:12`），否则每跳一秒
 * 后面的字都在左右晃。
 */
function clockLabel(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function LiveRecorder({
  slotId,
  title,
  participants,
  onTranscriptReady,
  doneLabel,
  onDone,
}: {
  slotId: string;
  /** 这一场叫什么。进录音表当标题，屏幕上和录音那一页上是同一个名字。 */
  title: string;
  /** 只用于热词和会后核对候选，不代表系统已经认出每个声源是谁。 */
  participants?: string[];
  /** 新会议链路在说话人核对后再提炼；旧链路不传，行为保持不变。 */
  onTranscriptReady?: (value:{recordingId:string;transcript:string})=>Promise<void>;
  doneLabel?:string;
  /** 提炼落地了 —— 外面那一层去重取议题与会议表。 */
  onDone: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ at: "idle" });
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  /**
   * 秒表读数（毫秒）。**由计时器写进 state，不在渲染里读时钟** —— 渲染期间读
   * `Date.now()` 会让同一次渲染在服务端和浏览器上得出两个数（水合会报不一致），
   * 而这个数每秒本来就要更新一次，state 是它天然的住处。
   */
  const [elapsed, setElapsed] = useState(0);

  const recording = phase.at === "recording";
  const since = phase.at === "recording" ? phase.since : null;

  useEffect(() => {
    if (since === null) return;
    const read = () => setElapsed(Date.now() - since);
    read(); // 第一格不等一秒 —— 按下去到 00:01 之间是一整秒的 00:00，读起来像没启动
    const t = setInterval(read, 1000);
    return () => clearInterval(t);
  }, [since]);

  /*
   * 录着的时候拦一道关闭。整段音频只活在这个标签页里（理由写在文件头），关掉就是真没了。
   * 浏览器不许自定义那句话，所以它显示的是系统那句 —— 拦住这一下比什么都不做强。
   */
  useEffect(() => {
    if (!recording) return;
    const stop = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", stop);
    return () => window.removeEventListener("beforeunload", stop);
  }, [recording]);

  /* 组件被卸掉时把麦克风关掉 —— 不然那颗录音指示灯会一直亮在标签页上。 */
  useEffect(
    () => () => {
      recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  const start = async () => {
    setPhase({ at: "asking" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      /*
       * 拒绝授权和「这台机器上没有麦克风」是两件事，浏览器用两个 name 分开报，
       * 而它们的下一步完全不同（点一下地址栏那把锁 / 插一个麦克风）。
       */
      const name = err instanceof DOMException ? err.name : "";
      setPhase({
        at: "failed",
        why:
          name === "NotAllowedError"
            ? "浏览器没给麦克风权限。点一下地址栏左边那把锁，把「麦克风」改成允许，再按一次。"
            : name === "NotFoundError"
              ? "这台机器上没找到麦克风。"
              : "打不开麦克风：" + (err instanceof Error ? err.message : String(err)),
      });
      return;
    }

    chunksRef.current = [];
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "";
    const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    mr.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    mr.onstop = () => void handOff(mr.mimeType || "audio/webm");
    recorderRef.current = mr;
    /* 五秒一片。片本身还是攒在内存里，切片只是为了别让最后一片大到停不下来。 */
    mr.start(5000);
    setElapsed(0);
    setPhase({ at: "recording", since: Date.now() });
  };

  const stop = () => {
    const mr = recorderRef.current;
    if (!mr) return;
    setPhase({ at: "uploading" });
    mr.stop();
    mr.stream.getTracks().forEach((t) => t.stop());
  };

  /** 散会那一下：把攒着的整段传上去，然后一路盯到提炼落地。 */
  const handOff = async (mime: string) => {
    const blob = new Blob(chunksRef.current, { type: mime });
    chunksRef.current = [];
    if (blob.size === 0) {
      setPhase({ at: "failed", why: "这一场没录到任何声音。" });
      return;
    }

    let recordingId: string;
    try {
      const form = new FormData();
      form.set("file", new File([blob], `${slotId}.webm`, { type: mime }));
      form.set("title", title);
      if(participants?.length)form.set("participants",participants.join("，"));
      const res = await fetch("/api/recordings/upload", { method: "POST", body: form });
      const payload = (await res.json()) as { id?: string; error?: string };
      if (!res.ok || !payload.id) throw new Error(payload.error ?? "这一场没传上去。");
      recordingId = payload.id;
    } catch (err) {
      setPhase({ at: "failed", why: err instanceof Error ? err.message : "这一场没传上去。" });
      return;
    }

    setPhase({ at: "transcribing", recordingId, note: STATUS_NOTE.uploaded });

    /*
     * 盯着那份录音走到 done。**这里不设总超时** —— 一场两小时的会转写要多久没有一个
     * 能被核对的分母，而中途自己判它失败，等于在服务端还在跑的时候告诉他这一场没了。
     * 每一次问不到就照旧接着问；真倒了服务端会把状态翻成 failed，原话在那儿。
     */
    for (;;) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      let detail: Awaited<ReturnType<typeof api.getRecording>>;
      try {
        detail = await api.getRecording(recordingId);
      } catch {
        continue; // 问不到不等于没在跑
      }
      if (!detail) {
        setPhase({ at: "failed", why: "这份录音不在了。", recordingId });
        return;
      }
      const st = detail.recording.status;
      if (st === "failed") {
        setPhase({
          at: "failed",
          why: detail.recording.error ?? "转写没跑成，服务端没说为什么。",
          recordingId,
        });
        return;
      }
      if (st === "done") break;
      setPhase({ at: "transcribing", recordingId, note: STATUS_NOTE[st] ?? "正在处理这一场" });
    }

    /* 逐字稿拿纯文本那一条路由 —— 格式规则只有一处（见那条路由的注释）。 */
    setPhase({ at: "summarizing" });
    try {
      const res = await fetch(`/api/recordings/${recordingId}/transcript.txt`);
      if (!res.ok) throw new Error(await res.text());
      const text = await res.text();
      if(onTranscriptReady)await onTranscriptReady({recordingId,transcript:text});
      else await api.ingestMeetingNotes(slotId, text, title);
      setPhase({ at: "done" });
      onDone();
    } catch (err) {
      setPhase({
        at: "failed",
        why:
          (err instanceof ApiError || err instanceof Error
            ? err.message
            : "提炼没跑成。") +
          "（这一场的逐字稿已经存下来了，去录音那一页能读到原文。）",
        recordingId,
      });
    }
  };

  /* ---------------------------------------------------------------- */

  if (phase.at === "recording") {
    return (
      <Block>
        <div className="flex items-center justify-center gap-3">
          <span aria-hidden className="size-2.5 animate-pulse rounded-full bg-counter" />
          <span className="text-lg font-medium text-ink tabular-nums">
            {clockLabel(elapsed)}
          </span>
          <span className="meta text-ink-muted">正在收音</span>
        </div>
        <button
          type="button"
          onClick={stop}
          className="mt-3 inline-flex h-11 w-full items-center justify-center rounded-xl bg-solid text-md font-medium text-solid-fg transition-opacity duration-fast hover:opacity-90"
        >
          结束会议
        </button>
        <p className="meta mt-2 text-center text-ink-faint">
          这一场只存在这个标签页里，会中别关它。
        </p>
      </Block>
    );
  }

  if (phase.at === "asking") {
    /* 权限那个气泡是浏览器画的、就挡在屏幕中间，这一档只是一句陪着它的话 ——
       它不是「机器在办事」，所以不套那块流动的底。 */
    return (
      <Block>
        <p className="sweeping-text text-center text-md text-ink" aria-live="polite">
          正在问浏览器要麦克风
        </p>
      </Block>
    );
  }

  if (phase.at === "uploading" || phase.at === "summarizing") {
    return (
      <Block working>
        <p className="text-center text-md [color:var(--meet-fg)]" aria-live="polite">
          {phase.at === "uploading" ? "正在把这一场传上去" : "正在按议题提炼这场会"}
        </p>
      </Block>
    );
  }

  if (phase.at === "transcribing") {
    return (
      <Block working>
        <p className="text-center text-md [color:var(--meet-fg)]" aria-live="polite">
          {phase.note}
        </p>
        <p className="meta mt-2 text-center [color:var(--meet-fg-dim)]">
          转写在后台跑，这一页可以关。
        </p>
      </Block>
    );
  }

  if (phase.at === "done") {
    return (
      <Block>
        <p className="text-center text-md text-ink">
          {doneLabel??"这场会已经提炼完，回首页右栏确认。"}
        </p>
      </Block>
    );
  }

  return (
    <Block>
      {phase.at === "failed" ? (
        <p role="alert" className="mb-3 text-sm leading-relaxed text-counter">
          {phase.why}
        </p>
      ) : null}
      {/*
       * 这一页上唯一的那颗键。**整块面，不是一行字。**
       *
       * 它是这一页存在的理由 —— 左边那几份判断和右边那场对话都是为了让他按下这一下
       * 之前心里有数。所以它占满这一栏的宽、四行多高、用整页最实的那块底。
       */}
      <button
        type="button"
        onClick={() => void start()}
        className="flex h-[4.5rem] w-full items-center justify-center rounded-xl bg-solid text-lg font-medium tracking-[0.02em] text-solid-fg transition-[transform,opacity] duration-fast ease-swift hover:opacity-90 active:scale-[0.995]"
      >
        {phase.at === "failed" ? "再试一次" : "开始会议"}
      </button>
    </Block>
  );
}

/**
 * 这一块钉在左栏底边上，和上面的正文之间一条线。
 *
 * ## `working`：机器正在办这一场
 *
 * 底换成一块深蓝的面，上面一层流动的马赛克（`.mosaic-flow`）——**和首页那张会议卡在办
 * 材料时是同一层东西**。两处说的是同一件事（这一场此刻在机器手里走一条要几分钟的链路），
 * 用两种画法说，他就得学两遍。
 *
 * 这一档不用页面自己那张纸色的底：一块和周围一样的白面上，那层马赛克的白光扫不出任何
 * 东西来（它的亮段就是白）。深蓝底上白光扫过去才读得出「一格一格地在办」——
 * 也就是他说的那个深蓝加浅蓝。
 *
 * 颜色写死 `--meet-a` 那一档，**不取这场会自己的色档**：这一块此刻答的不是「哪一场会」，
 * 是「机器在办事」。跟着会色走的话，同一个状态在紫的那场和蓝的那场是两个样子，
 * 而它们发生的是同一件事。
 *
 * 那行字上**不再挂 `.sweeping-text`**：底已经在流了，再让字自己扫光，是两个东西各自
 * 在动，读起来像两件事在跑（同 `SlotBlock` 那处的理由）。
 */
function Block({
  working,
  children,
}: {
  working?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={working ? ({ "--meet": "var(--meet-a)" } as CSSProperties) : undefined}
      className={cn(
        "border-t border-hairline px-5 pt-4 pb-5",
        /* 马赛克是绝对定位的一层，所以这一层要 `relative` 才装得住它；`overflow-hidden`
           是为了它别探到左栏外面去。内容各自 `relative` 压在它上面。 */
        working && "meet-face dither relative overflow-hidden border-transparent",
      )}
    >
      {working ? <div aria-hidden className="mosaic-flow" /> : null}
      <div className="relative">{children}</div>
    </div>
  );
}
