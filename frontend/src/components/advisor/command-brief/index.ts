/**
 * 决断包这一屏的对外口子。
 *
 * 只转出三样：那一屏（`CommandBriefView`）、情报附件那一栏（`IntelligenceDrawer`）、
 * 以及从一轮报告里把包挑出来的那个函数（`pickCommandBrief`）。里面几段（建议横幅、
 * 请决断表…）不转出去 —— 它们的排版和顺序是这一屏的整体，单独拿去别处摆就不成立了。
 */
export { CommandBriefView } from "./command-brief-view";
export { IntelligenceDrawer } from "./intelligence-drawer";
export { pickCommandBrief } from "./pick";
export type {
  CommandBrief,
  CommandBriefBundle,
  CommandBriefEdits,
  BriefOrderEdit,
} from "./types";
