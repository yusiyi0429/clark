"use client";

import { ArrowUp, FileText, Image as ImageIcon, Paperclip, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AsyncBoundary, LoadingLine } from "@/components/async-boundary";
import { DeepResearchCard } from "@/components/advisor/deep-research-card";
import { TianshuThinkingMark } from "@/components/brand/tianshu-mark";
import { Markdown } from "@/components/chat/markdown";
import { TurnActions } from "@/components/chat/turn-actions";
import { JumpToBottom, useStickToBottom } from "@/components/chat/use-stick-to-bottom";
import { useStreamedText } from "@/components/chat/use-streamed-text";
import { ThreadRail } from "@/components/chat/thread-rail";
import {
  SelectionToolbar,
  useSelectionQuote,
} from "@/components/provenance/selection-quote";
import { readSse } from "@/lib/agent/sse";
import { api } from "@/lib/data/client";
import { formatDuration, formatStamp } from "@/lib/format";
import type { AdvisorMessage, AdvisorPreset } from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 与参谋的对话。
 *
 * 潜在议题和议题研究**共用这一个组件** —— 两页上的对话是同一件事：他就着一份已经查过
 * 的东西追问。不同的只是那份东西的深浅（预研 / 深研），而深浅是上下文的差别，不是控件
 * 的差别。做成两套，迟早会在一套上修了 bug 而另一套没修。
 *
 * `preface` 是唯一的差异口子：潜在议题那一页要在对话最上面放一个「查看预研报告原文」的
 * 展开器 —— 展开之后像一条很长的回复。放在对话里而不是另起一栏，是因为那份报告是参谋
 * 说这些话的依据，依据和话之间不该隔一条分栏线。
 */

/** 一次没成的模型调用留下的那行字。它必须说清楚是模型没接上，不能装成参谋没话说。 */
type Failure = { why: string; fellBack: boolean };

/**
 * 读一次墙钟。
 *
 * 抽到组件外面，是为了让编译器看清楚它不在渲染里跑 —— 它只被事件处理里那条计时用到。
 * 渲染期间读时钟会让同一次渲染在两台机器上得出不同结果，这条规则是对的，只是这里
 * 触发的是误报。
 */
const clockMs = (): number => Date.now();

/** 正文读得出来的那几类。别的只带走文件名。 */
const TEXTUAL = /\.(txt|md|markdown|csv|tsv|json|log|ya?ml|ts|tsx|js|jsx|py|sql)$/i;

/** 一次带太多字进上下文会把真正的问题挤掉。超过就截断，并且**在屏幕上说明截过**。 */
const ATTACH_LIMIT = 6000;

/**
 * 把带上来的文件折成问题的一部分。
 *
 * 文本类的正文真的读进来 —— 参谋答的时候看得到。图片和二进制只写文件名：这条链路上
 * 的模型看不了图，把一张图塞进去然后让它「看图说话」，得到的是编的。宁可屏幕上写着
 * 「只带了文件名」，也不要一段读起来很像真的的胡话。
 */
async function foldAttachments(files: File[]): Promise<string> {
  const parts: string[] = [];
  for (const f of files) {
    if (f.type.startsWith("text/") || TEXTUAL.test(f.name)) {
      const raw = (await f.text()).trim();
      const body =
        raw.length > ATTACH_LIMIT ? `${raw.slice(0, ATTACH_LIMIT)}\n……（后面截断了）` : raw;
      parts.push(`【附件 ${f.name}】\n${body}`);
    } else if (f.type.startsWith("image/")) {
      parts.push(`【附图 ${f.name}】（图片正文没进上下文）`);
    } else {
      parts.push(`【附件 ${f.name}】（${Math.max(1, Math.round(f.size / 1024))} KB，正文没进上下文）`);
    }
  }
  return parts.join("\n\n");
}

export function ChatPane({
  issueId,
  quote,
  onRound,
  composerRef,
  preface,
  note,
  ephemeral = false,
  bare = false,
  presetKey,
  transcriptKey,
}: {
  issueId: string;
  quote?: string;
  /** 参谋每答完一轮叫一次 —— 议题研究用它去重取链路图。 */
  onRound?: () => void;
  /** 别处「引用提问 / 就这句聊」把一段话递进来的口子。 */
  composerRef?: React.RefObject<{ quote: (text: string) => void } | null>;
  /** 钉在对话最上面的东西。 */
  preface?: React.ReactNode;
  note?: string;
  /**
   * **这几轮不进判断演进萃取。**
   *
   * 潜在议题这一页用它。理由是产品判断：分诊阶段他要回答的是一个二元问题
   * （这值不值得我投入），不是在建立一条要负责的判断。把这几轮当成判断的来源，
   * 等于把一段「他还在决定要不要开始」的对话读成「这件事讨论过了」的证据。
   *
   * 议题研究那一页反过来：那条路径他要负责，所以每一轮都落库，还要萃取成判断版本。
   *
   * **2026-08-31 之前这条同时意味着「不存」，现在不是了。** 上一版消息只活在组件
   * state 里，刷新即清空 —— 而他再点进同一张卡时看到的是空白，上一次问过什么、
   * 参谋答过什么全没了。现在给了 `transcriptKey` 的那一档写进 `${issueId}:signal`
   * 那一支（见 `persistTo`）：萃取那几处读的是裸 `issueId`，一处都读不到它，
   * 所以上面那条边界一个字都没让。
   *
   * 不给 `transcriptKey` 时才是真的不存 —— 那一档眼下没有页面走到。
   */
  ephemeral?: boolean;
  /**
   * **不给自己套框。**
   *
   * 议题研究那一页用它：那一页整屏是一张纸，左右两栏之间只有一条竖线，没有卡片
   * （理由整段写在 `app/_views/advisor-view.tsx` 上）。这一栏于是只剩内容，面、边、
   * 圆角都交给页面。
   *
   * 潜在议题那一页不给：那一页左边是一块真的卡片（分诊详情），右边这一栏得跟它同一档
   * 材质，不然一屏上一半有框一半没框。哪一页是哪一种由页面决定，组件不猜。
   */
  bare?: boolean;
  /**
   * 快捷条从哪一组取。默认就是 `issueId`。
   *
   * 同一件议题在两个阶段各有一组问题：潜在议题那一页问的是「这跟我们有什么关系」，
   * 议题研究那一页问的是「研究之后你的判断是什么」。两组共用一个 key 的话，
   * 分诊阶段就会冒出几句只有读完深研报告才问得出来的问题。
   */
  presetKey?: string;
  /**
   * 分诊那一栏的对谈记录挂在哪一支上（读和写都是它）。
   *
   * 设了它，这一栏开场就是上次聊到哪 —— 而不是一排等着点的预设问题。快捷条同时
   * 关掉：一段已经发生过的对话下面挂几颗「点我提问」的按钮，会把记录读成剧本。
   *
   * 新问的那几轮也写回这一支（`persistTo === "signal"`），所以「上次聊到哪」这句话
   * 从这一版起对**这一次**也成立 —— 上一版它只对内容包里预置的那几轮成立。
   */
  transcriptKey?: string;
}) {
  const presetId = presetKey ?? issueId;
  const messagesRes = useResource<AdvisorMessage[]>(
    transcriptKey ? `signal-talk:${transcriptKey}` : `advisor:${issueId}`,
    () =>
      transcriptKey
        ? api.getSignalTranscript(transcriptKey)
        : // 不落库的那一页连读都不读 —— 读一次会在对象库里建一条空线程。
          ephemeral
          ? Promise.resolve([])
          : api.listAdvisorMessages(issueId),
  );
  /*
   * 不落库时的本地消息表。用 ref 是因为同一次 `ask` 里要连着追加两条（他的问题、
   * 参谋的回复），而 setState 在同一个事件里读不到上一次的结果。
   */
  const localRef = useRef<AdvisorMessage[]>([]);
  const [local, setLocal] = useState<AdvisorMessage[]>([]);
  const presetRes = useResource<AdvisorPreset | null>(
    transcriptKey ? null : `preset:${presetId}`,
    () => api.getAdvisorPreset(presetId),
  );

  const [text, setText] = useState("");
  /*
   * 引用不塞进输入框。塞进去的那一版里，引文和他自己要问的话混成一坨字，删起来得
   * 自己找边界。现在引文是输入框上面一排卡片，各自带一枚 ×。
   */
  const [quoted, setQuoted] = useState<string[]>(quote ? [quote] : []);
  /** 这一问要带走的文件。发出去之后清空 —— 它属于那一问，不属于这一栏。 */
  const [files, setFiles] = useState<File[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  /**
   * 这一轮此刻在哪一步。服务端的 `event: step` 喂它（`api/chat/route.ts`），第一个字
   * 落下之前那行扫光小字读的就是它。
   *
   * `null` = 服务端还没报过任何一步，那时说「正在想」—— **不在这里编一个假的第一步**：
   * 旧路（没有议题、或者这条议题还没有报告）压根不发 `step`，那一路从头到尾就是「正在想」，
   * 这是对的。同理由写在 `ResearchStepLine` 的 `fallback` 上。
   */
  const [step, setStep] = useState<string | null>(null);
  /**
   * **这一轮**里参谋把事情转给深研的那一次。服务端的 `event: research` 喂它
   * （`api/chat/route.ts` 里 `escalate` 那一格）。
   *
   * 只活到这一轮落库为止：落库那一下它跟着这一轮一起写进 `AdvisorMessage.deepHandoff`，
   * 之后屏幕上那块东西是从消息里读出来的（见 `Bubble`）。**这里不留长期状态** ——
   * 上一版留了，后果是他离开这一页再回来那块东西就没了，而且它永远钉在整栏最下面，
   * 离触发它的那句话越来越远。
   *
   * 走 ref 是因为 `ask` 那个闭包要在自己跑着的时候读它（同 `aborter` 那一段的理由）；
   * 屏幕上流式期间那一块读的是下面的 state。
   */
  const handoffRef = useRef<{ issueId: string; why: string } | null>(null);
  const [handoff, setHandoff] = useState<{ issueId: string; why: string } | null>(null);
  /** 这一轮的表从什么时候开始走。流式期间那行「耗时」读的就是它。 */
  const [askedAt, setAskedAt] = useState<number>(() => Date.now());
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * 这一轮的中止把手。**只有流式那一路有** —— 「查一下」那一路是等服务端把检索、抓取、
   * 抽取跑完才回一次，中途按停既停不掉那边的活，也留不下半个结果，那时给一颗停止键是
   * 在承诺一件做不到的事。
   *
   * 存在 ref 里而不是 state：`ask` 那个闭包要在自己跑着的时候读它，而 state 在闭包里是
   * 那一次渲染的快照。屏幕上那颗键读的是下面的 `stoppable`。
   */
  const aborter = useRef<AbortController | null>(null);
  const [stoppable, setStoppable] = useState(false);
  /** 上一轮是他自己按停的。屏幕上要说一句 —— 半截的回答和写完的回答长得一样。 */
  const [stopped, setStopped] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  /**
   * 这一栏的几轮写到哪儿去。**三档，不是两档。**
   *
   * - `"advisor"` —— 议题研究那一页。写裸 `issueId` 那一支，会触发判断演进萃取。
   * - `"signal"` —— 分诊那一页。写 `${issueId}:signal` 那一支（`store.ts` 的
   *   `openSignalTurn` / `recordSignalReply`）：**记录留下，萃取不做**。上一版这一档
   *   和下面那一档是同一个，于是他再点进这张卡，上一次聊的几轮全没了 —— 而「不该把
   *   分诊几轮当成证据」这条要求，靠的是 key 分家，不需要靠不存。
   * - `null` —— 真的不落库。`ephemeral` 而又没给 `transcriptKey` 的那一档，眼下没有
   *   页面走到，留着是因为「不落库」是这个组件真实支持的一种语义。
   */
  const persistTo: "advisor" | "signal" | null = transcriptKey
    ? "signal"
    : ephemeral
      ? null
      : "advisor";

  /*
   * 真不落库那一档：屏幕上是「历史记录 + 这一次新问的几轮」。历史那一半来自数据层
   * （只读），新问的那一半只活在 `local` 里。另外两档 `local` 恒空。
   */
  const history = messagesRes.data ?? [];
  const messages = persistTo === null ? [...history, ...local] : history;

  /**
   * 追加一轮。三档落库口径唯一的分叉点 —— 上面那一大段流式逻辑三种完全共用。
   */
  const appendTurn = async (
    role: "user" | "agent",
    text: string,
    elapsedMs?: number,
    /** 这一轮转过深研的话，那次转手跟着一起落库（`AdvisorMessage.deepHandoff`）。 */
    deepHandoff?: { issueId: string; why: string },
  ): Promise<AdvisorMessage[]> => {
    if (persistTo === null) {
      const next = [
        ...localRef.current,
        {
          id: `EPH-${issueId}-${localRef.current.length + 1}`,
          role,
          text,
          at: new Date().toISOString(),
          ...(elapsedMs === undefined ? {} : { elapsedMs }),
          ...(deepHandoff === undefined ? {} : { deepHandoff }),
        } satisfies AdvisorMessage,
      ];
      localRef.current = next;
      setLocal(next);
      // 递给模型的是整段上下文 —— 历史那几轮也在里面，不然它会从头解释一遍。
      return [...history, ...next];
    }
    const list =
      persistTo === "signal"
        ? role === "user"
          ? await api.openSignalTurn(transcriptKey!, text)
          : await api.recordSignalReply(transcriptKey!, text, elapsedMs)
        : role === "user"
          ? await api.openAdvisorTurn(issueId, text)
          : await api.recordAdvisorReply(issueId, text, elapsedMs, deepHandoff);
    await messagesRes.mutate(list, { revalidate: false });
    return list;
  };

  /**
   * 给某一轮点赞或点踩。
   *
   * 三档落库口径在这里再分一次叉，理由同 `appendTurn` —— 两支对谈的 key 是分家的
   * （裸 `issueId` / `${issueId}:signal`），而那件事是库那一侧的规矩，组件只认自己
   * 已经在用的那个标识。
   *
   * 不落库那一档（`ephemeral` 而又没给 `transcriptKey`）**整排拇指都不出现**，所以
   * 这个函数在那一档不会被叫到（见下面 `rateOf`）：点了留不住的拇指比没有更糟。
   *
   * 失败就把错摆出来，不悄悄回滚成没点过 —— 屏幕上「点了没反应」和「这一栏坏了」
   * 长得一样，而后者他需要知道。
   */
  const rate = async (messageId: string, verdict: "up" | "down") => {
    try {
      const list =
        persistTo === "signal"
          ? await api.rateSignalMessage(transcriptKey!, messageId, verdict)
          : await api.rateAdvisorMessage(issueId, messageId, verdict);
      await messagesRes.mutate(list, { revalidate: false });
    } catch (e) {
      setFailure({
        why: e instanceof Error ? e.message : "这一下没记上。",
        fellBack: false,
      });
    }
  };

  /** 从别处（报告浮窗、划词）把一段原文递进输入框上面那排引用卡。 */
  const quoteIntoComposer = (text: string) => {
    setQuoted((list) => [...list, text]);
    composer.current?.focus();
  };

  /** 这一轮给不给那两枚拇指。不落库的那一档不给（理由在 `rate` 上）。 */
  const rateOf = (m: AdvisorMessage) =>
    persistTo === null ? undefined : (v: "up" | "down") => void rate(m.id, v);

  /**
   * 参谋还在写的时候，屏幕上放出来的是这一段 —— 不是刚到的那一批分片。
   *
   * 中间垫一层匀速的放字（`useStreamedText`）：上游是一批一批到的，直接上屏就是「停一下、
   * 蹦出二十个字」。这一栏底下的滚动也跟着这一份走，不跟缓冲 —— 跟缓冲的话，屏幕上还没
   * 出现的字已经把滚动条推下去了。
   */
  const shown = useStreamedText(streaming ?? "", streaming !== null);

  /*
   * 跟着底走，**但他往上翻的时候就松开**（整段理由在 `useStickToBottom`）。上一版是无条件
   * `scrollTop = scrollHeight`：参谋写的那一两分钟里他没法停在任何地方读，一秒被拽回底部
   * 好几次。
   *
   * 信号取的是「轮数 + 此刻已经放出来多少字」——两样都变才叫屏幕上多了东西。
   */
  const { scroller, atBottom, scrollToBottom } = useStickToBottom(
    `${messages.length}:${shown.length}:${step ?? ""}`,
  );

  /*
   * 划词引用挂在同一个滚动容器上。摆在这里是因为那个容器的 ref 现在由上面那个 hook 造
   * （理由写在 `useStickToBottom` 上），而 hook 的调用顺序就是它们之间的依赖顺序。
   */
  const { selected, clear, onMouseUp } = useSelectionQuote(scroller);

  /*
   * 参谋答完一轮，通知调用方一次。
   *
   * ## 回调走 ref
   *
   * 调用方给的是一个内联箭头函数（`advisor-view.tsx`），每次重渲染都是一个新的函数。
   * 把它放进依赖数组，这个 effect 就变成「每渲染一遍跑一次」；而它做的事正是让调用方
   * 去重取判断板和链路图 —— 数据回来调用方重渲染，新的箭头函数，effect 再跑一次。
   * **自己喂自己**：2026-08-20 在议题研究那一页量到每三秒一百来个 `/api/data`，
   * 一直转到关掉标签页为止。它同时把服务端每一次读板都放大了几十倍。
   *
   * ## 为什么还要记住上一次的轮数
   *
   * 只留 `agentCount` 作依赖的话，这一栏的历史读回来那一下（0 → N 条）也算「答完
   * 一轮」，于是每次进页面都白刷一遍板和链路图 —— 而那两样自己刚在上面取过。
   * 只有真的多出一轮才通知。
   */
  const notifyRound = useRef(onRound);
  useEffect(() => {
    notifyRound.current = onRound;
  }, [onRound]);
  const loaded = messagesRes.data !== undefined;
  const agentCount = messages.filter((m) => m.role === "agent").length;
  const seenRounds = useRef<number | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const before = seenRounds.current;
    seenRounds.current = agentCount;
    if (before === null || agentCount <= before) return;
    notifyRound.current?.();
  }, [agentCount, loaded]);

  useEffect(() => {
    if (!composerRef) return;
    composerRef.current = {
      quote: (stamp: string) => {
        setQuoted((list) => (list.includes(stamp) ? list : [...list, stamp]));
        requestAnimationFrame(() => composer.current?.focus());
      },
    };
    return () => {
      composerRef.current = null;
    };
  }, [composerRef]);

  /*
   * 带着引文进来的那一次：把 `?quote=` 从地址栏摘掉 —— 他清空重写之后刷新一下，不该
   * 又冒出同一段引文。
   */
  useEffect(() => {
    if (!quote) return;
    composer.current?.focus();
    window.history.replaceState(null, "", window.location.pathname);
  }, [quote]);

  /**
   * 输入区里那几样折成一句话：引文、他打的字、带上来的文件正文。
   *
   * 两条出口共用（问一句 / 查一下）—— 各折各的表现是同一次输入在两颗键上带走的东西
   * 不一样，而屏幕上两边看起来完全相同。清空输入区不在这里做：那要等这句话真的记下来
   * 之后才做得，而两条出口记的时机不同。
   */
  const compose = async (line: string): Promise<string> => {
    const attached = files.length > 0 ? await foldAttachments(files) : "";
    return [...quoted, line.trim(), attached].filter(Boolean).join("\n\n").trim();
  };

  /**
   * 问一句。
   *
   * 顺序是：先把他说的这句记下来（`openAdvisorTurn`），再去问模型。反过来的话，模型
   * 中途断了他刚说的那句就没了 —— 他说过的话不该因为模型的问题而消失。
   */
  const ask = async (line: string, fallback?: string, script?: string) => {
    // 只带了文件、一个字没写也算一问 —— 「你看看这个」本来就是一句完整的话。
    if ((line.trim().length === 0 && quoted.length === 0 && files.length === 0) || busy) return;
    setBusy(true);
    setFailure(null);
    setStopped(false);
    setStreaming("");
    setStep(null);
    handoffRef.current = null;
    setHandoff(null);
    try {
      // 从他按下发送那一刻掐表，到最后一个字落下为止 —— 屏幕上写的就是这个数。
      const startedAt = clockMs();
      setAskedAt(startedAt);
      const took = () => clockMs() - startedAt;

      const q = await compose(line);
      if (!q) {
        setBusy(false);
        setStreaming(null);
        return;
      }

      const opened = await appendTurn("user", q);
      setText("");
      setQuoted([]);
      setFiles([]);

      /*
       * 走剧本的那一路。
       *
       * 逐字吐出来而不是整段拍上去：演示里那几秒的「它在想」不是装饰 —— 一段话
       * 瞬间出现，看的人第一反应是「这是预先写好的」，而这正是要避免的印象。
       * 节奏取的是真流式的下限，不做慢放。
       */
      /*
       * 这一轮的中止把手。**两条路共用一个** —— `/api/chat` 那一侧把 `req.signal` 一路
       * 递到上游调用上，所以按停真模型是把那次生成掐掉，不是前端不显示了（后者等于照旧
       * 烧完这一轮的钱）；剧本那一路没有钱可省，但屏幕上那十几秒的逐字输出同样得能打断
       * —— 一颗只在某些轮次有效的停止键，比没有更难用。
       */
      const ctl = new AbortController();
      aborter.current = ctl;
      setStoppable(true);

      if (script) {
        /** 屏幕上已经出到第几个字。按停之后落库的就是这一截。 */
        let wrote = 0;
        try {
          for (let i = 1; i <= script.length; i += 2) {
            if (ctl.signal.aborted) break;
            wrote = i;
            setStreaming(script.slice(0, i));
            await new Promise((r) => setTimeout(r, 12));
          }
        } finally {
          aborter.current = null;
          setStoppable(false);
        }
        /*
         * 按停之后落库的是**屏幕上到此为止的那一段**，不是整份剧本：记下整份等于把一段
         * 他没读到、而且他刚要求别再写的话说成参谋说过的。
         */
        if (ctl.signal.aborted) {
          setStopped(true);
          const partial = script.slice(0, wrote);
          if (partial.trim().length > 0) await appendTurn("agent", partial, took());
        } else {
          await appendTurn("agent", script, took());
        }
        return;
      }

      let reply = "";
      let why: string | null = null;
      try {
        const context = await api.advisorContext(issueId);
        const res = await fetch("/api/chat", {
          method: "POST",
          signal: ctl.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "manual",
            context,
            // 服务端拿它去本体取企业 Context。只递 id —— 标题在服务端查，
            // 免得前端和服务端各存一份会漂移的标题。
            issueId,
            messages: opened.map((m) => ({
              role: m.role === "agent" ? "assistant" : "user",
              content: m.text,
            })),
          }),
        });
        if (!res.ok || !res.body) {
          const detail = (await res.json().catch(() => null)) as { error?: string } | null;
          why = detail?.error ?? `模型拒了这次请求（HTTP ${res.status}）。`;
        } else {
          for await (const frame of readSse(res.body)) {
            if (frame.event === "text") {
              reply += JSON.parse(frame.data) as string;
              setStreaming(reply);
            } else if (frame.event === "step") {
              setStep(JSON.parse(frame.data) as string);
            } else if (frame.event === "research") {
              const h = JSON.parse(frame.data) as { issueId: string; why: string };
              handoffRef.current = h;
              setHandoff(h);
            } else if (frame.event === "error") {
              why = JSON.parse(frame.data) as string;
            }
          }
        }
      } catch (e) {
        /*
         * **他按的停不是一次失败。** 两者在这里长得一样（都是从 `await` 里抛出来的），
         * 而分不开的后果是屏幕上用报错那行字去说他自己刚做的动作。
         */
        if (ctl.signal.aborted) setStopped(true);
        else why = e instanceof Error ? e.message : "没连上模型。";
      } finally {
        aborter.current = null;
        setStoppable(false);
      }

      if (reply.trim().length > 0) {
        // 按停之前已经写出来的照旧记成这一轮 —— 那几个字是真花过钱的，而且他读过了。
        await appendTurn("agent", reply, took(), handoffRef.current ?? undefined);
        if (why) setFailure({ why, fellBack: false });
      } else if (ctl.signal.aborted) {
        // 一个字都没出来就被按停：不留一条空回复，那行说明自己会说清楚发生了什么。
      } else if (fallback) {
        await appendTurn("agent", fallback, took());
        setFailure({ why: why ?? "模型没接上。", fellBack: true });
      } else {
        setFailure({ why: why ?? "模型没说出东西来。", fellBack: false });
      }
    } finally {
      setStreaming(null);
      setStep(null);
      setBusy(false);
    }
  };

  /**
   * 按停。**掐的是这一轮的生成本身**（`AbortController` → `fetch` → `/api/chat` 把
   * `req.signal` 递给上游），不是前端把它藏起来 —— 藏起来的那一版屏幕上安静了，而那一轮
   * 照旧一路烧到结束。
   *
   * 停下之前已经写出来的那几个字留着（见 `ask` 里那一段）：他读过了，而且那是真花过钱的
   * 东西。
   */
  const stop = () => {
    aborter.current?.abort();
  };

  const asked = new Set(messages.filter((m) => m.role === "user").map((m) => m.text));
  const chips = (presetRes.data?.chips ?? []).filter((c) => !asked.has(c.q));
  /*
   * 这一组问答走不走剧本，由**数据**说了算（见 `AdvisorPreset.scripted`）。
   * 只有 demo 内容包打开它；他自己在输入框里打的字永远接真模型。
   */
  const scripted = presetRes.data?.scripted === true;

  return (
    <section
      aria-label="与参谋对话"
      /* `bare` 那一档没有面、没有边、没有圆角：那一页整屏是一张纸，这一栏和左栏之间
         只有一条竖线（画在左栏的右边沿）。理由整段写在 `advisor-view.tsx` 上。 */
      className={cn(
        "flex min-h-0 flex-col overflow-hidden",
        !bare && "rounded-xl border border-hairline bg-surface",
      )}
    >
      {/*
       * 顶上这条只在**有框**那一档存在（分诊那一页：左边一块卡片，右边这一栏，两块各自
       * 得有个抬头）。
       *
       * 议题研究那一页拿掉了。那一页整屏是一张纸，而「与参谋对话」这四个字在那儿是一句
       * 废话：右半屏摆着一串气泡、底下是一个写着「问一句」的输入框，没有人需要被告知
       * 这是对话。它换来的是 44px 正文高度 —— 那一页所有改动都在为同一件事让路。
       *
       * `h-11` 留着不动：分诊那一页左边那块卡片的抬头也是这个数，两条抬头并排，高度
       * 差一点，它们底下那道线就会在中间错开一节。
       */}
      {bare ? null : (
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-hairline px-6">
          <span className="meta font-medium text-ink">与参谋对话</span>
          {note && <span className="meta ml-auto text-ink-faint">{note}</span>}
        </header>
      )}

      <div className="relative min-h-0 flex-1">
        <ThreadRail messages={messages} scroller={scroller} />
        {/*
         * 只在他往上翻走之后才出现的那条回去的路。压在对话区底沿正中，不进版面 ——
         * 它是一条临时的路，不是这一栏的常驻控件（整段理由在 `useStickToBottom`）。
         */}
        <JumpToBottom show={!atBottom} onClick={() => scrollToBottom(true)} />
        {/*
         * 两边留白。
         *
         * 上一版内容贴着框边，左边更糟：导航条那一列短横线紧挨着正文，读起来像正文
         * 长了一条毛边，而它本来是一列可以点的地标。留白把两者分开 —— 边距不是装饰，
         * 它是「这两样东西不属于同一层」的唯一说明。
         */}
        <div
          ref={scroller}
          onMouseUp={onMouseUp}
          className="scroll-slim relative h-full space-y-6 overflow-y-auto py-6 pr-7 pl-12"
        >
          <SelectionToolbar
            selected={selected}
            onQuote={() => {
              if (!selected) return;
              setQuoted((list) => [...list, `「${selected.text}」`]);
              clear();
              composer.current?.focus();
            }}
          />

          {preface}

          <AsyncBoundary resource={messagesRes} skeleton={<LoadingLine label="正在打开这段对谈" />}>
            {() => (
              <>
                {/*
                 * 空态什么都不放 —— 不放一句假的开场白：参谋的判断已经在左栏了，在这里
                 * 再让它「开口」一次，等于同一段话说两遍，而第二遍是编的。
                 */}
                {messages.map((m) => (
                  <Bubble
                    key={m.id}
                    message={m}
                    onVerdict={rateOf(m)}
                    onQuote={quoteIntoComposer}
                  />
                ))}
                {streaming !== null && (
                  <div>
                    {/* 表在跑的时候就走起来 —— 落定之后那个数字才对得上他刚等的这一段。 */}
                    <Ticker key={askedAt} from={askedAt} />
                    <hr className="mt-1.5 border-0 border-t border-hairline" />
                    {shown.length === 0 ? (
                      /*
                       * 等第一个字的时候那行字。
                       *
                       * 天枢标记里的三根轴各自转动，说明「Agent 正在工作」；旁边那道从左往右
                       * 扫过文字的光（`.sweeping-text`，globals.css）继续说明「这一步仍然
                       * 有效」。两者不是重复：标记负责身份和动作，文字负责报出此刻具体在做什么。
                       *
                       * 字换成服务端报上来的那一步。`aria-live` 让读屏跟着念 —— 这行字
                       * 会自己变，不念的话它对读屏用户等于不存在。
                       */
                       <p
                         className="talk mt-1.5 flex items-center gap-2 text-md"
                         aria-live="polite"
                       >
                         <TianshuThinkingMark className="size-[18px] flex-none" />
                         <span className="sweeping-text">{step ?? "正在想"}</span>
                       </p>
                    ) : (
                      <AgentText text={shown} typing />
                    )}
                    {/*
                     * 转手是在这一轮里发生的，所以那块东西也长在这一轮里 —— 流式期间
                     * 先由 state 顶着，这一轮落库之后它由消息自己带（见 `Bubble`）。
                     * 两处画的是同一个组件，切换发生在 `streaming` 变回 null 的那一帧。
                     */}
                    {handoff ? (
                      <DeepResearchCard
                        issueId={handoff.issueId}
                        why={handoff.why}
                        onQuote={quoteIntoComposer}
                      />
                    ) : null}
                  </div>
                )}
                {stopped ? (
                  /*
                   * 他自己按的停，所以这行字是**灰的**，不是报错那一档的红。半截的回答和
                   * 写完的回答在屏幕上长得一样，不说一句的话，他下次读到这一条会以为参谋
                   * 就说了这么多。
                   */
                  <p className="meta text-ink-faint">
                    这一轮你按停了 —— 上面那段是它停下之前已经写出来的。
                  </p>
                ) : null}
                {failure ? (
                  <p className="meta text-counter">
                    {failure.fellBack
                      ? `模型没接上（${failure.why}）—— 上面那段是公司已有的标准口径，不是它现说的。`
                      : failure.why}
                  </p>
                ) : null}
              </>
            )}
          </AsyncBoundary>
        </div>
      </div>

      {/*
       * 输入区 —— **一块浮在纸上的东西，不是钉在底边的一条槽。**
       *
       * 上一版是一条 `border-t` 的 footer，里面横排着「附件 / 查一下 / 输入框 / 发送」
       * 四件。那条横线把这一栏切成上下两半，而输入框在这个产品里不是「另一栏」：它是
       * 他此刻要说的那句话，和上面那些气泡是同一件事的两个时刻。四件横排还有一个更
       * 实际的问题 —— 输入框被两侧的键挤成中间一格，一句长问题在里面折三行。
       *
       * 现在是一块**整体的圆角面**（同 Codex 那个输入区）：字在上，两颗键收在它里面
       * 的下沿，附件在左、发送在右。于是输入框有整行宽度，而两颗键仍然一眼看得到。
       *
       * `border-t` 撤掉了：这一块自己有边有面，再加一条通栏的线等于给同一个边界画两遍。
       * 底下留 `pb-5` —— 那段空白就是「它浮着」这句话本身。
       */}
      <footer className="shrink-0 px-5 pt-2 pb-5">
        {chips.length > 0 && (
          <div className="mb-2.5 flex flex-col gap-1.5">
            {chips.map((c) => (
              <button
                key={c.q}
                type="button"
                disabled={busy}
                onClick={() => void ask(c.q, c.reply, scripted ? c.reply : undefined)}
                className="clamp-2 rounded-md border border-hairline px-2.5 py-1.5 text-left text-sm text-ink-muted transition-colors duration-fast ease-swift hover:border-hairline-strong hover:text-ink disabled:opacity-50"
              >
                {c.q}
              </button>
            ))}
          </div>
        )}

        {/*
         * 引文、附件、正文、两颗键**在同一块面里**。
         *
         * 引文和附件原来摆在输入框上面、这块面外面 —— 于是「这一问要带走的东西」和
         * 「这一问本身」成了两块分开的东西，撤掉一条引用像是在操作另一样东西。收进来
         * 之后它们和正文之间只隔一道内边距：一眼读出来这些都属于同一次发送。
         */}
        <div
          className={cn(
            "rounded-2xl border border-hairline bg-paper p-2 transition-colors duration-fast",
            busy ? "opacity-60" : "focus-within:border-hairline-strong",
          )}
        >
          {quoted.length > 0 && (
            <ul className="animate-fade mb-1.5 space-y-1">
              {quoted.map((q, i) => (
                <li
                  key={`${q}-${i}`}
                  className="flex items-start gap-2 rounded-lg border-l-2 border-judgment bg-judgment-wash py-1.5 pr-1.5 pl-2.5"
                >
                  <span className="clamp-3 min-w-0 flex-1 text-sm leading-relaxed text-ink-muted">
                    {q}
                  </span>
                  <button
                    type="button"
                    aria-label="去掉这条引用"
                    onClick={() => setQuoted((list) => list.filter((_, n) => n !== i))}
                    className="shrink-0 rounded p-0.5 text-ink-faint transition-colors duration-fast hover:bg-surface hover:text-ink"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* 带上来的那几份东西。发出去之前随时能撤，撤掉是一个点击。 */}
          {files.length > 0 && (
            <ul className="animate-fade mb-1.5 flex flex-wrap gap-1.5 px-1">
              {files.map((f, i) => (
                <li
                  key={`${f.name}-${i}`}
                  className="meta flex max-w-full items-center gap-1.5 rounded-md border border-hairline bg-neutral-wash py-1 pr-1 pl-2 text-ink-muted"
                >
                  {f.type.startsWith("image/") ? (
                    <ImageIcon className="size-3 shrink-0 text-ink-faint" aria-hidden />
                  ) : (
                    <FileText className="size-3 shrink-0 text-ink-faint" aria-hidden />
                  )}
                  <span className="truncate">{f.name}</span>
                  <span className="shrink-0 text-ink-faint">{Math.max(1, Math.round(f.size / 1024))}K</span>
                  <button
                    type="button"
                    aria-label={`去掉 ${f.name}`}
                    onClick={() => setFiles((list) => list.filter((_, n) => n !== i))}
                    className="shrink-0 rounded p-0.5 text-ink-faint transition-colors duration-fast hover:bg-surface hover:text-ink"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/*
           * 带一份东西进来。
           *
           * 文本类的（md / txt / csv / json / log）**正文真的会进上下文** —— 参谋答的
           * 时候读得到。图片和二进制只带走文件名：现在这条链路上的模型看不了图，
           * 假装它看得见，是这个产品最不该撒的那种谎。
           */}
          <input
            ref={picker}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              if (picked.length > 0) setFiles((list) => [...list, ...picked]);
              e.target.value = "";
            }}
          />

          <textarea
            ref={composer}
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              // 截图直接粘进来 —— 这是他最常见的那个动作，不该逼他先存成文件。
              const pasted = Array.from(e.clipboardData.files);
              if (pasted.length > 0) {
                e.preventDefault();
                setFiles((list) => [...list, ...pasted]);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(text);
              }
            }}
            placeholder="问一句"
            /* 打进去的字和它上面那颗气泡里的字是同一档（`.talk text-md`）—— 发送前后
               同一句话不该换字。改这里要连着改 `Bubble`、`AgentText` 和等待时那行小字，
               四处是同一句话的四个时刻。

               **它自己不再有边和面** —— 边和面是外面那一块的。高度从 96px 收到 64px：
               两颗键收进来之后这一块整体的高度是「字 + 一行键」，照旧 96px 的话，
               一句话的输入区会占掉这一栏五分之一。 */
            className="talk scroll-slim block h-16 w-full resize-none border-0 bg-transparent px-2 py-1 text-md text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
          />

          {/* 两颗键那一行，收在这块面的下沿。中间是空的 —— 左边是「带什么进来」，
              右边是「发出去 / 停下」，两件事分站两头，中间没有第三件。 */}
          <div className="mt-1 flex items-center justify-between">
            <button
              type="button"
              disabled={busy}
              aria-label="带一份文件或图片"
              title="带一份文件或图片"
              onClick={() => picker.current?.click()}
              className="flex size-8 items-center justify-center rounded-full text-ink-faint transition-colors duration-fast ease-swift hover:bg-neutral-wash hover:text-ink disabled:opacity-50"
            >
              <Paperclip className="size-4" aria-hidden />
            </button>

            {/*
             * 同一颗键的两副面孔：闲着的时候是发送，它在说话的时候是停止。
             *
             * **不是两颗键**。两颗的话，屏幕上永远有一颗是废的 —— 而「此刻按下去会发生
             * 什么」正是这颗键唯一要回答的问题。位置不动、形状不动，只换里面那个图形和
             * 颜色，所以他的手不用重新找。
             */}
            {stoppable ? (
              <button
                type="button"
                onClick={stop}
                aria-label="停止"
                title="停止"
                className="flex size-8 items-center justify-center rounded-full bg-ink text-paper transition-opacity duration-fast ease-swift hover:opacity-80"
              >
                {/* 实心方块 —— 「停」在全世界的播放器上都是这个形状，不需要一行字来解释。 */}
                <Square className="size-3 fill-current" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                /*
                 * 一个字没写、也没带引文和文件的时候按不动 —— 那时按下去本来就什么也不会
                 * 发生，而一颗按下去没反应的键会让人以为是坏了。
                 */
                disabled={busy || (text.trim().length === 0 && quoted.length === 0 && files.length === 0)}
                onClick={() => void ask(text)}
                aria-label="发送"
                title="发送"
                className="flex size-8 items-center justify-center rounded-full bg-ink text-paper transition-opacity duration-fast ease-swift hover:opacity-80 disabled:bg-neutral-wash disabled:text-ink-faint"
              >
                <ArrowUp className="size-4" aria-hidden />
              </button>
            )}
          </div>
        </div>
      </footer>
    </section>
  );
}

/** 走着的表。参谋还在说的时候，那行「耗时」是活的。 */
function Ticker({ from }: { from: number }) {
  const [now, setNow] = useState(() => Date.now());
  // 每问一轮换一次 `key`，这个组件整个重挂 —— 初值因此永远是这一轮的起点，
  // 不需要在 effect 里再同步一次 state。
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <p className="meta tabular-nums text-ink-faint">
      耗时 {formatDuration(Math.round(Math.max(0, now - from) / 1000))}
    </p>
  );
}

/**
 * 一轮。两侧的形状**故意不对称**。
 *
 * 他说的那句是右边一颗气泡：短、有边界、看得出是「插进来的一句话」。参谋答的那一段
 * 铺满整行，上面先写这一答花了多久，再压一条横线 —— 横线之下才是内容。
 *
 * 为什么耗时在最上面：他按下发送之后要等，等完看到的第一样东西应该是**这段等待的
 * 账单**。写在末尾等于事后解释，写在开头才是「它刚才在干这个」。
 */
function Bubble({
  message,
  onVerdict,
  onQuote,
}: {
  message: AdvisorMessage;
  /** 不给就不出现那两枚拇指（不落库那一档）。整段理由在 `TurnActions` 上。 */
  onVerdict?: (v: "up" | "down") => void;
  /** 深研浮窗里划一句话回输入框。只有带 `deepHandoff` 的那几轮用得到。 */
  onQuote: (text: string) => void;
}) {
  if (message.role === "user") {
    return (
      // `id` 是导航条的锚点。只标他问的那几轮 —— 他找东西永远以自己的问题为坐标。
      <div id={`turn-${message.id}`} className="animate-fade flex scroll-mt-4 flex-col items-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-neutral-wash px-3.5 py-2.5">
          {/* 和参谋那一段同一档。上一版他这一侧小一档（15 / 16），用来当「谁在说」的
              第二条线索 —— 而第一条（右对齐、有底色、有圆角的气泡）已经把这件事说尽了，
              一档字号在那之上什么也没多说，只让同一句话在输入框里和发出去之后不一样大。 */}
          <p className="talk text-md whitespace-pre-wrap text-ink">{message.text}</p>
        </div>
        {/* 跟着气泡靠右。**在气泡外面**：那颗气泡是「他说的话」这件事本身，把三枚
            操作图标放进去会让它们读起来像是他说的话的一部分。 */}
        <TurnActions
          text={message.text}
          verdict={message.verdict}
          onVerdict={onVerdict}
          className="mt-0.5 -mr-1.5"
        />
      </div>
    );
  }
  return (
    <div className="animate-fade">
      <p className="meta text-ink-faint">
        {message.elapsedMs === undefined
          ? `参谋 · ${formatStamp(message.at)}`
          : `耗时 ${formatDuration(Math.round(message.elapsedMs / 1000))}`}
      </p>
      <hr className="mt-1.5 border-0 border-t border-hairline" />
      <AgentText text={message.text} />
      {message.deepHandoff ? (
        <div className="mt-3">
          <DeepResearchCard
            issueId={message.deepHandoff.issueId}
            why={message.deepHandoff.why}
            onQuote={onQuote}
          />
        </div>
      ) : null}
      {/* 左对齐、贴着正文最后一行 —— 和那一段是同一块东西，不另起一条分隔。 */}
      <TurnActions
        text={message.text}
        verdict={message.verdict}
        onVerdict={onVerdict}
        className="mt-1 -ml-1.5"
      />
    </div>
  );
}

/**
 * 参谋说的话。
 *
 * 字是 `.talk` + `text-md`（15px，全栏唯一一档）—— 字族、字号两件事的取舍整段写在
 * globals.css 的 `.talk` 上。**改这里要连着改 `Bubble`、输入框和等待时那行小字**：
 * 那四处是同一句话的四个时刻，任何一处单独动，同一句话在屏幕上就会换一次大小。
 *
 * 「反问：」开头的那一段单独成块、counter 色。Advisor 的四种能力里 Challenge 是唯一
 * 一个可以被措辞悄悄糊掉的 —— 一段反问混在普通回复中间，读起来就只是「它话多」。
 * 挑战必须在版面上看得出来是挑战，不然这个产品和一个会附和的助手没有区别。
 *
 * **「反问：」两个字不上屏。** 版面已经把这一段和别的分开了（左边那道红杠、淡红底），
 * 再写一遍标签就是同一件事说两遍 —— 而且它会把读者的注意力从问题本身挪到分类上。
 * 标签留在数据里，它是这段文字的类型标记，不是要读的内容。
 */
export function AgentText({ text, typing = false }: { text: string; typing?: boolean }) {
  const segments = segment(text);
  return (
    <div className="mt-1 space-y-2.5">
      {segments.map((seg, i) => {
        const last = i === segments.length - 1;
        if (seg.kind === "challenge") {
          return (
            <p
              key={i}
              className="talk rounded-md border-l-2 border-counter bg-counter-wash px-3 py-2 text-md text-ink"
            >
              {/*
               * 光落在**里面这个 span** 上，不落在外面那个 `<p>` 上。
               *
               * `background-clip: text` 把这个元素的**每一层底**都裁成字的形状 ——
               * 底色也在内。落在 `<p>` 上的话，那块淡红的底会跟着被裁掉，屏幕上是
               * 一段没有底的反问；而它那块底正是「这一段是挑战」的全部说明。
               *
               * Markdown 那一路不用套这一层：它交出来的是一棵树，光落在树里最后那个
               * **文字块**上（`.streaming-flow-tail`，那条选择器把带底的块排除在外）。
               */}
              <span className={cn(typing && last && "streaming-flow")}>{seg.text}</span>
            </p>
          );
        }
        return <Markdown key={i} text={seg.text} flowing={typing && last} />;
      })}
    </div>
  );
}

/** 一段话里的一节：要么交给 Markdown 渲染，要么是一段挑战。 */
type Segment = { kind: "md" | "challenge"; text: string };

/**
 * 把一段话切成上面那两种。
 *
 * **相邻的普通段落要合回去。** 逐段各渲染一次 Markdown 的写法在这里是错的：
 * `1.` `2.` `3.` 三条之间只要空了一行就成了三个独立的列表，每一个都从 1 开始编号；
 * 围栏代码块里的空行同理，会被切成两半。所以只在遇到「反问」那一段时才断开，别的
 * 一律接回原样 —— 没有反问的那种（绝大多数）合回来就是原文一个字不差。
 */
function segment(text: string): Segment[] {
  const out: Segment[] = [];
  for (const para of text.split(/\n{2,}/)) {
    if (para.trim().length === 0) continue;
    if (/^反问[：:]/.test(para.trim())) {
      out.push({ kind: "challenge", text: para.trim().replace(/^反问[：:]\s*/, "") });
      continue;
    }
    const prev = out.at(-1);
    if (prev?.kind === "md") prev.text = `${prev.text}\n\n${para}`;
    else out.push({ kind: "md", text: para });
  }
  return out;
}
