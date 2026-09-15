import type { IssueState } from "@/lib/data/types";
import { cn } from "@/lib/utils";

/**
 * 议题状态。
 *
 * 屏幕上写中文，数据里仍是 `IssueState` 那串标识符（后端状态机校验的就是它）。
 *
 * 之前这里刻意显示英文原文，理由是「状态是共享对象模型里的标识符，不是产品文案」。
 * 这条规矩在给工程看的界面上成立，在给一号位看的界面上不成立 ——「Exploring」在他眼里
 * 不是标识符，是一个没有信息量的英文单词。标识符要留痕，留在数据里就够了。
 *
 * 一个状态一个词，不写解释。
 */

const TONE: Record<IssueState, string> = {
  Candidate: "bg-judgment",
  Watching: "bg-ink-faint",
  Exploring: "bg-judgment",
  Researching: "bg-factual",
  ReadyForDecision: "bg-judgment",
  WaitingEvidence: "bg-factual",
  Decided: "bg-confirmed",
  Monitoring: "bg-confirmed",
  Reopened: "bg-counter",
  Closed: "bg-ink-faint",
  Dismissed: "bg-ink-faint",
};

export const STATE_LABEL: Record<IssueState, string> = {
  Candidate: "待处置",
  Watching: "观察中",
  Exploring: "研究中",
  Researching: "深研中",
  ReadyForDecision: "待上会",
  WaitingEvidence: "等证据",
  Decided: "已拍板",
  Monitoring: "已部署",
  Reopened: "已重开",
  Closed: "已关闭",
  Dismissed: "已否掉",
};

export function StateBadge({
  state,
  className,
}: {
  state: IssueState;
  className?: string;
}) {
  return (
    <span className={cn("meta inline-flex items-center gap-1.5", className)}>
      <span className={cn("size-1.5 rounded-full", TONE[state])} />
      <span className="text-ink-muted">{STATE_LABEL[state]}</span>
    </span>
  );
}
