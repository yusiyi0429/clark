import type { ViewId } from './model';

export type BattlefieldMode = 'decisions' | 'progress';
export type BattlefieldDisplay = { mode: BattlefieldMode; overrides: Partial<Record<ViewId, BattlefieldMode>> };
export type ProgressCommand = { mode: BattlefieldMode; zone?: ViewId };
export interface BattlefieldProgress {
  deadline: string;
  longLabel: string;
  monthLabel: string;
  longTermAssessment: null;
  statusLabel: string;
  longTerm: string;
  month: string;
  monthly: string;
  measures: Array<
    | { kind: 'quantity'; label: string; actual: number; target: number; unit: string; longTarget?: number }
    | { kind: 'assessment'; label: string; result: string; verified: boolean }
  >;
  outlook: string;
  blocked: boolean;
  blocker: string;
  evidence: string[];
  /** 上次收集进度反馈的时间，与 Agent 评估时间区分；当前快照为示例数据。 */
  collectedAt: string;
}

/** Deliberately isolated demo snapshots: never written as company outcomes or verified facts. */
export const battlefieldProgress: Partial<Record<ViewId, BattlefieldProgress>> = {
  lighthouse: {
    deadline: '2027 年 2 月前',
    longLabel: '可复制的使用闭环', monthLabel: '真实使用验证',
    longTermAssessment: null, statusLabel: '卡在客户参与安排',
    longTerm: '验证可复制的经营 Agent 使用与组织协同闭环',
    month: '9 月', monthly: '跑通内部真实使用，明确客户持续使用与 DRI 参与的验证方式',
    measures: [
      { kind: 'assessment', label: '内部独立使用', result: '已验证', verified: true },
      { kind: 'assessment', label: '客户持续使用', result: '尚待验证', verified: false },
      { kind: 'assessment', label: 'DRI 参与方式', result: '尚未对齐', verified: false },
    ],
    outlook: '本月仍可推进，取决于客户本周确认参与安排', blocked: true,
    blocker: '客户尚未确认使用与反馈安排，后续验证未能启动。',
    evidence: [
      '演练反馈 · 9 月 9 日：内部使用者已独立完成一次真实事项的探索与判断；这不足以证明持续使用。',
      '演练反馈 · 9 月 10 日：客户使用时间和 DRI 参与人选仍未确认。',
      'Agent 演练评估：若 9 月 18 日前仍未启动，本月能获得的客户验证证据将不足。按期判断与 Mission 完成度分别评估。',
    ], collectedAt: '9 月 11 日 10:30',
  },
  tokenops: {
    deadline: '2027 年 2 月前',
    longLabel: '持续优化形成付费', monthLabel: '用量与采购验证',
    longTermAssessment: null, statusLabel: '样本预计按期 · 采购尚待验证', longTerm: '验证客户愿意为持续、可核验的模型使用优化付费',
    month: '9 月', monthly: '完成 3 组真实用量样本核验，明确节省价值与采购意愿',
    measures: [
      { kind: 'quantity', label: '用量样本核验', actual: 2, target: 3, unit: '组' },
      { kind: 'assessment', label: '客户采购意愿', result: '尚待验证', verified: false },
    ],
    outlook: '样本核验预计按期；采购意愿仍缺少证据', blocked: false,
    blocker: '目前没有已报告的阻碍；采购访谈结果尚未返回。',
    evidence: [
      '演练数据 · 9 月 10 日：3 组样本中，2 组已按约定口径完成核验，另 1 组计划 9 月 16 日返回。',
      '演练反馈 · 9 月 11 日：样本核验与节省价值不等于客户承诺采购。',
      'Agent 演练评估：按期判断基于剩余样本的已约定返回时间；不代表付费目标已经实现。',
    ], collectedAt: '9 月 11 日 09:40',
  },
};

/** Navigation only. Questions about progress still go to the discussion model. */
export function resolveProgressCommand(text: string, current: ViewId | null): ProgressCommand | null {
  const t = text.trim().replace(/战区/g, '战场').replace(/[。！!？?]+$/, '');
  if (/^(不要|别|不用|暂时不要)/.test(t)) return null;
  if (/^(回到|返回|显示|看看|切换到)(全部|所有战场的?)?待决策$/.test(t)) return { mode: 'decisions' };
  if (!/^(请|帮我|给我)?(只)?(看看|查看|显示|打开|切换到|看)/.test(t) || !/进展|进度/.test(t)) return null;
  if (/为什么|为何|是否|能否|怎么办|如果/.test(t)) return null;
  const zone: ViewId | undefined = /灯塔/.test(t) ? 'lighthouse' : /TokenOps/i.test(t) ? 'tokenops' : /这个战场|当前战场/.test(t) && current && ['lighthouse','tokenops'].includes(current) ? current : undefined;
  if (!zone && /这个战场|当前战场|战场\s*[BC]/i.test(t)) return null;
  return { mode: 'progress', zone };
}
