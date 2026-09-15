import { ReferenceButton } from './card-references';
import { issueReference } from './reference-model';
import type { ReactNode } from 'react';
import type { IssueId } from './model';
import { issues } from './model';
import { decisionMeta } from './decision-model';
import { ChevronRight } from 'lucide-react';
import s from './capability-issues.module.css';

/** Views of existing issues, not separate decisions or new company commitments. */
export const capabilityIssueGroups: { id: 'product' | 'technology' | 'general'; name: string; issues: IssueId[] }[] = [
  { id: 'product', name: '产品', issues: [] },
  { id: 'technology', name: '技术', issues: ['hub'] },
  { id: 'general', name: '综合', issues: ['capacity'] },
];

export function CapabilityIssues({ visible, renderIssue }: {
  visible: (id: IssueId) => boolean;
  renderIssue: (id: IssueId) => ReactNode;
}) {
  const groups = capabilityIssueGroups.filter(group => group.issues.some(visible));
  return <div className={s.groups} data-testid="capability-issues">
    {groups.map(group => <section key={group.id} className={s.group} data-capability-category={group.id} aria-label={`${group.name}能力建设议题`}>
      <h3>{group.name}</h3>
      {group.issues.filter(visible).map(id => <div key={id}>{renderIssue(id)}</div>)}
    </section>)}
    {!groups.length && <p className={s.empty}>暂无需要你关注的能力建设议题</p>}
  </div>;
}

export function CapabilityIssueButton({ id, onOpen }: { id: IssueId; onOpen: (id: IssueId) => void }) {
  const meta = decisionMeta[id];
  return <div className={s.referenceRow}><button type="button" className={s.issue} data-urgency={meta.urgency} onClick={() => onOpen(id)}>
    <i aria-hidden="true"/>
    <span>{issues[id].title}{meta.urgency === 'red' && meta.reason && <small>{meta.reason}</small>}</span>
    <ChevronRight size={14} aria-hidden="true"/>
  </button><ReferenceButton item={issueReference(id)}/></div>;
}
