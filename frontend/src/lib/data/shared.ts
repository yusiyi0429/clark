/**
 * 客户端与服务端共用的常量与纯函数。
 *
 * 这个文件的存在理由：`store.ts` 是 server-only（它持有整个对象库），但视图层
 * 需要 ROUTE_LABEL、cardSourceLabel 这类不依赖 store 的东西。放在这里两边都能
 * import，且不会把种子数据拖进客户端 bundle。
 *
 * 判据很简单：**依赖 store 的进 store.ts，不依赖的进这里。**
 */

import type { CardSource, DecisionRoute, ProbeRoute } from "./types";

/**
 * 全站的「今天」。种子数据全部以它为基准，所以只能有一处定义。
 *
 * ## 为什么不能写死
 *
 * 写死成 2026-08-10 的那一版，参谋在 8 月 13 日的对话里说出了这句话：
 * 「Mission Card 把场景锁定设为 8 月 11 日的里程碑，今天已经是 8 月 10 日，
 * 这件事今天不定，后面全部顺延。」——论证方式完全正确，事实错了三天，
 * 而那个里程碑其实已经过去了。一号位一眼就能看出来，然后他会开始怀疑
 * 屏幕上每一个日期。**参谋可以判断错，不能活在过去。**
 *
 * ## 为什么按北京时间算，而不是 new Date() 取本地日期
 *
 * 服务端和浏览器都会算这个值，两边时区不同就会在跨零点前后渲染出不同的日期，
 * hydration 直接对不上。锁 Asia/Shanghai 两边必然一致。
 */
const shanghaiDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const TODAY = shanghaiDay.format(new Date());

/** 派出去的那条 Evidence Action 长什么样。预告和回执上写的是同一句。 */
export const evidenceActionLabel =
  "Evidence Action · 决策采纳率口径与首批真实用户数据（04 域承接，返回后重开验证）";

/** 走 A 路（更新正式判断）时顺带派出的 Evidence Action 条数。 */
export const evidenceActionsOnStrategy = 1;

/**
 * **`message` 是一句写给读的人的话，可以直接上屏。**
 *
 * 这就是它和普通 `Error` 唯一的区别，也是视图层那一排 `instanceof ApiError` 分支
 * 真正在问的问题 —— 不是「这是业务失败还是意外」，而是「这句话能不能给他看」。
 *
 * 两侧都在用，含义一致但用途不同：
 *
 *   · 服务端（store.ts 抛、route.ts 接）：业务性失败，`route.ts` 据此回 409 并把原文
 *     带给前端。意外抛出的 `TypeError` 之类不是它，那些回 500 且原文只进日志。
 *   · 客户端（client.ts）：**所有**失败出 `post` 时都是它，因为那一层已经把每种失败
 *     翻译成一句中文了。视图层因此拿到的总是能上屏的话，不用再猜原因。
 */
export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export const ROUTE_LABEL: Record<DecisionRoute, string> = {
  strategy: "A · 更新正式判断",
  mission: "B · 形成独立 Mission",
  evidence: "C · 转 Evidence Action",
  close: "D · 关闭并记录重开条件",
};

/**
 * 候选决策的建议去向，屏幕上的名字。与四选一分流同构；`meeting` 不是第五条分流，
 * 而是「重大价值取舍走会前准备、会上再分流」的那条路。
 */
export const PROBE_ROUTE_LABEL: Record<ProbeRoute, string> = {
  ontology: "确认即写回本体 · 判断翻版",
  strategy: "更新正式 Strategy · 进 M1-B",
  mission: "形成 Mission 建议 · 待 DRI 承接",
  evidence: "布控 Evidence · 返回后重开",
};

/**
 * 一号位对 DRI 回传的逐条裁决，屏幕上的词。
 *
 * DRI 侧（Task 16）和 CEO 侧（Task 17）共用同一套说法，不许两边各写一份。
 */
export const COMMITMENT_RULING_LABEL: Record<"endorse" | "revise" | "reject", string> = {
  endorse: "认可",
  revise: "修订",
  reject: "拒绝",
};

/**
 * DRI 回传时对公司提案的表态，屏幕上的词。
 *
 * DRI 侧和 CEO 侧都要显示这四档，共用同一套说法。
 */
export const COMMITMENT_VERDICT_LABEL: Record<
  "accept" | "modify" | "rewrite" | "reject",
  string
> = {
  accept: "接受",
  modify: "修改",
  rewrite: "重写",
  reject: "拒绝",
};

/**
 * 一条潜在议题是谁递上来的，写成一行。
 *
 * 可信度的来源四种完全不同，所以标签不许统一成「来源」两个字：雷达抓的可信来自
 * 「有人在外面盯着变化」，DRI 上报的可信来自「一个具体的人把名字押在上面」（所以要
 * 写名字，不写「团队」），一号位自己加的不需要谁背书，研讨衍生的可信来自「它从哪场
 * 讨论里长出来」—— 最后这种尤其要标明，不然等于把自己刚说过的话当成新证据递回给自己。
 */
export function cardSourceLabel(source: CardSource): string {
  switch (source.kind) {
    case "radar":
      return "雷达捕捉";
    case "dri":
      return `${source.by} 上报`;
    case "ceo":
      return "您添加";
    case "probe":
      return `${source.issueId} 研讨衍生`;
  }
}

export const evidenceActionsFor = (route: DecisionRoute): number =>
  route === "evidence" ? 1 : route === "strategy" ? evidenceActionsOnStrategy : 0;
