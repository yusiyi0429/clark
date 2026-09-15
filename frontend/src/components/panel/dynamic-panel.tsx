"use client";

/*
 * 首页右栏：动态面板。这是 A–F 六组各自产出的唯一装配点，也是这块面板的**唯一状态
 * 持有者**——`panel-card.tsx` / `panel-sheet.tsx` / `panel-dock.tsx` 都是纯展示或者只管
 * 自己内部那一小段状态机（见各自文件头的说明），「现在开着哪一层 sheet」「球上方那句
 * 话说的是什么」「壁纸和时间」全部只在这一个文件里。
 *
 * 装配顺序照原型 `tianshu-dynamic-panel.html` 的 DOM 顺序（310-342 行）：
 * 壁纸（`.wp`）→ feed（hero + 两层卡片）→ backdrop → sheets → banner → dock。
 * 层叠顺序不是随手排的——`panel.module.css` 里这几层的 `z-index` 是按这个顺序涨上去的
 * （feed 1、backdrop 10、sheets 11、dock 30），DOM 顺序反过来写虽然不影响 `z-index`
 * 生效，但会让读代码的人以为顺序不重要，所以照抄。
 *
 * ## 四件不在跨组契约里、但漏一件就要debug 一下午的事
 *
 * 1. **`hasSheet`**：`panel.module.css` 把 backdrop 的显示和 feed 的虚化全部挂在
 *    `.panel.hasSheet` 这个复合选择器上。这个类名只在这个文件里出现，谁都不会替你切——
 *    忘了切，backdrop 永远 `display:none`，sheet 飘在一张完全没有虚化、还能正常点击的
 *    feed 上面，看起来像是「盖了一层但下面那层没反应」的 bug，其实是没挂类。
 * 2. **`in` / `recede`**：`PanelSheet` / `TranscriptSheet` 只认一个 `className`，滑入和
 *    「后退并消失」两段动画靠这个文件在恰当的时机把这两个类名拼上去（见 `renderSheet`
 *    和 `changeSheet`）。这两个组件自己不维护「谁在最上面」。
 * 3. **dock 的根节点**：`PanelDock` 在打字态渲染的是 `<div>`（因为里面还要塞一个真
 *    `<input>` 和真「发送」`<button>`，可交互元素不能嵌套可交互元素），闲置/语音两态是
 *    `<button>`。这个文件不对 dock 的 DOM 结构做任何假设，只通过它导出的 props 交互。
 * 4. **`issueId` 只在有 sheet 时才递，`readOnly` 每次都递**：`/api/chat` 拿到 `issueId`
 *    就会去装配一段公司上下文（`companyContextForChat`，与 `talkGate` 无关，独立生效）
 *    ——见 `handleSubmit`。他此刻在看哪一件 action item，说的话默认就是关于那一件的；
 *    没开 sheet 时不递，模型就只走公共的公司上下文，不会把上一件事的议题安到这一句
 *    无关的话上。**`readOnly: true` 是这个文件固定带上的一个额外字段**，作用是
 *    关掉 `issueId` 原本还会顺带打开的那一层更深的对话工具（现查证据、写判断状态、
 *    转异步／真出网检索）——那几个是「按下去会改数据」的动作，这块面板不该有
 *    （见文件头这一段之后 `handleSubmit` 里的说明）。两者不冲突：公司上下文照旧带，
 *    写工具收起来，是 `route.ts` 里 `talkGate` 那一格判断留的口子。
 *
 * ## caption / 回复里不许出现短码
 *
 * 本体的叙述接口（`src/lib/ontology/narrative.ts`）自己就不回 `ISS-xxx` 这类短码——它的
 * 对象是名字，不是编号。这个文件在 `handleSubmit` 里只是把用户打的字和模型吐回来的字
 * 原样接上屏幕，不会自己拼一个短码贴上去（卡片和 sheet 头上那个 `任务 · {issueId}`
 * 是 Task C 已经定的、给「这是哪一类」用的标签，跟这条禁令是两件事——那条针对的是**这个
 * 文件新增的**对话内容，不是既有卡片上早已认可的标识）。
 */

import {
  Fragment,
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { domainsOfSlot, slotLabel } from "@/lib/data/agenda";
import { readSse } from "@/lib/agent/sse";
import { api, ApiError } from "@/lib/data/client";
import type { ActionItem, DomainSummary, IssueSummary, MeetingSlot } from "@/lib/data/types";
import { useInvalidate, useResource } from "@/lib/use-resource";
import { PanelCard } from "./panel-card";
import { PanelDock } from "./panel-dock";
import { MeetingDetailSheet, PanelSheet, TranscriptSheet } from "./panel-sheet";
import styles from "./panel.module.css";

type Turn = { role: "user" | "agent"; text: string };
type Caption = { text: string; from: "user" | "agent" } | null;

/** sheet 退场有两种,分别对应"换成另一层"和"彻底关掉"——见 `changeSheet` 里的说明。 */
type Closing = { id: string; mode: "recede" | "slideOut" };

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/**
 * hero 顶部那一小行状态字。抽成纯函数是因为它以后还要多一档：会议进行中时应该换成
 * 一段计时和「会议进行中 · …」（规格 3.1 节），但这一版没有任何数据源能告诉这个组件
 * 「此刻是不是正在开会」——那要等相三把会议信号铺出来。所以这里先只有两档，将来接上
 * 第三档时，应该在这个函数最前面加一段「有没有正在进行的会议」的判断、命中就提前
 * `return` 那一档的文案，不要把判断散落到调用的地方——状态行的全部逻辑应该只在这一个
 * 函数里找得到。
 */
function heroStatusText(now: Date, lookingAt: string | null): string {
  if (lookingAt) return `正在看 ${lookingAt}`;
  return `${WEEKDAY_CN[now.getDay()]} ${now.getMonth() + 1}月${now.getDate()}日`;
}

/** 大号时间：24 小时制，`HH:MM`，不带秒——原型也不带,秒位对这一档信息没有意义。 */
function heroClockText(now: Date): string {
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** 空态 / 出错时那一句提示的公共样式：借用 `panel.module.css` 里 sheet 正文的 `.shP`
 *（字号、行高、玻璃字色都已经调好），这里只加一点居中和留白——不新起一个类名，因为
 * 这个文件不归 Task B（`panel.module.css`）管，不该为了一句提示语去改样式表。 */
const noticeStyle = { textAlign: "center" as const, padding: "56px 16px 0" };

/*
 * 下面那一组（归他执行的）与上面那一组（等他拍板的）之间的距离。
 *
 * 原型里两块 `.layer` 之间的空白**不是** `.layer` 自己撑的（它在原型的样式表里根本
 * 没有一条规则），撑开它的是每块开头那行 `.ll` 小标签自带的 `margin:16px 6px 8px`。
 * 这个项目当初搬样式表时就决定不要那行标签（`panel.module.css` 文件头第 27 行写了
 * 这件事），于是那段空白连同标签一起没了——两组卡片会紧挨着，间距和组内两张卡之间
 * 的 10px 一模一样，等于没分组。所以这道缝得由这里自己给。
 *
 * 30px 是照原型那块标签量的：上一张卡到标签 16px（这一段和卡片自己的
 * `margin-bottom:10px` 相邻，取大的那个，是 16 不是 26）、标签那行 11px 的字约占
 * 13px、标签到下一张卡 8px，合计 37px，其中真正空着的是 24px。这里没有标签占位，
 * 空白要独自把 37px 那段间隔演出来，取在 24 和 37 之间。
 *
 * **这 30px 不会和上一张卡的 10px 叠成 40px**：组容器没有 padding 也没有 border，
 * 末张卡的下外边距会穿过容器底边和这里的上外边距合并，取大的那个——所以看到的缝
 * 就是 30px。曾经按"37 减去卡片自己的 10"去凑过 26，那道减法的前提是两个外边距会
 * 相加，而它们不相加，结果只是把缝调窄了 4px 而已。
 *
 * 数值本身不神圣，要紧的是它必须明显宽于组内那 10px：不写标签的前提就是"组间的缝
 * 一眼看上去不像组内的缝"，缝一窄，分组就退化成一堆卡片里毫无理由的一处空白。
 *
 * 走内联样式而不是新起一个类名，理由同上面的 `noticeStyle`——`panel.module.css`
 * 不归这个文件管，不该为了一个间距去改别人的样式表。
 */
const laterGroupStyle = { marginTop: 30 };

/** 一号位那侧会议卡点开之后，外面（`HomeView`）用它把 slotId 递给这块面板。 */
export type DynamicPanelHandle = { openMeeting: (slotId: string) => void };

const MEETING_PREFIX = "meeting:";
const meetingSheetId = (slotId: string) => `${MEETING_PREFIX}${slotId}`;
const slotIdOfSheet = (id: string): string | null =>
  id.startsWith(MEETING_PREFIX) ? id.slice(MEETING_PREFIX.length) : null;

export const DynamicPanel = forwardRef<DynamicPanelHandle>(function DynamicPanel(_props, ref) {
  const itemsRes = useResource<ActionItem[]>("action-items", () => api.listActionItems());
  /* `?? []` 每次渲染都会新造一个空数组，而这份清单是下面 `findItem` 这个 `useCallback`
     的依赖——不裹一层 `useMemo` 的话，取数还没回来的那段时间里每一次渲染都会让它换
     一个新身份，等于白记忆化一场。这也是 eslint 的 `react-hooks/exhaustive-deps` 在
     这一行上报的那条提醒。 */
  const items = useMemo(() => itemsRes.data ?? [], [itemsRes.data]);

  const [sheet, setSheet] = useState<string | null>(null);
  const [closing, setClosing] = useState<Closing | null>(null);
  const [entered, setEntered] = useState(false);
  const [now, setNow] = useState<Date>(() => new Date());
  const [turns, setTurns] = useState<Turn[]>([]);
  const [caption, setCaption] = useState<Caption>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<ActionItem | null>(null);
  const [bannerIn, setBannerIn] = useState(false);
  /** 决策卡「确认」正在飞的那几条——按钮换文案、挡重复点击。 */
  const [confirmingIds, setConfirmingIds] = useState<Set<string>>(new Set());
  /** 「确认」失败时贴哪条、说什么。 */
  const [confirmError, setConfirmError] = useState<{ id: string; message: string } | null>(null);
  /**
   * 点了「修改」、还没被消费掉的那一件——sheet 打开时读它决定要不要直接进编辑态。
   * 只消费一次：`sheet` 一旦挪去了别处就把它清掉（同 `enteredFor` 那一对的写法——
   * 在渲染期间直接比对重置，不放进 effect，理由见那边的注释），免得同一件事以后被
   * 单纯点开卡片重新打开时，也一并被拽进编辑态。
   */
  const [editIntentId, setEditIntentId] = useState<string | null>(null);
  if (editIntentId !== null && sheet !== editIntentId) setEditIntentId(null);
  const invalidate = useInvalidate();

  /* 统一记一份「这个组件还挂着的全部 setTimeout」，卸载时一次性清掉——sheet 退场、
     「在想…」揭晓、横幅自动收回三处都要用得到，分开各写一份卸载清理容易漏一处。
     用裸的 `setTimeout`/`clearTimeout`（不是 `window.setTimeout`）——`@types/node` 和
     DOM 库的全局 `setTimeout` 声明会叠在一起，`window.setTimeout` 这条路径在这份
     tsconfig 下推出来的返回类型和实际调用点对不上（`ReturnType<typeof window.setTimeout>`
     解出 `NodeJS.Timeout`，而调用 `window.setTimeout(...)` 本身解出 `number`），编译过
     不了。仓库里其余管定时器的地方（如 `src/lib/stage/speaker.ts`）一律用裸的写法，
     两端口径一致，照抄即可。 */
  const timeouts = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const schedule = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timeouts.current.delete(id);
      fn();
    }, ms);
    timeouts.current.add(id);
    return id;
  }, []);
  useEffect(
    () => () => {
      timeouts.current.forEach((id) => clearTimeout(id));
      timeouts.current.clear();
    },
    [],
  );

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  /*
   * 只有一层 sheet：`changeSheet` 是这个文件里唯一改 `sheet` 的地方。
   *
   * 退场分两种,原型上是两段不同的动画：
   *   recede    —— 换成另一层时,旧的一边缩小一边淡出,同时新的从底部滑上来（两个 DOM
   *                节点在这 420ms 里同时挂着）。
   *   slideOut  —— 彻底关掉时,旧的只是被摘掉 `in`,退回 `panel.module.css` 里 `.sheet`
   *                的基础位置（屏幕外),没有新的要进来。
   * 两段动画对应的都是「移除 `in`」这同一件事,区别只在要不要额外叠一个 `recede`——
   * 所以这里没有为「关闭」单独定义第三个类名,复用的是 B 组已经给出的两个。
   *
   * 已知的简化：连着快速点过好几张卡（间隔小于 420ms）时，上一张还没退完场就被下一次
   * 调用顶掉——`closing` 只有一个槽位，不排队。验收单上测的是"点一下另一张"这个单次
   * 动作，这版够用；真要连点连出队列效果，代价是把 `closing` 从一个值改成一个数组。
   */
  const changeSheet = useCallback(
    (next: string | null) => {
      setSheet((current) => {
        if (current === next) return current;

        if (current !== null) {
          const closingId = current;
          const mode: Closing["mode"] = next === null ? "slideOut" : "recede";
          setClosing({ id: closingId, mode });
          schedule(() => {
            setClosing((c) => (c && c.id === closingId ? null : c));
          }, 420);
        }

        return next;
      });
    },
    [schedule],
  );

  useImperativeHandle(ref, () => ({ openMeeting: (slotId) => changeSheet(meetingSheetId(slotId)) }), [
    changeSheet,
  ]);

  /*
   * 一件 action item 此刻能从两处来：`items`（`listActionItems()` 取回来的那份），
   * 或者 `banner`（开发环境手动喂的那一条，见下面 `showBanner` 的说明）。banner 喂的
   * 那条不保证已经在 `items` 里——它就是拿来验证横幅机制的，不是真的等它被取数口
   * 收录。原来这里只认 `items`，后果是点开一张手动喂的横幅卡片，`sheet` 状态确实被
   * 设成了它的 id，但 `renderSheet` 找不到对应的 item 就返回 `null`：`hasSheet` 为真，
   * 背板压下来、feed 虚化，却没有一张 sheet 冒出来——不是卡死（Esc、点背板都还关得掉），
   * 但验证这条机制的人会看到一个自己搞不懂的空态。
   */
  const findItem = useCallback(
    (id: string): ActionItem | undefined => items.find((i) => i.id === id) ?? (banner?.id === id ? banner : undefined),
    [items, banner],
  );

  /*
   * 「先归零、下一帧再补 `in`」这半步不能放在下面那个 effect 里同步调
   * `setEntered(false)`——那是 `sheet` 每次变化都会连带触发的第二次 setState，
   * 新版 react-hooks 的 `set-state-in-effect` 规则不建议这么写（连锁渲染，且这类
   * 「依赖变了就把另一个 state 重置」的事，React 自己的文档也是建议在渲染期间
   * 直接比对旧值来做，不必等 effect 跑一轮）。所以这里换成「记一份`entered`是为
   * 哪一层 sheet 播的」，渲染时发现对不上就地重置——这一步不出现在 effect 里，
   * 而是每次渲染都会做的比较，React 允许在渲染函数体内这样调用 setState（会在
   * 提交前再渲一轮，不会被用户看到中间态）。
   */
  const [enteredFor, setEnteredFor] = useState<string | null>(null);
  if (sheet !== enteredFor) {
    setEnteredFor(sheet);
    setEntered(false);
  }

  /* 新进的那一层要「先摆在屏幕外的基础位置,下一帧再补上 `in`」才会有滑入动画——同一次
     渲染里直接带着 `in` 出生的话,浏览器看到的是"从一开始就在原地",没有可过渡的起点。
     双重 `requestAnimationFrame` 是让第一帧的"基础位置"先真正上屏一次。这个 effect
     现在只管「两帧之后翻成 in」这一半，「先归零」的那一半已经挪到上面渲染期间做了。 */
  useEffect(() => {
    if (sheet === null) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [sheet]);

  /* Esc 关 sheet。全局监听，不挂在某个 DOM 节点上——sheet 打开时焦点可能停在 feed 的
     任何一张卡上，甚至停在 dock 的输入框里（这种时候 `PanelDock` 自己会先处理 Esc、
     把输入框收起来，这个全局监听器同一次按键里也会把 sheet 关掉——两件事赶在一起是
     一个接受的简化：dock 的 `mode` 是它自己的私有状态，按跨组契约不对外暴露，这个文件
     没有办法只在"没在打字"时才响应 Esc）。用 ref 存最新的 `changeSheet`，监听器本身
     只挂一次，不必随 `sheet` 变化整个重新订阅。这个 ref 在渲染期间不能直接赋值
     （新版 react-hooks 的规则不许在渲染函数体内改 ref——并发渲染下同一次渲染可能
     被跑不止一遍，读写 ref 这类外部可变状态必须放进 effect），所以改成一个没有
     依赖数组、每次渲染后都跑一遍的 effect，专门负责把 ref 同步到最新的
     `changeSheet`。 */
  const changeSheetRef = useRef(changeSheet);
  useEffect(() => {
    changeSheetRef.current = changeSheet;
  });
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") changeSheetRef.current(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const activeItem =
    sheet !== null && sheet !== "transcript" && slotIdOfSheet(sheet) === null
      ? (findItem(sheet) ?? null)
      : null;

  /* 会议 sheet 只要一个人话标签，不必等 `MeetingSheetContainer` 把判断和要点都取回来——
     那份重活它自己去做（见下面 `renderSheet`）。这里只借 `slots` 那份缓存（多处已经在
     用同一个 key，SWR 会去重），面板开着的时候 hero 顶上那句「正在看 X」才答得出来。 */
  const slotsForLabelRes = useResource<MeetingSlot[]>("slots", () => api.listSlots());
  const openMeetingSlotId = sheet ? slotIdOfSheet(sheet) : null;
  const openMeetingSlot = openMeetingSlotId
    ? (slotsForLabelRes.data ?? []).find((s) => s.id === openMeetingSlotId)
    : undefined;

  function appendAgentTurn(text: string) {
    setTurns((t) => [...t, { role: "agent", text }]);
    setCaption({ text, from: "agent" });
  }

  /**
   * 文字提交，接现有 `/api/chat`——照 `chat-pane.tsx` 里手动模式那一条路的调法：
   * 同一个 `mode:"manual"`、同一个 `readSse` 解析，只是这里的历史是 `turns`（面板自己的
   * 对话记录）不是 advisor 那一栏的 `opened`。`context` 只在有 `activeItem` 时才取——
   * `api.advisorContext` 是按议题装配证据与判断的，没有议题时问它等于问一个没有答案的
   * 问题；不递这个字段，服务端会退到它自己那句诚实的占位（"没有拿到上下文"），比这里
   * 编一个空字符串更清楚。
   *
   * **这里固定带 `readOnly: true`，别的调用方（`chat-pane.tsx`）不带。** 这块面板长在
   * 一号位首页右栏，是一块锁屏式的玻璃卡片，规格把「一颗按下去会改数据的键不该先长
   * 出来」写死在这一相的 Global Constraints 里（`panel-card.tsx`/`panel.module.css` 那句
   * 注释）。但 `issueId` 一旦递上去，`route.ts` 原本会顺带打开议事对话层 v2 的四个
   * 工具——`propose_point_update` 会写一条判断状态，`micro_research` 会真的出网检索
   * 并把结果落进证据台账，`escalate` 记一次转手，三个都是写。一号位在这块卡片上打一句
   * 「这条什么时候要」，不该悄悄写议题台账或者花一次检索的钱。`readOnly: true` 关掉的
   * 正是这一层——`route.ts` 里 `talkGate` 那一格会看到这个字段就退回旧路的纯问答，
   * 公司上下文（`companyContextForChat`）不受影响，因为它的注入只看 `issueId`，
   * 在 `talkGate` 判断之前就已经装好了。
   */
  async function handleSubmit(text: string) {
    const userTurn: Turn = { role: "user", text };
    const issueId = activeItem?.issueId;
    const historyForRequest = [...turns, userTurn];

    setTurns((t) => [...t, userTurn]);
    setCaption({ text, from: "user" });
    setBusy(true);
    try {
      const context = issueId ? await api.advisorContext(issueId).catch(() => null) : null;
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "manual",
          readOnly: true,
          ...(context ? { context } : {}),
          ...(issueId ? { issueId } : {}),
          messages: historyForRequest.map((t) => ({
            role: t.role === "agent" ? "assistant" : "user",
            content: t.text,
          })),
        }),
      });

      if (!res.ok || !res.body) {
        const detail = (await res.json().catch(() => null)) as { error?: string } | null;
        appendAgentTurn(detail?.error ?? `模型拒了这次请求（HTTP ${res.status}）。`);
        return;
      }

      let reply = "";
      for await (const frame of readSse(res.body)) {
        if (frame.event === "text") {
          reply += JSON.parse(frame.data) as string;
          setCaption({ text: reply, from: "agent" });
        } else if (frame.event === "step") {
          /*
           * 服务端在真正开口之前会先报「此刻在做什么」（`route.ts` 的 `event: step`，
           * 例如「正在去外面查证」）——但这个调用方固定带 `readOnly: true`，那一路
           * 的工具已经在服务端被收起来了，实际上不会再收到这一帧。这里仍然接住它，
           * 一是这份 SSE 是几处调用方共用的契约（同一份帧格式喂 `chat-pane.tsx`），
           * 漏掉一种事件类型会让下一个读这份代码的人以为这条流只有 text/error 两种；
           * 二是防将来这个入口的只读口径改了、又重新收到 step 帧时，气泡莫名其妙
           * 停在他自己那句话上一动不动——同一颗气泡顶上这句话，等第一个 `text` 帧
           * 一到，上面那个分支会把它换成真正的回复。
           */
          setCaption({ text: JSON.parse(frame.data) as string, from: "agent" });
        } else if (frame.event === "error") {
          const why = JSON.parse(frame.data) as string;
          if (!reply) {
            appendAgentTurn(why);
            return;
          }
        }
      }
      if (reply.trim().length > 0) {
        setTurns((t) => [...t, { role: "agent", text: reply }]);
      }
    } catch {
      appendAgentTurn("没连上模型。");
    } finally {
      setBusy(false);
    }
  }

  /*
   * 横幅：实时层新卡片在 sheet 打开时压下来的机制（规格 3.1「横幅」）。这一版的
   * `listActionItems` 是一次性拉取，没有推送，压根不存在"面板开着的时候又来了一条新的"
   * 这种事——所以这里只搭机制，不接真实触发源。开发环境里把它挂到 `window` 上，方便
   * 手动喂一个 `ActionItem` 验证滑入/自动收回/点击效果；接上真实推送（比如秘书那侧
   * 标了一条紧急待办）之后，把调用点从这个调试挂载换成那个事件的回调，机制本身
   * （这个函数和下面的渲染）都不用再动。
   */
  /* 上一次喂横幅时排的那个"6.5 秒后收回"，用来在下一次喂横幅时先取消——原型的
     `showBanner` 也是这么做的（`clearTimeout(b._t)`）。没有这一步，两次喂横幅间隔
     短于 6.5 秒时，第一次排的那个定时器还在飞，会把第二条横幅提前收走：喂普通横幅
     A，5 秒后又喂 B，B 会在露出 1.5 秒后就被 A 那个迟到的定时器关掉。 */
  const bannerHideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showBanner = useCallback(
    (item: ActionItem) => {
      setBanner(item);
      requestAnimationFrame(() => setBannerIn(true));
      if (bannerHideTimeout.current !== null) {
        clearTimeout(bannerHideTimeout.current);
        timeouts.current.delete(bannerHideTimeout.current);
      }
      bannerHideTimeout.current = schedule(() => {
        bannerHideTimeout.current = null;
        setBannerIn(false);
      }, 6500);
    },
    [schedule],
  );
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const g = globalThis as typeof globalThis & {
      __tkosShowPanelBanner?: (item: ActionItem) => void;
    };
    g.__tkosShowPanelBanner = showBanner;
    return () => {
      delete g.__tkosShowPanelBanner;
    };
  }, [showBanner]);

  function handleBannerOpen() {
    setBannerIn(false);
    const target = banner;
    if (!target) return;
    changeSheet(null);
    schedule(() => changeSheet(target.id), 200);
  }

  /**
   * 决策卡的「确认」。直接从卡片上打，不必先开 sheet——一号位在清单上就该能定这一条。
   * 成功之后重问一次 `action-items`：`confirmDebriefTodo` 落的是 `decidedAt`，这件事
   * 要从「等他拍板」那组退出去，不重问一次它会停在原地不动，看起来像是白点了一下。
   */
  async function handleConfirmDecision(item: ActionItem) {
    if (confirmingIds.has(item.id)) return;
    setConfirmError(null);
    setConfirmingIds((s) => new Set(s).add(item.id));
    try {
      await api.confirmDebriefTodo(item.slotId, item.issueId, item.id);
      invalidate("action-items");
    } catch (e) {
      setConfirmError({ id: item.id, message: e instanceof ApiError ? e.message : "确认没有成功，请再试一次。" });
    } finally {
      setConfirmingIds((s) => {
        const next = new Set(s);
        next.delete(item.id);
        return next;
      });
    }
  }

  /** 决策卡的「修改」——把这件事的 sheet 直接打开到编辑态，改字在那边发生（见 `PanelSheet`）。 */
  function handleEditDecision(item: ActionItem) {
    setEditIntentId(item.id);
    changeSheet(item.id);
  }

  /** `PanelSheet` 编辑框的「保存」落到这里——写完之后一样要重问 `action-items`：
   *  措辞变了，卡面上那句摘要也在读这同一份文字。 */
  async function handleSaveDecisionText(item: ActionItem, text: string) {
    await api.updateDebriefTodoText(item.slotId, item.issueId, item.id, text);
    invalidate("action-items");
  }

  function renderSheet(id: string, cls: string | undefined) {
    if (id === "transcript") {
      return (
        <TranscriptSheet key="transcript" turns={turns} onClose={() => changeSheet(null)} className={cls} />
      );
    }
    const slotId = slotIdOfSheet(id);
    if (slotId !== null) {
      return (
        <MeetingSheetContainer
          key={id}
          slotId={slotId}
          onClose={() => changeSheet(null)}
          className={cls}
        />
      );
    }
    const item = findItem(id);
    if (!item) return null;
    return (
      <PanelSheet
        key={id}
        item={item}
        judgement={item.principal.reason}
        onClose={() => {
          if (editIntentId === id) setEditIntentId(null);
          changeSheet(null);
        }}
        className={cls}
        initialEditing={editIntentId === id}
        onSaveText={item.principal.needed ? (text) => handleSaveDecisionText(item, text) : undefined}
      />
    );
  }

  /*
   * feed 分两组：等他拍板的在上，归他执行的在下。
   *
   * 判据整条都在读口那边（`principal.needed`），这里一个字都不重判——包括兜底：
   * 判断缺失或者解析不出来时读口给的是 `{ needed: true, ... }`，也就是**拿不准的一律
   * 冒到上面这一组**。所以上面这组只会多、不会漏，而"多一条"和"少一条"在这块屏幕上
   * 完全不对等：多给他一条是他多看一眼，少给他一条是一件该他定的事无声无息地没了。
   * 真要在这里补一道"看起来不像决定就往下压"的兜底，压掉的正好是判不出来的那些，
   * 等于把读口特意留的这条命脉反过来剪掉。
   *
   * 用两次 filter 而不是一趟遍历分堆：filter 天然保序，组内还是取数口给的那个顺序
   * （`listActionItems()` 的排序是这个面板唯一的排序依据，这里只做分堆，不重排——
   * 原型那条「feed 从不重排」也是这个意思）。清单是他一个人的会后待办，几条到十几条，
   * 走两趟的代价可以忽略，不值得为它包一层 `useMemo`：这两个值只在下面的 JSX 里用到，
   * 不进任何 hook 的依赖数组，记忆化换不来任何东西，只多一条要维护的依赖。
   *
   * `decidedAt` 有值的也落进 `toCarry`：他已经拍过板了，这条从「等他拍板」退出去，
   * 变成一件该被执行的事——跟这一组里其余靠 `assignedTo` 落进来的执行项是同一件事。
   */
  const toDecide = items.filter((i) => i.principal.needed && !i.decidedAt);
  const toCarry = items.filter((i) => !i.principal.needed || i.decidedAt);

  const hasSheet = sheet !== null;
  /*
   * 这一行曾经在看一件决策时递 `issueId`（「正在看 ISS-xxx」）。一号位当面撤了
   * 这个设计，而且这里不合适再把它接回来：待办的全文长短不可控（见 `panel.module.css`
   * 里 `.heroStatus` 那条截断兜底），塞进这一行只会被截成半句话，读起来比不提还糟。
   * 默认仍然不提议题/mission，看一件决策时这一行就回落到日期，不额外递东西。
   */
  const lookingAt =
    sheet === "transcript"
      ? "对话记录"
      : openMeetingSlotId
        ? (openMeetingSlot ? slotLabel(openMeetingSlot, api.today) : "这场会")
        : null;

  return (
    <section className={hasSheet ? `${styles.panel} ${styles.hasSheet}` : styles.panel}>
      <div className={styles.wp} aria-hidden="true">
        <i className={styles.b1} />
        <i className={styles.b2} />
        <i className={styles.b3} />
        <i className={styles.b4} />
      </div>

      <div className={styles.feed}>
        <div className={styles.hero}>
          <div className={styles.heroStatus}>{heroStatusText(now, lookingAt)}</div>
          <div className={styles.heroClock}>{heroClockText(now)}</div>
        </div>
        <div className={styles.layers}>
          {/*
           * 两组之间**没有标签**，只有一段空白。这不是还没做，是跟一号位当面定下来的。
           *
           * 屏幕上摆的全是他自己的东西：上面那组等他表态，下面那组等他去做，哪一组是
           * 哪一组，他扫一眼卡片正文就知道。在上面压一行「要你拍板」的小字，是在替他
           * 复述一件他已经知道的事——原型那三行 `.ll`（实时 / 待处理 / 参考）本来就是
           * 给第一次看 demo 的人认路用的，不是给天天住在这块屏幕里的人用的，所以搬样式表
           * 那一步就没搬 `.ll`（`panel.module.css` 文件头第 27 行）。
           *
           * 代价说在明处：光靠空白，看得出"这里断了一下"，看不出"断开的两边各是什么"。
           * 承担这件事的是另外两样——位置（等他拍板的那组永远紧贴着大号时间，是他睁眼
           * 第一个看见的地方），和点开之后 sheet 里那句判断理由（`PanelSheet` 的
           * `judgement` 那一节）。这是知情之后接受的代价。往后谁觉得"还是不够清楚"，
           * 要补的是那两样里的一样，不是把标签加回来。
           *
           * 空的那一组连容器都不画：一段本该有间距、里面却什么都没有的空白，只会让人
           * 怀疑"这里是不是该有什么没加载出来"。同理，上面那组空掉时下面那组不带那 30px
           * 上边距——那道缝是用来分隔两组的，只剩一组时它分隔的是时间和第一张卡，凭空
           * 把 feed 往下推一截。
           *
           * 两组都空的情况不走这里：它等价于 `items` 为空，由下面那句空态兜住。
           */}
          {itemsRes.error ? (
            <p className={styles.shP} style={noticeStyle}>
              {itemsRes.error instanceof ApiError ? itemsRes.error.message : "这一步没有取到结果。"}
            </p>
          ) : items.length === 0 ? (
            // 空着不说话——原来这里有一句「会后归你的事会落到这里」，一号位要它别说。
            // `<p>` 留着（不是整段删掉）：它的 padding 撑开的那段留白是空态该有的样子，
            // 删了元素本身，这块面板顶上就会跟着往上跳一截。
            <p className={styles.shP} style={noticeStyle} />
          ) : (
            <>
              {toDecide.length > 0 ? (
                <div>
                  {toDecide.map((item) => (
                    <Fragment key={item.id}>
                      <PanelCard
                        item={item}
                        onOpen={changeSheet}
                        onConfirm={(i) => void handleConfirmDecision(i)}
                        onEdit={handleEditDecision}
                        confirming={confirmingIds.has(item.id)}
                      />
                      {confirmError?.id === item.id ? (
                        <p className={styles.shEditError}>{confirmError.message}</p>
                      ) : null}
                    </Fragment>
                  ))}
                </div>
              ) : null}
              {toCarry.length > 0 ? (
                <div style={toDecide.length > 0 ? laterGroupStyle : undefined}>
                  {toCarry.map((item) => (
                    <PanelCard key={item.id} item={item} onOpen={changeSheet} />
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* 纯粹的点击捕获层：`hasSheet` 时铺满整块面板，负责"点 sheet 之外的任何地方
          （包括顶上露出来的那条 feed）都关掉当前 sheet"。没有可见样式，键盘用户走
          Esc（上面那个全局监听器），所以这里不需要、也不该做成一个可聚焦的控件——
          给一块看不见、覆盖全屏又什么都不显示的东西一个 tab 停靠点，对读屏用户只有
          坏处没有好处。 */}
      <div
        className={styles.backdrop}
        aria-hidden="true"
        onClick={() => changeSheet(null)}
      />

      <div className={styles.sheets}>
        {closing ? renderSheet(closing.id, closing.mode === "recede" ? styles.recede : undefined) : null}
        {sheet !== null ? renderSheet(sheet, entered ? styles.in : undefined) : null}
      </div>

      <div className={bannerIn ? `${styles.banner} ${styles.in}` : styles.banner}>
        {banner ? <PanelCard item={banner} onOpen={handleBannerOpen} /> : null}
      </div>

      <PanelDock
        caption={caption}
        busy={busy}
        onSubmit={(text) => void handleSubmit(text)}
        onOpenTranscript={() => changeSheet("transcript")}
      />
    </section>
  );
});

/**
 * 一号位点开的那场会 —— sheet 里装的两件事：他已经确认过的判断，和 Agent 还没请他
 * 确认、认为这场会要谈的判断。两样都是判断板本身的两层（`api.getBoard` 的
 * `confirmed` / `draft`），跟 `MeetingLiveView.IssueJudgments` 读的是同一份数据、
 * 同一条口径——那一页已经把「未确认的也要摆出来，只是说清它还没经过您」定成了先例。
 *
 * `getMeetingPrep` 没有用在这里：它按业务域取一条排会记录（`Meeting`），而这条排会
 * 流程（`scheduleIssue`/`MeetingSlot`）不写这张表——真去问它，绝大多数域会直接撞上
 * 「这个域还没有排会」。判断板不依赖这张表，是这两件事此刻唯一答得出来的数据源。
 */
function MeetingSheetContainer({
  slotId,
  onClose,
  className,
}: {
  slotId: string;
  onClose: () => void;
  className?: string;
}) {
  const data = useMeetingSheetData(slotId);
  if (!data) return null; // 这场会没了（比如刚被撤掉）——没有东西可显示。

  return (
    <MeetingDetailSheet
      slotLabel={data.slotLabel}
      attending={data.attending}
      issueCount={data.issueCount}
      confirmed={data.confirmed}
      keyPoints={data.draft}
      loading={data.loading}
      onClose={onClose}
      className={className}
    />
  );
}

type MeetingSheetJudgement = {
  issueId: string;
  issueTitle: string;
  label?: string;
  statement: string;
};

function useMeetingSheetData(slotId: string): {
  slotLabel: string;
  attending: string[];
  issueCount: number;
  confirmed: MeetingSheetJudgement[];
  draft: MeetingSheetJudgement[];
  loading: boolean;
} | null {
  const slotsRes = useResource<MeetingSlot[]>("slots", () => api.listSlots());
  const issuesRes = useResource<IssueSummary[]>("issues", () => api.listIssues());
  const domainsRes = useResource<DomainSummary[]>("domains", () => api.listDomains());

  const slot = (slotsRes.data ?? []).find((s) => s.id === slotId) ?? null;
  const byId = new Map((issuesRes.data ?? []).map((i) => [i.id, i] as const));
  const issues = (slot?.issueIds ?? []).map((id) => byId.get(id)).filter(Boolean) as IssueSummary[];
  const issueIds = issues.map((i) => i.id).join(",");

  const [detail, setDetail] = useState<{
    confirmed: MeetingSheetJudgement[];
    draft: MeetingSheetJudgement[];
  } | null>(null);
  // 换了一场会（`issueIds` 变了）就把上一场的结果先归零——这一步放在渲染期间做，
  // 不放进下面那个 effect（同这个文件里 `enteredFor` 那一对的理由：在 effect 里
  // 同步 setState 会被 `react-hooks/set-state-in-effect` 拦下）。
  const [detailFor, setDetailFor] = useState<string | null>(null);
  if (issueIds !== detailFor) {
    setDetailFor(issueIds);
    setDetail(null);
  }

  useEffect(() => {
    if (!issueIds) return;
    let alive = true;
    void Promise.all(
      issues.map(async (issue) => ({
        issue,
        board: await api.getBoard(issue.id).catch(() => null),
      })),
    ).then((rows) => {
      if (!alive) return;
      const pick = (layer: "confirmed" | "draft"): MeetingSheetJudgement[] =>
        rows.flatMap(({ issue, board }) =>
          (board?.[layer] ?? []).map((j) => ({
            issueId: issue.id,
            issueTitle: issue.title,
            label: j.label,
            statement: j.statement,
          })),
        );
      setDetail({ confirmed: pick("confirmed"), draft: pick("draft") });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueIds]);

  if (!slot) return null;
  const domainName = (id: string) => domainsRes.data?.find((d) => d.id === id)?.name ?? id;

  return {
    slotLabel: slotLabel(slot, api.today),
    attending: domainsOfSlot(slot, (id) => byId.get(id)?.domainId).map(domainName),
    issueCount: issues.length,
    confirmed: detail?.confirmed ?? [],
    draft: detail?.draft ?? [],
    loading: detail === null,
  };
}
