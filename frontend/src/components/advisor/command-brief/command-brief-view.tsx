"use client";

import { useState } from "react";

import {
  BlockShell,
  BlocksProvider,
  ConfidenceBadge,
  EvidenceRefs,
  InlineCites,
} from "@/components/advisor/blocks/chrome";
import { armsRework, nextStage, type ReworkPress, type ReworkStage } from "@/components/advisor/rework";
import type { BlockEvidence } from "@/lib/agent/a4/blocks/schema";
import { isDay } from "@/lib/data/types";
import { cn } from "@/lib/utils";

import type {
  BriefEvidenceEffect,
  BriefOrder,
  BriefOrderEdit,
  CommandBrief,
  CommandBriefEdits,
} from "./types";

/**
 * 决断包 —— 一号位**明确走进行动整理之后**看到的那一屏。
 *
 * 上一版它是深研跑完的默认落点。那一条被推翻了：研究完成不等于已形成决议，更不等于该
 * 立即派发命令（整段理由在 `_views/advisor-view.tsx` 头上）。默认那一屏是当前判断；这一
 * 屏要他自己按一下「整理成行动建议」才进得来，而那一下会落到服务端 —— 批准那道闸读它。
 *
 * ## 为什么是这个顺序
 *
 * 自上而下：**建议 → 请决断 → 拟制命令 → 指挥边界 → 三条改变路线的证据**。
 *
 * 这不是报告的顺序，是**下决心的顺序**。一份研究报告从态势讲起、把结论放在最后，那是
 * 写的人的顺序 —— 他要先说清楚自己凭什么。一号位读它的顺序反过来：先看要他做什么，
 * 决定要不要往下读；再看要他当场定哪几件；再看这几道命令落到谁头上、什么时候要结果；
 * 再看什么情况下这道命令作废；最后才是「凭什么」。
 *
 * 所以证据摆在最底下，而且只摆**三条会改变路线的**。不是把证据藏起来 —— 完整的二十一节
 * 论证在「情报附件」那一栏，一个页签的距离。这一屏答的是「现在怎么办」，那一栏答的是
 * 「凭什么」，两个问题不该挤在一屏上互相压。
 *
 * ## 一屏
 *
 * 每一段都有条数上限（态势 ≤3、请决断 ≤3、拟制命令 ≤3、另一种走法 ≤2），产出那一侧
 * 已经截过一次，这里**再截一次**：多交了两条的一份报告不该把这一屏撑成两屏，而「只看
 * 一屏」是这份东西存在的全部理由。截掉的不会消失，它们在情报附件里。
 *
 * ## 屏幕上没有模型名
 *
 * 这一屏上一个链路名、一个模型标识符都不出现。一号位读一份决断包时要判的是这几条建议
 * 成不成立，不是它出自哪一家的哪一版 —— 那是我们做这套东西的人才关心的口径。要看的话
 * 在情报附件那一栏，那里每一份原件都署着名。
 *
 * ## 命令上为什么没有名字
 *
 * `proposedOrders` 只写到角色（「产品负责人」「客户线」），**参谋不指人**：它手上没有一份
 * 可信的名册，猜一个名字写上去，一号位看到的就是一份带着假人名的命令 —— 而那份命令看起来
 * 和真的一模一样。所以每条命令底下留一格空的「负责人」，由他（或秘书）在批准这一刻填。
 * 空着是一个可见的待办，预填一个错的名字不是。
 */

/* -------------------------------------------------------------------------- */
/* 证据起了什么作用                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 四挡说的是**取证前后的差**，不是证据的强弱。
 *
 * 「查完还是原来的想法」和「查完把想法推翻了」，在一份写好的报告里读起来措辞几乎一样 ——
 * 都是一段自信的论证。而这两件事对一号位的意义差一个量级：前者他可以扫一眼就批，后者他
 * 得回头看自己上一次是怎么想的。所以这一格单独摆出来，用词是动词，不是形容词。
 */
const EFFECT: Record<BriefEvidenceEffect, { label: string; tone: string }> = {
  confirmed: { label: "证据坐实了原来的判断", tone: "text-confirmed" },
  narrowed: { label: "证据把成立范围收窄了", tone: "text-factual" },
  changed: { label: "证据改了判断", tone: "text-judgment" },
  reversed: { label: "证据把原来的判断推翻了", tone: "text-counter" },
};

/* -------------------------------------------------------------------------- */
/* 小零件                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 一段的标签。
 *
 * 层级靠字号和字重，不靠框线：整屏一条框都没有，段与段之间是一条发丝线加一档留白。
 * 五段各套一个卡片的话，这一屏会变成五张摞着的纸 —— 而它是一份东西。
 */
function SectionLabel({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <p className="meta text-ink-faint">
      <span className="font-medium text-ink-muted">{children}</span>
      {count !== undefined && count > 0 ? (
        <span className="ml-1.5 tabular-nums">{count}</span>
      ) : null}
    </p>
  );
}

/**
 * 一格既能读又能改的字。
 *
 * 不改的时候它就是正文，**没有输入框的边、没有背景**：一屏摆着七八个输入框的样子，读起来
 * 是一张表单，而这一屏九成的时间是拿来读的。「修改后批准」按下去之后才长出边来。
 *
 * 用 `value ?? original` 而不是把原文灌进 state：他没动过的那几格要跟着报告走，
 * 灌进去之后报告刷新了屏幕上还是旧的。
 */
function Editable({
  editing,
  value,
  original,
  onChange,
  className,
  placeholder,
  fallback,
}: {
  editing: boolean;
  value: string | undefined;
  original: string;
  onChange: (v: string) => void;
  className?: string;
  placeholder?: string;
  /**
   * 只读态下这一格是空的时候写什么（「时间待定」）。不给就什么都不写。
   *
   * 只管只读态：编辑态那一格空着是**一个可以填的输入框**，它自己有 placeholder；
   * 把「时间待定」灌进去会变成一句他没写过的、看起来像已经填好的字。
   */
  fallback?: string;
}) {
  const shown = value ?? original;
  if (!editing) {
    const text = shown.trim();
    return (
      <span className={cn(className, !text && fallback && "text-ink-faint")}>
        {text || fallback || ""}
      </span>
    );
  }
  return (
    <input
      value={shown}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "w-full rounded-[4px] border border-hairline bg-paper px-1.5 py-0.5 outline-none transition-colors duration-fast focus:border-hairline-strong",
        className,
      )}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* 主体                                                                        */
/* -------------------------------------------------------------------------- */

export function CommandBriefView({
  brief,
  evidence,
  onApprove,
  onDefer,
  onRework,
  onOpenIntel,
  blocked = null,
  className,
}: {
  brief: CommandBrief;
  /**
   * 产出这份包的那条链路自己的证据表。**必须成对传**（见 `types.ts` 的
   * `CommandBriefBundle`）：三条链路各自取证，拿错一份，屏幕上会把另一条链路抓回的网页
   * 说成是这一条抓的。
   */
  evidence: BlockEvidence[];
  /**
   * 批准并下达。`edits` 为 `null` 是原样批准，有值是改过之后批准（「修改后批准」那一路）。
   *
   * TODO(批 V·集成)：接 `store.approveCommandBrief(issueId, edits)`。签名以产出那一侧为准；
   * 形状对不上就改 `CommandBriefEdits` 和上面 `collectEdits`，不要在这个回调上拼形状。
   */
  onApprove?: (edits: CommandBriefEdits | null) => Promise<unknown> | void;
  /** 暂缓。TODO(批 V·集成)：接 store 上那一路。 */
  onDefer?: (note: string) => Promise<unknown> | void;
  /**
   * 退回参谋重拟 —— 这一批只是清任务重跑深研（`api.requestRework` → `reopenDeepResearch`
   * → `clearTask("deep")`）。留言原样带过去。
   */
  onRework?: (note: string) => Promise<unknown> | void;
  /** 「去看完整论证」—— 切到情报附件那一栏。 */
  onOpenIntel?: () => void;
  /**
   * 这一份**现在不能下达**的原因。能下达就是 `null`。
   *
   * 传进来的是一句写给一号位读的话，由 `dispatchBlockReason` 出 —— **和服务端那道闸同一个
   * 判据**（`store.approveCommandBrief` 拿它抛 `ApiError`）。这一屏只负责把它显示出来并把
   * 「批准并下达」置灰。
   *
   * 屏幕上这一下是**提前告知**，不是那道闸本身：闸在服务端，因为 `/api/data` 是直接 POST
   * 就打得进来的口（Next.js `mutating-data` 那份指南里那条警告）。这里只是不让他按下去
   * 才知道。
   *
   * 「暂缓」和「退回参谋重拟」照旧能按 —— 它们一条命令都不发，而一份不能下达的决断包
   * 恰恰最需要这两个出口。
   */
  blocked?: string | null;
  className?: string;
}) {
  const { recommendation: rec, controls } = brief;
  /*
   * **条数上限不在这里收。** 上限（态势 / 请决断 / 拟制命令各 ≤3、备选 ≤2）由出口机检
   * A4-N08 判，交多了报 p0 走返修。视图这边再截一次的话，多交的那几条在屏幕上不留
   * 任何痕迹 —— 一号位看到的三条和参谋交的六条长得一模一样，而「它到底交了几条」正是
   * 这一屏该不该被信任的一部分。**一处判、一处照实显示。**
   */
  const situation = brief.situation;
  const decisions = brief.decisionsRequired;
  const orders = brief.proposedOrders;
  const alternatives = brief.alternatives ?? [];

  /* 「修改后批准」按下去之后才进这一档：正文变成可改的格子，主键改口说「保存并下达」。 */
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState<string | undefined>(undefined);
  /** 逐条命令改了什么，键是它在 `orders` 里的下标 —— 包里没有别的 id 可用（见 `types.ts`）。 */
  const [orderEdits, setOrderEdits] = useState<Record<number, BriefOrderEdit>>({});
  const patch = (i: number, p: BriefOrderEdit) =>
    setOrderEdits((cur) => ({ ...cur, [i]: { ...cur[i], ...p } }));

  /**
   * 带出去的**只有改过的那几格**。
   *
   * 整份带出去的话，服务端分不出「他把期限改成了空」和「他没动期限」—— 而这两件事的
   * 结果完全不同。所以每一格都和原文比一次，一样就不带。
   */
  const collectEdits = (): CommandBriefEdits => {
    const out: CommandBriefEdits = {};
    const nextAction = action?.trim();
    if (nextAction && nextAction !== rec.action) out.action = nextAction;

    const list = orders.map((o, i) => {
      const e = orderEdits[i];
      if (!e) return undefined;
      const one: BriefOrderEdit = {};
      const role = e.role?.trim();
      if (role && role !== o.role) one.role = role;
      const dueOn = e.dueOn?.trim();
      if (dueOn && dueOn !== o.dueOn) one.dueOn = dueOn;
      if (e.acceptance && e.acceptance.join("\n") !== o.acceptance.join("\n")) {
        one.acceptance = e.acceptance.filter((x) => x.trim());
      }
      /* 负责人是**新填的**，没有原文可比 —— 有字就带。 */
      const dri = e.dri?.trim();
      if (dri) one.dri = dri;
      return Object.keys(one).length > 0 ? one : undefined;
    });
    if (list.some(Boolean)) out.orders = list;
    return out;
  };

  return (
    /*
     * 证据芯片认的是这个 provider 里那份证据表。`verifiedOnly` 恒为 false：那枚开关是
     * 情报附件那一栏的东西（读二十一节论证时才用得上），这一屏只有三条证据，筛没有意义。
     */
    <BlocksProvider evidence={evidence} verifiedOnly={false}>
      <div className={cn("mx-auto max-w-[42rem]", className)}>
        <Recommendation
          rec={rec}
          alternatives={alternatives}
          editing={editing}
          action={action}
          onAction={setAction}
        />

        <Decisions decisions={decisions} />

        <Orders orders={orders} editing={editing} edits={orderEdits} patch={patch} />

        <Controls controls={controls} />

        <Situation items={situation} onOpenIntel={onOpenIntel} />

        <ActionBar
          editing={editing}
          blocked={blocked}
          onEdit={() => setEditing(true)}
          onCancelEdit={() => {
            setEditing(false);
            setAction(undefined);
            setOrderEdits({});
          }}
          onApprove={() => onApprove?.(editing ? collectEdits() : null)}
          onDefer={onDefer}
          onRework={onRework}
        />
      </div>
    </BlocksProvider>
  );
}

/* -------------------------------------------------------------------------- */
/* 一 · 建议                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 这一屏最重的那一段：**建议做什么**。
 *
 * 一句祈使排在最大那一档，底下三行小字回答紧跟着的三个问题 —— 为了什么、为什么是现在、
 * 证据在这上面起了什么作用。没有横幅底色、没有边框：它靠字号站住，一块底色只会让它看起来
 * 像一条系统提示。
 */
function Recommendation({
  rec,
  alternatives,
  editing,
  action,
  onAction,
}: {
  rec: CommandBrief["recommendation"];
  alternatives: NonNullable<CommandBrief["alternatives"]>;
  editing: boolean;
  action: string | undefined;
  onAction: (v: string) => void;
}) {
  const effect = EFFECT[rec.evidenceEffect];
  return (
    <BlockShell index={0} refs={rec.evidenceRefs} alwaysShow className="">
      <SectionLabel>参谋建议</SectionLabel>

      <div className="mt-1.5">
        <Editable
          editing={editing}
          value={action}
          original={rec.action}
          onChange={onAction}
          className="report block text-xl font-medium leading-snug text-ink"
        />
      </div>

      <div className="mt-2.5 space-y-1">
        <p className="text-md leading-relaxed text-ink-muted">
          <span className="text-ink-faint">为了</span> <InlineCites text={rec.intent} />
        </p>
        <p className="text-md leading-relaxed text-ink-muted">
          <span className="text-ink-faint">为什么是现在</span> <InlineCites text={rec.whyNow} />
        </p>
      </div>

      {/*
        置信分档和「证据起了什么作用」排在同一行：一个说这条建议有多硬，一个说它是怎么变
        成现在这样的。分两行摆的话，中间那道空白会让人以为它们是两件事。
      */}
      <div className="mt-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-1.5">
        <ConfidenceBadge confidence={rec.confidence} />
        <span className={cn("meta font-medium", effect.tone)}>{effect.label}</span>
        <EvidenceRefs refs={rec.evidenceRefs} />
      </div>
      <p className="meta mt-1.5 leading-relaxed text-ink-muted">
        <InlineCites text={rec.evidenceEffectWhy} />
      </p>

      {/*
        另一种走法。**折起来**：它不是这一屏要答的问题（这一屏答的是「照这条办不办」），
        但也不能不给 —— 一份只给一条路的建议，读起来像参谋替他把选择做完了。折起那一行
        写清有几条，展开是一句「什么时候它更好」。
      */}
      {alternatives.length > 0 && (
        <details className="mt-3">
          <summary className="meta cursor-pointer text-ink-faint transition-colors duration-fast hover:text-ink-muted">
            另一种走法 · {alternatives.length} 条
          </summary>
          <ul className="mt-2 space-y-1.5">
            {alternatives.map((a, i) => (
              <li key={i} className="meta leading-relaxed">
                <span className="text-ink">{a.action}</span>
                <span className="text-ink-faint"> —— {a.whenBetter}时更好</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </BlockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 二 · 请决断                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * 请一号位当场定的那几件。
 *
 * 每一行四栏：**要定什么 / 建议 / 不定的代价 / 拍错了怎么退**。后两栏是这张表和一份普通
 * 待办清单的全部区别 —— 一件事拖着不定是有价格的，而那个价格从来没有人写在他面前；
 * 「拍错了怎么退」则决定他能不能快：退得回来的事可以现在就定，退不回来的才值得开会。
 *
 * 不画表格线。四栏在窄面板上会被压成四行，那时候框线只会把一件事切成四块。
 */
function Decisions({ decisions }: { decisions: CommandBrief["decisionsRequired"] }) {
  if (decisions.length === 0) return null;
  return (
    <BlockShell index={1} alwaysShow className="mt-8 border-t border-hairline pt-5">
      <SectionLabel count={decisions.length}>请您决断</SectionLabel>
      <ol className="mt-3 space-y-5">
        {decisions.map((d, i) => (
          <li key={i} className="flex gap-3">
            <span className="meta shrink-0 pt-0.5 tabular-nums text-ink-faint">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="text-md font-medium leading-relaxed text-ink">
                <InlineCites text={d.question} />
              </p>
              <p className="mt-1 text-sm leading-relaxed text-ink-muted">
                <span className="meta text-ink-faint">建议</span> <InlineCites text={d.recommendedChoice} />
              </p>
              {/*
                两栏并排，窄了就叠 —— 它们是一对：不定的代价说的是「不动的价格」，
                拍错了怎么退说的是「动错的价格」。放在两个不挨着的地方就比不出来了。
              */}
              <dl className="mt-1.5 grid gap-x-5 gap-y-1 sm:grid-cols-2">
                <div>
                  <dt className="meta text-ink-faint">不定的代价</dt>
                  <dd className="meta mt-0.5 leading-relaxed text-counter">
                    <InlineCites text={d.costOfDelay} />
                  </dd>
                </div>
                <div>
                  <dt className="meta text-ink-faint">拍错了怎么退</dt>
                  <dd className="meta mt-0.5 leading-relaxed text-ink-muted">
                    <InlineCites text={d.recoveryIfWrong} />
                  </dd>
                </div>
              </dl>
            </div>
          </li>
        ))}
      </ol>
    </BlockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 三 · 拟制命令                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 批准之后要发出去的那几道命令。
 *
 * 每条四样：**给谁（角色）、要什么结果、什么时候、怎么算做到了**。四样缺一样这道命令就
 * 发不出去 —— 缺验收条件的命令，三周后没人说得清它做没做完。
 *
 * 「要什么结果」写的是结果不是动作：一道写着「去和客户谈一轮」的命令，谈完就算完成；
 * 写着「拿到三家的书面口径」的那道，谈十轮没拿到就是没完成。
 *
 * 负责人那一格空着，理由在文件头。
 */
function Orders({
  orders,
  editing,
  edits,
  patch,
}: {
  orders: BriefOrder[];
  editing: boolean;
  edits: Record<number, BriefOrderEdit>;
  patch: (i: number, p: BriefOrderEdit) => void;
}) {
  if (orders.length === 0) return null;
  return (
    <BlockShell index={2} alwaysShow className="mt-8 border-t border-hairline pt-5">
      <SectionLabel count={orders.length}>拟制命令</SectionLabel>
      <ul className="mt-3 space-y-6">
        {orders.map((o, i) => {
          const e = edits[i] ?? {};
          const acceptance = e.acceptance ?? o.acceptance;
          return (
            <li key={i}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="min-w-0 flex-1">
                  <Editable
                    editing={editing}
                    value={e.role}
                    original={o.role}
                    onChange={(v) => patch(i, { role: v })}
                    className="report text-md font-medium text-ink"
                  />
                </span>
                {/*
                  期限。**真日期才进等宽数字那一档** —— 三条命令的日期竖着对齐才看得出哪
                  一条先到，而「首访前」对齐了没有意义。

                  没写日期的显示「时间待定」，不显示空白：空白读起来像「这一格还没渲染」。
                  写的是相对时间（「首访前」）就照原话摆着，**这一层不替它换算成某一天** ——
                  换算出来的那个日子会以和真日期完全一样的样子摆在旁边，而它是编的。落库
                  时这两种分两栏走（`DecisionOrder.dueOn` / `dueNote`，分栏在 `splitDue`）。
                */}
                <span
                  className={cn(
                    "meta shrink-0 text-ink-muted",
                    isDay(e.dueOn ?? o.dueOn) && "tabular-nums",
                    editing && "w-32",
                  )}
                >
                  <Editable
                    editing={editing}
                    value={e.dueOn}
                    original={o.dueOn}
                    onChange={(v) => patch(i, { dueOn: v })}
                    className={cn(isDay(e.dueOn ?? o.dueOn) && "tabular-nums")}
                    placeholder="期限：写日期或留空"
                    /* 只读那一档的空值 —— 编辑态留着占位提示，那时空白是一个可填的格子。 */
                    fallback="时间待定"
                  />
                </span>
              </div>

              <p className="mt-1 text-sm leading-relaxed text-ink">
                <InlineCites text={o.outcome} />
              </p>

              <div className="mt-1.5">
                <p className="meta text-ink-faint">验收条件</p>
                {editing ? (
                  /* 一行一条。分行编辑而不是给每条一个输入框：他常做的事是加一条、删一条，
                     而那两件事在一个输入框阵列里要点两下加号才办得到。 */
                  <textarea
                    value={acceptance.join("\n")}
                    onChange={(ev) => patch(i, { acceptance: ev.target.value.split("\n") })}
                    rows={Math.max(2, acceptance.length)}
                    className="talk scroll-slim mt-1 w-full resize-none rounded-[4px] border border-hairline bg-paper px-2 py-1.5 text-sm leading-relaxed text-ink outline-none transition-colors duration-fast focus:border-hairline-strong"
                  />
                ) : (
                  <ul className="mt-0.5 space-y-0.5">
                    {acceptance.map((c, k) => (
                      <li key={k} className="meta flex gap-2 leading-relaxed text-ink-muted">
                        <span className="shrink-0 text-ink-faint">·</span>
                        <span className="min-w-0">
                          <InlineCites text={c} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {o.resources?.length ? (
                <p className="meta mt-1.5 text-ink-faint">
                  调用 {o.resources.join("、")}
                </p>
              ) : null}

              {/*
                负责人。**任何时候都能填，不只在「修改后批准」那一档** —— 指定谁来接不是
                「修改这道命令」，是批准这个动作本身的一部分：一道没有人的命令下不出去。

                一行自由文本，不给下拉：这个产品此刻没有一份可信的名册，给下拉等于现编一份。
              */}
              <label className="mt-2 flex items-baseline gap-2">
                <span className="meta shrink-0 text-ink-faint">负责人</span>
                <input
                  value={e.dri ?? ""}
                  onChange={(ev) => patch(i, { dri: ev.target.value })}
                  placeholder="批准时指定"
                  className="meta min-w-0 flex-1 border-b border-hairline bg-transparent pb-0.5 text-ink outline-none transition-colors duration-fast placeholder:text-ink-faint focus:border-hairline-strong"
                />
              </label>
            </li>
          );
        })}
      </ul>
    </BlockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 四 · 指挥边界                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 这道命令在什么范围内成立。
 *
 * 三行说的是三件不同的事，混成一行「注意事项」就全废了：
 *
 *   不许做什么   边界。越过它，做成了也是错的。
 *   什么会改令   世界变了要回来重议的那几条。
 *   什么时候中止 不用回来问、当场停的那几条。
 *
 * 后两条的差别是**要不要回来问他**。分不清的后果是一线遇到情况时全都回来问，或者全都
 * 自己决定 —— 两种都不对。
 */
function Controls({ controls }: { controls: CommandBrief["controls"] }) {
  const rows: { label: string; items: string[]; tone: string }[] = [
    { label: "不许做", items: controls.mustNot, tone: "text-ink" },
    { label: "什么会改令", items: controls.changeTriggers, tone: "text-ink-muted" },
    { label: "什么时候中止", items: controls.abortConditions, tone: "text-counter" },
  ].filter((r) => r.items.length > 0);
  if (rows.length === 0 && !controls.reviewAt) return null;

  return (
    <BlockShell index={3} alwaysShow className="mt-8 border-t border-hairline pt-5">
      <SectionLabel>指挥边界</SectionLabel>
      <dl className="mt-3 space-y-2.5">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-wrap gap-x-3 gap-y-1 sm:flex-nowrap">
            <dt className="meta w-24 shrink-0 text-ink-faint">{r.label}</dt>
            <dd className="min-w-0 flex-1">
              <ul className="space-y-1">
                {r.items.map((x, i) => (
                  <li key={i} className={cn("meta leading-relaxed", r.tone)}>
                    <InlineCites text={x} />
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        ))}
        {controls.reviewAt ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1 sm:flex-nowrap">
            <dt className="meta w-24 shrink-0 text-ink-faint">复盘</dt>
            <dd className="meta min-w-0 flex-1 tabular-nums text-ink-muted">{controls.reviewAt}</dd>
          </div>
        ) : null}
      </dl>
    </BlockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 五 · 三条改变路线的证据                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 态势 —— 只留会改变路线的那三条。
 *
 * 「改变路线」是入选的唯一标准：一条读完之后什么都不会变的事实，写在这一屏上只是在消耗
 * 他往下读的耐心。剩下的都在情报附件里，而这一段末尾就有一条过去的路。
 *
 * 每条带证据芯片，点开是溯源卡（来源、口径、抓取时间、地址）—— 他起疑的第一步永远是
 * 「这是谁说的」，那一步不该要他换一栏。
 */
function Situation({
  items,
  onOpenIntel,
}: {
  items: CommandBrief["situation"];
  onOpenIntel?: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <BlockShell
      index={4}
      refs={items.flatMap((s) => s.evidenceRefs)}
      alwaysShow
      className="mt-8 border-t border-hairline pt-5"
    >
      <SectionLabel>改变路线的证据</SectionLabel>
      <ol className="mt-3 space-y-3">
        {items.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="meta shrink-0 pt-0.5 tabular-nums text-ink-faint">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-relaxed text-ink">
                <InlineCites text={s.text} />
              </p>
              <EvidenceRefs refs={s.evidenceRefs} className="mt-1" />
            </div>
          </li>
        ))}
      </ol>
      {onOpenIntel ? (
        <button
          type="button"
          onClick={onOpenIntel}
          className="meta mt-3 rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-ink-muted"
        >
          完整论证与取证记录在情报附件 →
        </button>
      ) : null}
    </BlockShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 主操作                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 四个主操作：**批准并下达｜修改后批准｜暂缓｜退回参谋重拟**。
 *
 * 上一版这一屏的主操作是「确认某条判断」—— 那是在问他同不同意一句话。这四个问的是他要不要
 * 让这件事动起来，而那才是一号位在这一屏上真正要做的事。
 *
 * ## 四个不是一排平等的按钮
 *
 * 「批准并下达」是实心的那一颗，另外三个是字。四颗一样重的话，这一屏就成了一道四选一的
 * 考题 —— 而绝大多数决断包的正确结局是批准，另外三个是它的出口，不是它的同侪。
 *
 * ## 「退回参谋重拟」为什么要按两下
 *
 * 它按下去丢掉现有报告、起一轮十几分钟的深研、花一笔真钱。哪一下算数由 `armsRework` 定，
 * 整段理由在 `rework.ts` —— 那是「打回重研」那颗键用的同一个闸，同一件事不许有两套手感。
 */
function ActionBar({
  editing,
  blocked,
  onEdit,
  onCancelEdit,
  onApprove,
  onDefer,
  onRework,
}: {
  editing: boolean;
  /** 不能下达的原因，能下达就是 `null`。见 `CommandBriefView` 上那一段。 */
  blocked: string | null;
  onEdit: () => void;
  onCancelEdit: () => void;
  onApprove: () => Promise<unknown> | void;
  onDefer?: (note: string) => Promise<unknown> | void;
  onRework?: (note: string) => Promise<unknown> | void;
}) {
  const [busy, setBusy] = useState<"approve" | "defer" | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /* 退回那一路自己的闸与留言（`rework.ts`）。 */
  const [stage, setStage] = useState<ReworkStage>("idle");
  const [note, setNote] = useState("");

  /*
   * 落定那一句原话照抄库那一侧的失败原因，不改写成「操作失败，请重试」—— 他要拿它判断
   * 是钥匙没配、是这一份已经批过了，还是别的。
   */
  const blame = (e: unknown) => setFailed(e instanceof Error ? e.message : String(e));

  /*
   * 回调可能是同步抛的（还没接上库的那一档就是），所以整个调用包在 `Promise.resolve`
   * 之前先进 `try` —— 不然那一下抛出去，屏幕上什么都不会说。
   */
  const run = (which: "approve" | "defer", label: string, call: () => Promise<unknown> | void) => {
    setFailed(null);
    setBusy(which);
    try {
      void Promise.resolve(call())
        .then(() => setDone(label))
        .catch(blame)
        .finally(() => setBusy(null));
    } catch (e) {
      blame(e);
      setBusy(null);
    }
  };

  const approve = () =>
    run("approve", editing ? "已按您改过的那一份下达。" : "已批准并下达。", () => onApprove());

  const defer = () =>
    run("defer", "已暂缓。这一份留着，随时可以再批。", () => onDefer?.(""));

  const pressRework = (p: ReworkPress) => {
    const fire = armsRework(stage, p);
    setStage(nextStage(stage, p));
    if (!fire) return;
    setFailed(null);
    try {
      void Promise.resolve(onRework?.(note))
        .then(() => {
          setNote("");
          setDone("已退回参谋，正在重拟。");
        })
        .catch(blame)
        .finally(() => setStage("idle"));
    } catch (e) {
      blame(e);
      setStage("idle");
    }
  };

  return (
    <div className="mt-10 border-t border-hairline pt-4">
      {stage === "confirming" ? (
        <div className="animate-fade">
          {/* 只报事实：丢什么、要多久、留言去哪。没有一句替他拿主意的话。 */}
          <p className="meta leading-relaxed text-ink-muted">
            这一份决断包和它背后的报告原件会丢掉，重跑一轮最多 25 分钟。留言发给承接人，不进这一轮的模型输入。
          </p>
          <textarea
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="哪里不对，要参谋往哪个方向重拟"
            className="talk scroll-slim mt-2.5 h-20 w-full resize-none rounded-xl border border-hairline bg-paper px-3 py-2 text-sm text-ink outline-none transition-colors duration-fast placeholder:text-ink-faint focus:border-hairline-strong"
          />
          <div className="mt-2.5 flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => pressRework("confirm")}
              className="meta inline-flex h-8 items-center rounded-md bg-solid px-3 font-medium text-solid-fg transition-opacity duration-fast hover:opacity-90"
            >
              确认退回
            </button>
            <button
              type="button"
              onClick={() => pressRework("cancel")}
              className="meta rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-ink-muted"
            >
              算了
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
          <button
            type="button"
            disabled={busy !== null || stage === "running" || blocked !== null}
            title={blocked ?? undefined}
            onClick={approve}
            className="meta inline-flex h-8 items-center rounded-md bg-solid px-3.5 font-medium text-solid-fg transition-opacity duration-fast hover:opacity-90 disabled:opacity-50"
          >
            {busy === "approve" ? "正在下达…" : editing ? "保存并下达" : "批准并下达"}
          </button>

          {/* 「修改后批准」最终也要经过同一颗主键，所以它跟着一起灰 —— 让他改完一屏
              才在最后一下被拒，比一开始就说不行坏。 */}
          <button
            type="button"
            disabled={blocked !== null}
            title={blocked ?? undefined}
            onClick={editing ? onCancelEdit : onEdit}
            className="meta rounded-[3px] font-medium text-ink-muted transition-colors duration-fast hover:text-ink disabled:opacity-50"
          >
            {editing ? "放弃修改" : "修改后批准"}
          </button>

          <button
            type="button"
            disabled={busy !== null}
            onClick={defer}
            className="meta rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-ink-muted disabled:opacity-50"
          >
            {busy === "defer" ? "正在暂缓…" : "暂缓"}
          </button>

          {/* 退在最右，和前三个之间留一道空 —— 它是这一排里唯一一个会花钱的。 */}
          <button
            type="button"
            disabled={stage === "running"}
            onClick={() => pressRework("open")}
            className="meta ml-auto rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-counter disabled:opacity-50"
          >
            {stage === "running" ? "正在退回…" : "退回参谋重拟"}
          </button>
        </div>
      )}

      {/*
        不能下达时把原因写在按钮底下 —— 一颗置灰的按钮只说「不行」，说不出为什么，而
        这里的「为什么」正是他接下来要处理的那件事（接着研究、退回重拟，还是先暂缓）。
        原话来自 `dispatchBlockReason`，和服务端拒绝时抛出来的是同一句。
      */}
      {blocked && stage !== "confirming" ? (
        <p className="meta mt-2 leading-relaxed text-counter">{blocked}</p>
      ) : null}

      {/* 改过之后那一句提醒：主键的字已经从「批准并下达」变成了「保存并下达」，
          但改动散在上面几段里，一句话说清这一下带走的是什么。 */}
      {editing && stage !== "confirming" ? (
        <p className="meta mt-2 text-ink-faint">
          正文、角色、期限、验收条件都可以就地改；改过的那几格会跟着这一下带出去。
        </p>
      ) : null}

      {done ? <p className="meta mt-2 text-confirmed">{done}</p> : null}
      {/* 起不起得来是库那一侧的事实，原话照抄。 */}
      {failed ? <p className="meta mt-2 text-counter">{failed}</p> : null}
    </div>
  );
}
