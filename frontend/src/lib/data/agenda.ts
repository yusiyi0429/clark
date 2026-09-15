/**
 * 排会的纯逻辑。**不碰对象库** —— 所以它两侧都能 import，也能单独跑测试。
 *
 * 判据同 `shared.ts` 那条：依赖 store 的进 store.ts，不依赖的进这里。屏幕上要把
 * 「明天上午」这行字写出来、要给同一场会挑同一个颜色、要算出这场会有哪几个域到场 ——
 * 这几件事服务端和浏览器都要做一遍，只能有一处定义。
 *
 * ## 这个文件里唯一重要的一条
 *
 * **一场会的身份就是「哪一天的哪半天」。** `slotIdOf` 由日期和上午/下午拼出 id，于是
 * 「两件议题排在同一格」和「两件议题在同一场会上」在数据层是同一句话，不需要第二个概念
 * 去把它们绑起来。屏幕上那个聚类因此不是一种画法，它是这条规则的投影。
 *
 * ## 为什么粒度只到上午 / 下午
 *
 * 上一版是「几点到几点」，选完还要挑时长。真正拿来用的时候会发现：一号位在这一屏上做的
 * 决定是**「这件事排在哪一天的哪一段」**，几点开始是助理后面才落实的事。让他在排十件
 * 议题的时候连做十次「14:00 还是 14:30」的选择，是把一个不属于这一屏的决定塞了进来。
 *
 * 粒度降下来之后有一个连带后果，而它恰好是对的：**时钟不再能回答「散会了没有」**。
 * 所以那件事改由一个人按下去的动作说（`MeetingSlot.endedAt`），而不是到点自己翻的位。
 */

import type { DayHalf, IssueSlot, MeetingSlot } from "./types";

/* -------------------------------------------------------------------------- */
/* 一天的两格                                                                  */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM-DD`。 */
const YMD = /^\d{4}-\d{2}-\d{2}$/;

export const isYmd = (v: string): boolean => YMD.test(v);
export const isHalf = (v: string): v is DayHalf => v === "am" || v === "pm";

export const HALVES: readonly DayHalf[] = ["am", "pm"] as const;

/** 排序用：上午在下午前面。 */
const halfOrder = (half: DayHalf): number => (half === "am" ? 0 : 1);

/**
 * 这一格能不能用。能用返回 `null`，不能用返回**一句可以直接上屏的话**。
 *
 * 返回话而不是抛异常：调用它的既有服务端（拒掉这次写）也有屏幕（这一格能不能落），
 * 而后者不该为了问一句「行不行」去接一个异常。
 */
export const slotTimeError = (date: string, half: string): string | null => {
  if (!isYmd(date)) return "日期格式不对。";
  if (!isHalf(half)) return "只能排在上午或下午。";
  return null;
};

/**
 * 一场会的 id。**由日期和半天生成，所以同一格只可能有一条。**
 *
 * 这就是聚类的全部实现：`scheduleIssue` 拿到日期和半天先算 id，库里有就往里加一件，
 * 没有就建一条。不需要「合并两场会」这种操作，也就不会有「看起来是同一场、其实是两条」。
 */
export const slotIdOf = (date: string, half: DayHalf): string =>
  `MS-${date.replace(/-/g, "")}-${half}`;

/** 会后提炼那张表的键。一场会一件议题一份。 */
export const debriefKeyOf = (slotId: string, issueId: string): string =>
  `${slotId}::${issueId}`;

/** 排序用的可比串：先日期后半天。 */
export const slotOrderKey = (s: Pick<MeetingSlot, "date" | "half">): string =>
  `${s.date}-${halfOrder(s.half)}`;

/** 按时间先后。同一格不可能有两场（id 由它生成），所以不需要第二排序键。 */
export const bySlotTime = (
  a: Pick<MeetingSlot, "date" | "half">,
  b: Pick<MeetingSlot, "date" | "half">,
): number => slotOrderKey(a).localeCompare(slotOrderKey(b));

/* -------------------------------------------------------------------------- */
/* 这一格过去了没有                                                            */
/* -------------------------------------------------------------------------- */

/** 上午到几点为止、下午到几点为止。只用来判断「这一格已经过去了」，不用来判散会。 */
const HALF_ENDS_AT: Record<DayHalf, number> = { am: 12 * 60, pm: 18 * 60 };

/**
 * 此刻，按北京时间算。**这是全站唯一读墙上时钟的地方。**
 *
 * 它原来只在 `components/agenda/clock.ts` 里 —— 那个文件是 `"use client"`，数据层进不去。
 * 于是「这场会过去了没有」在两侧各算一遍是迟早的事，而两份实现只要差一分钟的取整，
 * 屏幕上就会出现「这一栏说它过去了、那一栏说还没有」，两栏都不报错。
 */
export type Clock = { day: string; minutes: number };

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const hmFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
});

export const readClock = (): Clock => {
  const now = new Date();
  const [h, m] = hmFmt.format(now).split(":");
  return { day: dayFmt.format(now), minutes: Number(h) * 60 + Number(m) };
};

/**
 * 这一格在墙上的时间里过去了没有。
 *
 * ## 它的分量 2026-08-30 变重了
 *
 * 原来这个函数只管「这一格该不该沉到日程下面去」，判错了不丢东西 —— 那时「这场会结束了
 * 没有」由他按下 `标记会议结束` 说了算。理由是「粒度只到上午/下午，时钟答不出散会」。
 *
 * 那句话反了：粒度**正是**上午/下午，所以时钟答得出的恰好就是这个粒度上的那个问题。
 * 而按那一下才算结束的做法有一个没有症状的坏法 —— 他忘了按（或者那场会压根没开），
 * 第二天那几件议题还堂堂正正躺在「可以排会」的清单里，屏幕上没有任何一处说得出
 * 「这场会昨天就该开完了」。
 *
 * 所以现在它是**分栏的判据**（见 `slotIndexOf` 的 `ended`）：过去了的那一场从编排页上
 * 消失、整场挪进会后那一栏等纪要。`标记会议结束` 还在，作用降成一件事 —— 会提前散了，
 * 不想等到点。
 *
 * `now` 由调用方给（`readClock()` 或者测试里的固定值）—— 这里不自己取表，取了就没法测。
 */
export const slotPast = (
  s: Pick<MeetingSlot, "date" | "half">,
  now: Clock,
): boolean => {
  if (s.date < now.day) return true;
  if (s.date > now.day) return false;
  return now.minutes >= HALF_ENDS_AT[s.half];
};

/* -------------------------------------------------------------------------- */
/* 屏幕上那行字                                                                */
/* -------------------------------------------------------------------------- */

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
const CN_NUM = [
  "零",
  "一",
  "二",
  "三",
  "四",
  "五",
  "六",
  "七",
  "八",
  "九",
  "十",
] as const;

export const halfLabel = (half: DayHalf): string =>
  half === "am" ? "上午" : "下午";

/**
 * `YYYY-MM-DD` → `周四 9/4`。今天、明天、昨天写成那三个词 —— 这三天他不用去数星期。
 *
 * 用 `Date.UTC` 解析而不是 `new Date("2026-09-04")` 之后取本地星期：后者在东八区之外会
 * 整体差一天，而这个函数服务端和浏览器都要跑一遍，差一天就是两处写着不同的星期。
 */
export const dayLabel = (date: string, today: string): string => {
  if (date === today) return "今天";
  if (date === nextDay(today)) return "明天";
  if (date === prevDay(today)) return "昨天";
  const [y, m, d] = date.split("-").map(Number);
  return `${WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${m}/${d}`;
};

/** `八月十六日（周六）` —— 日程板抬头那一行，写全。 */
export const fullDayLabel = (date: string): string => {
  const [y, m, d] = date.split("-").map(Number);
  const w = WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${cn(m)}月${cn(d)}日（${w}）`;
};

/** 数字写成中文。只到 31，够一个月。 */
const cn = (n: number): string => {
  if (n <= 10) return CN_NUM[n];
  if (n < 20) return `十${n === 10 ? "" : CN_NUM[n - 10]}`;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${CN_NUM[tens]}十${ones ? CN_NUM[ones] : ""}`;
};

/** 后一天 / 前一天。跨月跨年交给 `Date.UTC` 自己算。 */
export const nextDay = (date: string): string => shiftDay(date, 1);
export const prevDay = (date: string): string => shiftDay(date, -1);

const shiftDay = (date: string, by: number): string => {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + by));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(
    t.getUTCDate(),
  ).padStart(2, "0")}`;
};

/**
 * 整场会那一行：`明天上午`、`周五 8/28 上午`。议题栏、日程板、会后那一栏写的是同一句。
 *
 * 「今天 / 明天 / 昨天」后面**不加空格**（「明天上午」本来就是一个词），别的日期后面加 ——
 * 「周五 8/28上午」那一串挤在一起，8 和「上」之间读起来像还没写完。判据是这一段以数字
 * 收尾，而不是去数它是不是那三个词：往后再多一档相对日期（后天），这一条不用跟着改。
 */
export const slotLabel = (
  s: Pick<MeetingSlot, "date" | "half">,
  today: string,
): string => {
  const day = dayLabel(s.date, today);
  return `${day}${/\d$/.test(day) ? " " : ""}${halfLabel(s.half)}`;
};

/* -------------------------------------------------------------------------- */
/* 颜色                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 一场会用哪一种颜色。四种循环。
 *
 * 为什么是四种而不是「每场一个色相」：颜色在这里要回答的只有一个问题「这两件是不是同
 * 一场」，同屏能同时看见的会最多三五场，四种足以让相邻两场永远不同色。多出来的色相买不到
 * 任何信息，只买到嘈杂。
 *
 * 按**时间序**取而不是按 id 哈希：哈希会让相邻两场有四分之一的概率撞色，而撞色恰好破坏
 * 这一族颜色唯一要说的那件事。
 */
export const SLOT_TONES = ["a", "b", "c", "d"] as const;
export type SlotTone = (typeof SLOT_TONES)[number];
export const toneOf = (seq: number): SlotTone =>
  SLOT_TONES[((seq % 4) + 4) % 4];

/* -------------------------------------------------------------------------- */
/* 议题排在哪一场、哪几个域到场                                                */
/* -------------------------------------------------------------------------- */

/**
 * 把「所有会」摊成「每件议题排在哪一场」的索引。
 *
 * `seq` 在这里算一次，各屏共用 —— 各屏自己数的话，同一场会在议题卡片上和日程板上会是
 * 两个颜色，而颜色承担的正是「这几件是同一场」。
 */
export const slotIndexOf = (
  slots: MeetingSlot[],
  now: Clock,
): Record<string, IssueSlot> => {
  const out: Record<string, IssueSlot> = {};
  [...slots].sort(bySlotTime).forEach((s, seq) => {
    s.issueIds.forEach((issueId, i) => {
      out[issueId] = {
        slotId: s.id,
        date: s.date,
        half: s.half,
        seq,
        size: s.issueIds.length,
        index: i + 1,
        // 「结束了」= 到点了，**或者**他提前按了那一下。口径全写在 `slotPast` 上。
        ended: Boolean(s.endedAt) || slotPast(s, now),
      };
    });
  });
  return out;
};

/**
 * 这场会有哪几个业务域到场。
 *
 * **默认是算出来的**：会上那几件议题各自属于哪个域，并集就是参会域。所以排会时一步
 * 都不用多做，也不可能出现「标了 FE、会上却没有 FE 的议题」这种在屏幕上看不出来的
 * 不一致。`extraDomainIds` 只补一种情况 —— 某个域的 DRI 要到场，但他手上没有议题
 * 在这场会上。
 *
 * 没有域的议题（还没派 DRI）不贡献任何域。那是诚实的空：这场会确实没人代表某一块生意。
 */
export const domainsOfSlot = (
  slot: Pick<MeetingSlot, "issueIds" | "extraDomainIds">,
  domainOfIssue: (issueId: string) => string | undefined,
): string[] => {
  const out: string[] = [];
  const push = (id: string | undefined) => {
    if (id && !out.includes(id)) out.push(id);
  };
  for (const issueId of slot.issueIds) push(domainOfIssue(issueId));
  for (const id of slot.extraDomainIds ?? []) push(id);
  return out;
};

/* -------------------------------------------------------------------------- */
/* 日程上从上往下的次序                                                        */
/* -------------------------------------------------------------------------- */

/** 他没拖过的排在拖过的后面。用最大安全整数而不是 `Infinity`：这个数要过 JSON。 */
export const UNRANKED = Number.MAX_SAFE_INTEGER;

export const rankOf = (order: string[], issueId: string): number => {
  const i = order.indexOf(issueId);
  return i < 0 ? UNRANKED : i;
};

export type AgendaSortable = {
  id: string;
  readyForMeeting: boolean;
  updatedAt: string;
  slot?: IssueSlot;
};

/**
 * 议题栏从上往下的次序。
 *
 * 四档，**依次比**：
 *
 *   1. 排了会、还没开的 —— 接下来要谈的，排在最前。
 *   2. 排了会、已经开完的 —— 它们在等他确认会后要点，但不再是「要安排的事」。
 *   3. 还在研究、前期调研已经做完的。
 *   4. 还在研究、调研没做完的。
 *
 * 每一档内部：已排会的按会议时间先后、同场按那场会自己的议程顺序；其余的，他拖过的按他
 * 拖的顺序，没拖过的按最近有动静。
 */
export const agendaCompare = (order: string[]) =>
  agendaCompareBy((id) => rankOf(order, id));

export const agendaCompareBy =
  (rank: (id: string) => number) =>
  (a: AgendaSortable, b: AgendaSortable): number => {
    const tier = (x: AgendaSortable) =>
      x.slot ? (x.slot.ended ? 1 : 0) : x.readyForMeeting ? 2 : 3;
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;

    if (a.slot && b.slot) {
      const k = slotOrderKey(a.slot).localeCompare(slotOrderKey(b.slot));
      if (k !== 0) return k;
      if (a.slot.index !== b.slot.index) return a.slot.index - b.slot.index;
    }

    const ra = rank(a.id);
    const rb = rank(b.id);
    if (ra !== rb) return ra - rb;
    return b.updatedAt.localeCompare(a.updatedAt);
  };
