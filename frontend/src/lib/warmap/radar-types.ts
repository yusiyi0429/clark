export type FieldId = 'lighthouse' | 'tokenops';
export const fieldNames: Record<FieldId, string> = { lighthouse: '灯塔项目', tokenops: 'TokenOps' };
export type Anchor = { id: string; title: string; material: string; source: string; fields: FieldId[] };
export type MonitoringSource = { id: string; title: string; url: string };
export type OntologyMonitor = { id: string; title: string; material: string; scope: string };
export type RadarIssue = { title: string; judgment: string; options: string[]; fields: FieldId[]; urgency: 'red' | 'yellow' | 'gray'; reason: string; status: 'pending' | 'closed'; decision?: string };
export type Signal = { id: string; title: string; url: string; source: string; publishedAt?: string; collectedAt: string; anchorId: string; anchorSnapshot: Anchor; excerpt: string; summary: string; implication: string; unknown: string; score: number; read: boolean; saved: boolean; dismissed: boolean; issue?: RadarIssue };
export type RadarState = { version: 2; ontology: OntologyMonitor[]; anchors: Anchor[]; sources: MonitoringSource[]; signals: Signal[]; run: { status: 'idle' | 'running' | 'done' | 'error'; phase: string; startedAt?: string; finishedAt?: string; found: number; added: number; promoted: number; warnings: string[] } };
export function issueLocation(fields: FieldId[]): 'strategy' | FieldId | null {
  const ids = [...new Set(fields)].filter(id => id in fieldNames);
  return ids.length > 1 ? 'strategy' : ids[0] ?? null;
}
/** Company-level monitoring basis supplied by the ontology adapter. It is visible but never edited here. */
export const ontologyMonitoring: OntologyMonitor[] = [
  { id: 'ontology-outcome', title: '公司级 Outcome', material: '验证持续使用，以及从共识到负责人行动的闭环。', scope: '公司目标' },
  { id: 'ontology-lighthouse', title: '灯塔项目 · 当前 Mission', material: '跑通内部真实使用，并明确客户持续使用和 DRI 参与的验证方式。', scope: '经营验证' },
  { id: 'ontology-tokenops', title: 'TokenOps · 当前 Mission', material: '选定真实用量样本，明确节省价值与客户采购意愿的验证口径。', scope: '商业验证' },
  { id: 'ontology-capacity', title: '关键资源约束', material: '公司同时推进灯塔项目和 TokenOps，交付力量有限，需要持续识别会改变投入次序的外部变化。', scope: '公司能力' },
];

/** Scanner-facing anchors derived from ontology. Kept under the old export for signal/test compatibility. */
export function anchorsFromOntology(items: OntologyMonitor[]): Anchor[] {
  return items.map(item => {
    const searchable = `${item.title} ${item.material}`.toLowerCase();
    const fields: FieldId[] = /tokenops|tokenhub/.test(searchable)
      ? ['tokenops']
      : /灯塔|agents?/.test(searchable)
        ? ['lighthouse']
        : ['lighthouse', 'tokenops'];
    return {
      id: item.id,
      title: item.title,
      material: item.material,
      source: `公司本体 · ${item.scope}`,
      fields,
    };
  });
}

export const initialAnchors: Anchor[] = anchorsFromOntology(ontologyMonitoring);
