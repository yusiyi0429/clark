"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { drain } from "@/lib/agent/drain";
import type { Turn } from "@/lib/agent/transcript";
import { api } from "@/lib/data/client";
import { AGENDA, agendaDocIds, agendaOutline, corpusText } from "@/lib/demo/agenda";
import type { BusMessage } from "@/lib/stage/bus";
import type { StageAction, StageEvent } from "@/lib/stage/events";
import { Listener, type ListenerState } from "@/lib/stage/listener";
import { current, initialStage, stageReducer, type StageFrame, type StageState } from "@/lib/stage/reducer";
import { Speaker } from "@/lib/stage/speaker";
import { SegmentFlusher } from "@/lib/tts/sentences";

/**
 * 舞台的那一个口子。
 *
 * 三个来源在这里汇成一条：**模型调工具**（主线）、**秘书按热键**（兜底）、**他自己翻页**
 * （本地）。三者都只能通过 `dispatch` 改屏幕，所以「现在屏幕上是什么」永远只有一个说法。
 * 如果它们各自 setState，会上就会出现两张卡争同一帧的那一下 —— 那种错当场没法解释。
 *
 * 这一层还管一件事：**开屏就已经在呈报**。议程卡是静态数据，挂载那一瞬间就推上屏，
 * 不等模型。模型那两三秒的首字延迟落在「他已经看到今天有三件事」之后，而不是落在一块
 * 空屏上 —— 验收第一条要的就是这个。
 */

interface StageValue {
  state: StageState;
  frame: StageFrame | null;
  dispatch: (action: StageAction) => void;
  /** 把一句话塞进 Agent 那一轮。语音条的输入框和控制台的「接管输入」都走这里。 */
  say: (text: string) => void;
  /** 停止播报。掐在飞的模型流 + 清空播放队列。M3 的抢话也并到这一条命令上。 */
  stop: () => void;
  /** 在飞的那一轮。语音条据此决定要不要显示「停」。 */
  busy: boolean;
  /** 控制台那条线接上了没有。 */
  linked: boolean;
  /** 麦克风现在什么状态。语音条那个按钮和「用输入框吧」那句话都看它。 */
  mic: ListenerState;
  /** 麦克风那一头要说的话。没有就是一切正常。 */
  micNote: string | null;
  /** 开麦 / 关麦。必须由一次真实点击触发 —— 浏览器不给非手势的 `getUserMedia`。 */
  toggleMic: () => void;
}

const StageContext = createContext<StageValue | null>(null);

export function StageProvider({ children }: { children: ReactNode }) {
  // 议程直接进初始状态，不走 effect：effect 要多渲染一帧，而那一帧就是开屏第一帧。
  const [state, dispatch] = useReducer(stageReducer, undefined, () => ({
    ...initialStage,
    agenda: AGENDA,
  }));
  const [busy, setBusy] = useState(false);
  const [linked, setLinked] = useState(false);
  const [mic, setMic] = useState<ListenerState>("off");
  /** 麦克风那一头要说的话（没权限、厂商没配 key…）。它不写进字幕，见下面 `ear`。 */
  const [micNote, setMicNote] = useState<string | null>(null);

  const inflight = useRef<AbortController | null>(null);
  /*
   * 这一场说过的话。只在内存里，不落库。
   *
   * 形状是手动模式那边同一个 `Turn` —— 没有新建数据形态。不落库是这一版故意的取舍：
   * `api.openTurn`/`recordReply` 每次要走 400～1000ms 的模拟延迟，那段延迟会压在会上
   * 「他说完话到屏幕开始动」这条最要命的路径上。会后要留档是另一件事，等 demo 之后做。
   */
  const turns = useRef<Turn[]>([]);
  /** 语料取一次就够。几份文档正文，取完不再动。 */
  const corpus = useRef<string | null>(null);
  /** 他最后问的那句话。控制台「一键变探索卡」要用它。 */
  const asked = useRef("");
  /**
   * 状态的一份镜子。
   *
   * 控制台推上来的命令（下一件、探索卡）是在 effect 里处理的，那个 effect 只挂一次 ——
   * 它不能闭包住第一帧的 `state`。镜子在渲染提交后更新，读到的永远是屏幕上正在显示的
   * 那一份。
   */
  const snapshot = useRef(state);
  useEffect(() => {
    snapshot.current = state;
  }, [state]);

  /* ------------------------------------------------------------------ */
  /* 播报层                                                              */
  /* ------------------------------------------------------------------ */

  /** 模型那一轮还在飞。放在 ref 里是因为播放器的回调不能闭包住某一帧的 `busy`。 */
  const busyRef = useRef(false);
  /**
   * 现在有声音在放。
   *
   * 它决定字幕归谁管：**嘴在说话的时候字幕跟嘴，没声音的时候字幕跟字。** 模型的字比声音跑得
   * 快（文字已经写到第三句，音频还在念第一句），两边同时往字幕上写就会看到字幕自己往前跳。
   * 而没配 key、或者厂商挂了的时候一声都不会响 —— 那时候字幕必须还能用，所以不能简单地把
   * 字幕整个交给播放器。
   */
  const audible = useRef(false);

  const speaker = useRef<Speaker | null>(null);
  const listener = useRef<Listener | null>(null);

  /*
   * 两头互相要用，所以中间垫一层 ref。
   *
   * 识别出一句话要调 `say`，抢话要调 `stop`，而 `say`/`stop` 里又要通知麦克风那一头（参谋
   * 开口了、闭嘴了）。直接连就是一个环。ref 在这里不是偷懒：这两条命令永远只有「最新的
   * 那一份」有意义，而闭包会把某一帧的版本永久留在播放器的回调里。
   */
  const sayRef = useRef<(text: string) => void>(() => {});
  const stopRef = useRef<() => void>(() => {});

  /** 懒建：`AudioContext` 不能在渲染里建，浏览器会当成没有手势的自动播放尝试。 */
  const voice = useCallback((): Speaker => {
    if (!speaker.current) {
      speaker.current = new Speaker({
        onCaption: (text) => dispatch({ type: "CAPTION", text }),
        onSpeaking: (on) => {
          audible.current = on;
          /*
           * 半双工那个闸门就在这一行。
           *
           * 参谋一开口，麦克风这一头就不再往上发音频 —— 不挡的话，音箱里那段话会被麦克风收
           * 回来、识别成「他说的」，再塞进下一轮：参谋自己跟自己聊起来。这是会上最难收场的
           * 一种失控，而且它一旦开始就会自己往下滚。
           */
          listener.current?.agentSpeaking(on);
          if (on) {
            // 他刚说的那句话留在屏幕上，一直留到参谋开口回答 —— 这一下就是「参谋开口了」。
            dispatch({ type: "HEARD_CLEAR" });
            dispatch({ type: "SET_STATE", state: "presenting" });
          } else if (!busyRef.current) {
            dispatch({ type: "SET_STATE", state: "listening" });
          }
        },
        // 出不了声也要说出来。会上「没声音也没提示」是最糟的一种状态。
        onError: (message) => dispatch({ type: "CAPTION", text: message }),
      });
    }
    return speaker.current;
  }, []);

  /**
   * 麦克风那一头。也是懒建的，理由更硬：`getUserMedia` 必须挂在一次真实点击上。
   *
   * 出错的话写在 `micNote` 里，不写进字幕。字幕那一行是参谋的嘴，而识别是这条链子上最不
   * 可靠的一环 —— 不能让它有权力擦掉参谋正在念的那句话。
   */
  const ear = useCallback((): Listener => {
    if (!listener.current) {
      listener.current = new Listener({
        onHeard: (text, final) => dispatch({ type: "HEARD", text, final }),
        onCommit: (text) => sayRef.current(text),
        onBargeIn: () => stopRef.current(),
        onState: (state) => setMic(state),
        onError: (message) => setMicNote(message),
      });
    }
    return listener.current;
  }, []);

  useEffect(
    () => () => {
      speaker.current?.stop();
      listener.current?.stop();
    },
    [],
  );

  const toggleMic = useCallback(() => {
    setMicNote(null);
    void ear().toggle();
  }, [ear]);

  const stop = useCallback(() => {
    inflight.current?.abort();
    inflight.current = null;
    setBusy(false);
    busyRef.current = false;
    // 一条命令，两头都掐：模型那条流和播放队列。M3 的抢话按下去也是这一条。
    speaker.current?.stop();
    audible.current = false;
    dispatch({ type: "SET_STATE", state: "listening" });
  }, []);

  const say = useCallback(async (text: string) => {
    const said = text.trim();
    if (!said) return;

    inflight.current?.abort();
    const ctl = new AbortController();
    inflight.current = ctl;
    setBusy(true);
    busyRef.current = true;

    /*
     * 他说话了 —— 上一轮的声音立刻停。
     *
     * 这是 M3 抢话在 M1/M2 阶段就已经成立的那一半：只要有一句新的话进来（不管是他打的、
     * 秘书替他打的、还是将来语音识别转出来的），正在念的那段就该当场闭嘴。会上人打断参谋
     * 是常态，参谋不肯停才是失礼。
     */
    speaker.current?.stop();
    audible.current = false;

    turns.current = [...turns.current, { role: "user", content: said }];
    asked.current = said;
    dispatch({ type: "SET_STATE", state: "retrieving" });
    dispatch({ type: "CAPTION_CLEAR" });

    /*
     * 一边收字一边送去合成。
     *
     * 不等这一轮说完 —— 等一轮说完再合成，他会先看到满屏的字、几秒之后才听到声音。第一段
     * 攒到十几个字遇到逗号就送走（见 `SegmentFlusher`），所以「第一个字到第一声」压在一次
     * TTS 往返里。
     */
    const sofar = { text: "" };
    const flusher = new SegmentFlusher(14, 120);
    let spoken = 0;
    const feed = () => {
      const fresh = sofar.text.slice(spoken);
      if (!fresh) return;
      spoken = sofar.text.length;
      for (const seg of flusher.push(fresh)) voice().speak({ text: seg });
    };

    try {
      if (corpus.current === null) {
        const docs = await Promise.all(agendaDocIds().map((id) => api.getDoc(id)));
        corpus.current = corpusText(docs.map((d) => d.doc));
      }
      const context = `${await api.chatContext()}\n\n${corpus.current}`;

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctl.signal,
        body: JSON.stringify({
          mode: "oral",
          context,
          agenda: agendaOutline(),
          messages: turns.current,
        }),
      });
      if (!res.ok || !res.body) {
        const why = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(why?.error ?? `模型没答上来（HTTP ${res.status}）。`);
      }

      await drain(
        res.body,
        sofar,
        () => {
          feed();
          // 有声音在放的时候字幕归播放器管（见 `audible`），这一行就不抢了。
          if (!audible.current) {
            dispatch({ type: "CAPTION", text: lastSentence(sofar.text), partial: true });
          }
        },
        (event: StageEvent) => dispatch(event),
      );

      if (sofar.text.trim()) {
        turns.current = [...turns.current, { role: "assistant", content: sofar.text.trim() }];
        // 最后半句也要念出来 —— 它常常是那句「您看这样行不行」。
        feed();
        for (const seg of flusher.end()) voice().speak({ text: seg });
        if (!audible.current) dispatch({ type: "CAPTION", text: lastSentence(sofar.text) });
      }
    } catch (e) {
      /*
       * 会上出错怎么办：**说出来，别装作没事**。
       *
       * 字幕那一行是他和秘书都看得见的地方，报错就写在那儿。屏幕上那张卡留在原地不动 ——
       * 他正指着它讲话，把它换成一个错误页是最坏的选择。他要接着往下走，语音条的输入框
       * 和控制台的热键都还在，两条都不经过刚才失败的这一步。
       */
      if (!ctl.signal.aborted) {
        dispatch({
          type: "CAPTION",
          text: `接不上模型：${e instanceof Error ? e.message : "网络错误"}`,
        });
      }
    } finally {
      if (inflight.current === ctl) {
        inflight.current = null;
        setBusy(false);
        busyRef.current = false;
      }
    }
  }, [voice]);

  /*
   * 把这两条命令的最新版本交给麦克风那一头。
   *
   * 没有依赖数组，每次渲染都刷一遍 —— 这正是想要的：`Listener` 只在开麦那一下建一次，它手里
   * 那份回调必须永远是最新的 `say`/`stop`，而不是建它那一帧的版本。
   */
  useEffect(() => {
    sayRef.current = (text: string) => void say(text);
    stopRef.current = stop;
  });

  /*
   * 「下一件」是哪一件，只有这里算得出来。
   *
   * 按屏幕上正停在哪一件算，翻不动就按呈报过几件算 —— 他可能刚翻回去看过第一件的证据，
   * 那时候「下一件」是第二件；而如果他正停在一张证据卡上，就接着往下走。
   */
  const advance = useCallback((delta: number) => {
    const s = snapshot.current;
    const items = s.agenda?.items ?? [];
    if (!items.length) return;
    const now = current(s);
    const at = now?.kind === "card" ? items.findIndex((i) => i.id === now.itemId) : -1;
    const from = at >= 0 ? at : s.presented.length - 1;
    const next = Math.min(items.length - 1, Math.max(0, from + delta));
    dispatch({ type: "SHOW_CARD", itemId: items[next].id });
  }, []);

  /** 他刚问的那句话，变成一张探索卡。问的是什么只有屏幕知道，所以这一步在屏幕这边做。 */
  const explore = useCallback(() => {
    const text = asked.current;
    if (!text) return;
    dispatch({
      type: "CREATE_EXPLORATION_CARD",
      card: {
        id: `RQ-${snapshot.current.explorations.length + 1}`,
        text,
        suggestedDri: "待定",
        deadline: "待定",
        relatedIds: [],
        status: "proposed",
      },
    });
  }, []);

  /* 开屏就在呈报。议程是静态的，先上屏；模型随后开口。 */
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    dispatch({ type: "SHOW_AGENDA" });
    void say("开始呈报。");
  }, [say]);

  /* ← / → 翻卡片历史。输入框里按方向键不算。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        dispatch({ type: "STAGE_BACK" });
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        dispatch({ type: "STAGE_FORWARD" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /*
   * 秘书控制台那条线。
   *
   * `EventSource` 是浏览器自带的，零依赖，断了自己重连 —— 会议室的 wifi 抖一下不该让
   * 兜底方案跟着失效。
   */
  useEffect(() => {
    const es = new EventSource("/api/stage");
    const onBus = (e: MessageEvent<string>) => {
      let message: BusMessage | null = null;
      try {
        message = JSON.parse(e.data) as BusMessage;
      } catch {
        return;
      }
      switch (message.kind) {
        case "event":
          dispatch(message.event);
          break;
        case "say":
          void say(message.text);
          break;
        case "stop":
          stop();
          break;
        case "advance":
          advance(message.delta);
          break;
        case "explore":
          explore();
          break;
        /*
         * 放一条备好的台词。
         *
         * 这是拔了网线之后整场会唯一还能出声的路：`/api/speak` 命中 `demo/audio/` 里的文件，
         * 一步都不经过模型和厂商。所以它在这里必须是最短的一条 —— 收到就放。
         */
        case "play":
          voice().speak({ line: message.lineId });
          break;
        case "replay":
          voice().replay();
          break;
        /*
         * 唤醒声音。
         *
         * 浏览器不许没有用户手势就出声。投影那块屏可能整场没人碰过它（他在讲，秘书在按另一台
         * 设备），那时候 `AudioContext` 还是 suspended 的 —— 一声都不会响，而且不报错。
         * 秘书在控制台上按一下这个，屏幕那边就醒了。
         */
        case "wake":
          void voice().unlock();
          break;
        /*
         * 秘书那边开麦 / 关麦。
         *
         * 关麦保证能成。开麦不一定：浏览器要一次真实手势才给麦克风 —— 如果屏幕这台机器上
         * 从来没点过那个按钮，这一下会以「没权限」收场，那句话会写在语音条上。
         */
        case "mic":
          // 秘书按这一下就是「这条不用了」——那句红字也跟着收掉，别在投影上留一行过期的警告。
          setMicNote(null);
          if (message.on) void ear().start();
          else listener.current?.stop();
          break;
      }
    };
    const onReady = () => setLinked(true);
    const onError = () => setLinked(false);
    es.addEventListener("bus", onBus as EventListener);
    es.addEventListener("ready", onReady);
    es.addEventListener("error", onError);
    return () => es.close();
  }, [say, stop, advance, explore, voice, ear]);

  const value = useMemo<StageValue>(
    () => ({
      state,
      frame: current(state),
      dispatch,
      say: (text: string) => void say(text),
      stop,
      busy,
      linked,
      mic,
      micNote,
      toggleMic,
    }),
    [state, say, stop, busy, linked, mic, micNote, toggleMic],
  );

  return <StageContext.Provider value={value}>{children}</StageContext.Provider>;
}

export function useStage(): StageValue {
  const ctx = useContext(StageContext);
  if (!ctx) throw new Error("useStage 必须在 StageProvider 里面用。");
  return ctx;
}

/**
 * 最新那一句。
 *
 * 字幕只放一行 —— 投影上两行字幕会盖住卡片下沿，而卡片才是主角。按中文句末标点切，
 * 取最后一句非空的。他还在说的时候最后一句是半截的，这是对的：字幕就该跟着嘴走。
 *
 * 只念不出来的那些段跳过去。提示词里写了「不要 markdown」，探针里它还是会在末尾甩一条
 * `---` —— 那条会当场变成投影上唯一的一行字幕。这里不去清洗正文（正文是要念的，M2 的
 * TTS 那边再管），只是不让一段没有字的东西占住字幕位。
 */
const SPEAKABLE = /[\p{L}\p{N}]/u;

function lastSentence(text: string): string {
  const parts = text.split(/(?<=[。！？；\n])/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const t = parts[i].trim();
    if (t && SPEAKABLE.test(t)) return t;
  }
  return text.trim();
}

const isTyping = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
};
