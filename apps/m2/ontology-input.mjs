// The generator receives only selected facts, never raw ontology context packs.
export const testPolicy = Object.freeze({
  period: '2026-10',
  cutoff: '2026-10-08T23:59:59+08:00',
  baselinePolicy: 'latest-explicitly-selected',
  excludedTypes: ['PeriodGoal', 'Mission', 'Task', 'Activity'],
});

const baselineKinds = new Set(['strategy', 'lto', 'organization']);
const historicalKinds = new Set(['review', 'state', 'resource', 'dependency', 'decision']);
const validDate = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));

export function selectFacts(facts, policy = testPolicy) {
  if (!validDate(policy.cutoff)) throw Error('截止时间必须带时区');
  const accepted = [], excluded = [], pending = [];
  const seen = new Set();
  for (const fact of facts) {
    if (!fact.id || seen.has(fact.id)) throw Error('资料引用缺失或重复');
    seen.add(fact.id);
    const reject = reason => excluded.push({ id: fact.id, reason });
    const hold = reason => pending.push({ id: fact.id, reason });
    if (!fact.sourceRef || !fact.text?.trim()) { hold('缺少来源或正文'); continue; }
    if (fact.isAnswer || policy.excludedTypes.includes(fact.sourceType)) { reject('已有周期目标或下级拆解答案'); continue; }
    if (fact.mixedAnswer) { hold('正文夹带人工答案，须先拆成独立事实再选择'); continue; }
    if (fact.conflict) { hold('来源存在实质冲突，需要有效决定'); continue; }
    if (baselineKinds.has(fact.kind)) {
      if (fact.baselineSelected !== true) { hold('未明确选择有效基线版本'); continue; }
    } else if (historicalKinds.has(fact.kind)) {
      // recordedAt/modifiedAt/as_of alone cannot prove when a fact was true.
      if (!validDate(fact.factThrough) || !fact.dateEvidence) { hold('缺少事实截至日期及其依据'); continue; }
      if (Date.parse(fact.factThrough) > Date.parse(policy.cutoff)) { reject('事实晚于测试截止时间'); continue; }
    } else { hold('未识别的资料类别'); continue; }
    if (fact.reviewed !== true) { hold('尚未检查答案夹带、时间和业务含义'); continue; }
    // Explicit projection prevents raw payloads, comments and previous outputs leaking.
    accepted.push({ id: fact.id, unit: fact.unit, kind: fact.kind, sourceRef: fact.sourceRef, title: fact.title ?? null,
      text: fact.text, factThrough: fact.factThrough ?? null,
      dateEvidence: fact.dateEvidence ?? null, confirmation: fact.confirmation ?? 'unconfirmed' });
  }
  return { accepted, excluded, pending };
}

export function buildGeneratorInput(facts, policy = testPolicy) {
  const selection = selectFacts(facts, policy);
  return { mode: 'ontology-selected-facts', period: policy.period, cutoff: policy.cutoff,
    sources: selection.accepted, audit: { excluded: selection.excluded, pending: selection.pending } };
}
