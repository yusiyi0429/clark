/**
 * 决断包在屏幕这一侧的类型。
 *
 * **形状本身不住在这里。** 它的住处是 `@/lib/agent/a4/blocks/schema`（挂在
 * `ReportBlocks.commandBrief` 上，由深研收口那一次多交的那一行产出）—— 那里是模型交出来
 * 的东西被读进来的唯一入口。抄一份形状到视图这一侧的话，两份漂开时编译器一个字都不会说
 * （结构相同的类型互相赋值合法），第一个发现的人是屏幕。
 *
 * 所以下面只做两件事：把 schema 那几个类型按屏幕上的叫法转出去，以及声明**屏幕自己的**
 * 那两个 —— `CommandBriefEdits`（他改了什么）和 `CommandBriefBundle`（哪一栏报告的包，
 * 连着那条链路自己的证据表）。这两个模型侧没有。
 */

import type { BlockEvidence, CommandBrief } from "@/lib/agent/a4/blocks/schema";

/*
 * 屏幕上按段落引用这几块，各有各的叫法（「态势」「建议」「请决断」…），所以给它们起了名字；
 * 但**每一个都是从那一份 `CommandBrief` 上取下来的**，不是重写一遍。
 */
export type { CommandBrief };
export type BriefSituation = CommandBrief["situation"][number];
export type BriefRecommendation = CommandBrief["recommendation"];
export type BriefDecision = CommandBrief["decisionsRequired"][number];
export type BriefOrder = CommandBrief["proposedOrders"][number];
export type BriefControls = CommandBrief["controls"];
export type BriefAlternative = NonNullable<CommandBrief["alternatives"]>[number];
export type BriefEvidenceEffect = CommandBrief["recommendation"]["evidenceEffect"];

/**
 * 屏幕上改动了什么 —— 「修改后批准」那一路带出去的东西。
 *
 * **只带改过的那几格**，不带整份包：整份带出去的话，服务端分不出「他把期限改成了空」
 * 和「他没动期限」，而这两件事的结果完全不同。
 *
 * 库那一侧的 `CommandBriefEdits`（`@/lib/data/types`）形状不同 —— 它按显式 `index` 认命令、
 * 那一栏叫 `driId`。两份**故意不一样**，翻译在 `advisor-view.tsx` 的 `toStoreEdits` 里，
 * 理由写在那个函数上。
 */
export interface CommandBriefEdits {
  /** 改过的建议正文（`recommendation.action`）。没动就没有这一栏。 */
  action?: string;
  /**
   * 逐条命令的改动，**下标对齐 `proposedOrders`**。这一条没改就是 `undefined`，
   * 数组本身仍然占位 —— 位置就是这条命令的身份，包里没有别的 id 可用。
   */
  orders?: (BriefOrderEdit | undefined)[];
}

export interface BriefOrderEdit {
  role?: string;
  dueOn?: string;
  acceptance?: string[];
  /**
   * 一号位在批准这一刻指定的负责人。
   *
   * 一行自由文本，**不预填、不给下拉** —— 这个产品此刻没有一份可信的名册（组织那一层
   * 还没接进来），给下拉等于现编一份。他写的字原样带出去，落谁头上由接的那一侧解析。
   */
  dri?: string;
}

/**
 * 一份决断包在屏幕上要的全部输入。
 *
 * 证据表跟着包一起走：三条链路各自取证，`E3` 在这一份里和在另一份里是两页不同的网页
 * （见 `ReportSource.blocks` 那段注释）。芯片只能拿**产出这份包的那一条链路**的证据表去
 * 解析 —— 所以两样必须成对取出来，不许分头传。
 */
export interface CommandBriefBundle {
  brief: CommandBrief;
  evidence: BlockEvidence[];
  /** 产出它的那条链路的报告 key（`agent` / `agent:alt0`）。给「去看完整论证」那一跳用。 */
  laneKey: string;
}
