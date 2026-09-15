"use client";

import type { AnchorFocus } from "@/components/advisor/anchored-doc";
import { ReportPane } from "@/components/advisor/report-pane";
import type { IssueReport, ProbeNode } from "@/lib/data/types";
import type { Resource } from "@/lib/use-resource";

/**
 * 情报附件 —— 这一轮研究的完整论证与取证记录。
 *
 * ## 它是一份被降级的东西，不是一份被藏起来的东西
 *
 * 二十一节论证从前是这一页的一级产物：一号位点进议题研究，看到的就是它。现在第一屏是
 * 当前判断（判断板），论证退成附件 —— **退的是排序，不是访问**：一个页签的距离，每一节
 * 一字未删，划词、证据芯片、导出 PDF 全都照旧。
 *
 * 为什么要退：一份写满二十一节的报告答的是「凭什么」，而一号位打开这一页时先要知道的是
 * 「现在判断是什么、还缺什么」。两个问题都要答，但把「凭什么」摆在第一屏，等于每次都要
 * 他先读完一份研究才能开始追问 —— 而他在绝大多数议题上并不需要读完。
 *
 * （中间那一版把第一屏换成了决断包。那一条被推翻了：研究完成不等于已形成决议，更不等于
 * 该立即派发命令 —— 整段理由在 `_views/advisor-view.tsx` 头上。）
 *
 * ## 模型名只在这一栏出现
 *
 * 页签行原来写着「深研 v2」「DeepSeek」「Claude」这类链路与模型口径的词。那是**我们**
 * 做这套东西的人才关心的事：一号位判的是这几条建议成不成立，不是它出自哪一家的哪一版。
 * 所以那几个名字全部收进这一栏 —— 收进来而不是删掉，因为要核对「这两份到底看的是不是
 * 同一批材料」时，署名是唯一的入口。
 *
 * ## 为什么装的是 `ReportPane` 而不是直接一个 `BlockReport`
 *
 * 这一栏要显示的不止「一份写完的报告」：还在跑的那条链路要有秒表和步号（`PendingLane`）、
 * 跑挂的那条要说出原话、被指派 DRI 回传的承接研究也在这一排里、划词引用要能把原文带进
 * 右边那栏对话。这几样 `ReportPane` 已经全有，而它们和「二十一节怎么排版」是两件事 ——
 * 直接换成 `BlockReport` 的代价是把那几样各抄一遍，然后它们慢慢和报告栏漂开。
 */
export function IntelligenceDrawer({
  issueId,
  reportsRes,
  lane,
  nodes,
  onOpenBoard,
  anchorFocus,
  onQuote,
  allowRework,
}: {
  issueId: string;
  reportsRes: Resource<IssueReport[]>;
  /** 此刻在看哪一份原件（报告 `key`）。哪几份可选由页签行那一层排（`advisor-view.tsx`）。 */
  lane: string;
  nodes: ProbeNode[];
  /** 报告里点「来源」跳回当前判断那一栏。 */
  onOpenBoard: () => void;
  anchorFocus: AnchorFocus | null;
  onQuote: (text: string) => void;
  /**
   * 底下那颗「打回重研」给不给。
   *
   * 行动整理那一屏在的时候**不给**：同一件事（丢掉这一轮、重跑一遍）在那边叫「退回参谋
   * 重拟」，是四个主操作之一。同一个动作在两栏各摆一颗、名字还不一样，第一个后果是他不
   * 知道这两颗是不是同一颗。
   *
   * 他还没走进行动整理时那一屏够不着，这一颗就得留着 —— 否则一份读着不对的报告没有任何
   * 一处能打回。
   */
  allowRework: boolean;
}) {
  return (
    /*
     * 这一行说明**不跟着正文滚**：它答的是「我现在在看的是什么」，而那个问题在读到第
     * 十七节时和刚点进来时一样要答得出。
     *
     * `--pane-inset-top` 在这一层被改小：页签长条让出来的那 3.5rem 由这一行自己吃掉，
     * 底下的 `ReportPane` 从这一行下面开始就行 —— 两层各让一次 3.5rem 的话，正文第一行
     * 会掉到屏幕的三分之一处。
     */
    <div
      className="flex min-h-0 flex-1 flex-col"
      style={{ "--pane-inset-top": "0.5rem" } as React.CSSProperties}
    >
      {/* 这一句不提「决断包」：新报告没有命令包是合法的（行业题、这一轮参谋没给行动
          建议的），那时这一栏照样是这一轮论证的所在地。 */}
      <p className="meta shrink-0 px-7 pb-1 pt-14 text-ink-faint">
        这一轮研究的完整论证与取证记录。链路与模型口径只出现在这一栏。
      </p>
      <ReportPane
        issueId={issueId}
        reportsRes={reportsRes}
        tab={lane}
        nodes={nodes}
        onOpenNode={onOpenBoard}
        anchorFocus={anchorFocus}
        onQuote={onQuote}
        allowRework={allowRework}
      />
    </div>
  );
}
