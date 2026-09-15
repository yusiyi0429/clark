import { cardReference } from '@/lib/warmap/card-reference';
import { issues, type IssueId } from './model';
import type { DecisionReceipt } from './decision-model';
import type { Signal } from '@/lib/warmap/radar-types';

export function issueReference(id: IssueId, receipt?: DecisionReceipt) {
  const issue = issues[id];
  return cardReference(`issue:${id}`, issue.title, '议题', [
    `范围：${issue.scope}`, `状态：${receipt ? `会议结论已记录（演练）：${receipt.summary}` : '待会议讨论'}`,
    `当前判断：${issue.judgment}`, `依据：\n${issue.evidence.join('\n')}`, `未知：${issue.unknown}`,
    `会议讨论路径：\n${issue.options.join('\n')}`, `研究材料：\n${issue.research}`,
  ].join('\n\n'), `演练议题 · ${issue.source}`);
}
export function signalReference(signal: Signal) {
  return cardReference(`signal:${signal.id}`, signal.issue?.title || signal.title, signal.issue ? '雷达议题' : '雷达信号', [
    `摘要：${signal.summary}`, `影响：${signal.implication}`, `未知：${signal.unknown}`,
    `战略锚点：${signal.anchorSnapshot.title}\n${signal.anchorSnapshot.material}\n锚点来源：${signal.anchorSnapshot.source}`,
    `来源摘录（非全文）：${signal.excerpt.slice(0, 3000)}`,
    signal.issue ? `议题判断：${signal.issue.judgment}\n原因：${signal.issue.reason}\n状态：${signal.issue.status}\n决定：${signal.issue.decision || '尚未决定'}` : '',
  ].filter(Boolean).join('\n\n'), `${signal.source} · ${signal.url} · 采集于 ${signal.collectedAt}`);
}
