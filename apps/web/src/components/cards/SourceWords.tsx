import type { TCardSourceWordIssue } from "@warmap/contracts";

/** 本人原话（设计 16.8）：卡、派活单草稿上的 sourceWords，规划员从本人的话里原样摘的片段。为空不画。 */
export function SourceWords({ words, className }: { words: readonly string[]; className: string }) {
  if (!words.length) return null;
  return <blockquote className={className} data-testid="source-words">{words.map((word, index) => <p key={index}>{word}</p>)}</blockquote>;
}

const ISSUE_LABEL = { missing: "漏了", extra: "多做了" } as const;

/** 交回和本人原话对不上的几处（16.8）：跟在没过的标准后面，每条一行：那句原话、「漏了 / 多做了」、为什么。为空不画。 */
export function SourceWordIssues({ issues, className, tagClassName }: { issues: readonly TCardSourceWordIssue[]; className: string; tagClassName: string }) {
  if (!issues.length) return null;
  return (
    <ul className={className} data-testid="source-word-issues">
      {issues.map((issue, index) => (
        <li key={index}><span>{issue.quote}</span><span className={tagClassName}>{ISSUE_LABEL[issue.kind]}</span><small>{issue.reason}</small></li>
      ))}
    </ul>
  );
}
