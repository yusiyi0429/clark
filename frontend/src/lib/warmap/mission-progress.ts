export type Mission = { id: string; title: string; completed: boolean; feedback: string; difficulty: string };
export const missionSnapshots: Record<string, { source: string; missions: Mission[] }> = {
  lighthouse: { source: '9 月 Mission 演练快照 v1 · 尚未连接正式 Mission 台账', missions: [
    { id:'lh-use',title:'验证内部独立使用',completed:true,feedback:'内部使用者已独立完成一次真实事项的探索与判断，完成本项验收。',difficulty:'单一内部使用路径，已有产品和可配合的使用者。' },
    { id:'lh-return',title:'验证客户持续使用',completed:false,feedback:'尚未确认客户使用与反馈安排，验证未启动。',difficulty:'需要客户真实参与、多次使用和持续行为证据，是本月核心验证。' },
    { id:'lh-dri',title:'明确 DRI 参与与反馈方式',completed:false,feedback:'客户参与人选未确认，尚未对齐。',difficulty:'需要跨组织协调，与客户持续使用相互依赖。' },
  ] },
  tokenops: { source: '9 月 Mission 演练快照 v1 · 尚未连接正式 Mission 台账', missions: [
    { id:'to-sample',title:'完成三组真实用量样本核验',completed:false,feedback:'3组样本已完成2组核验，另1组计划9月16日返回；本项尚未整体验收。',difficulty:'逐组核验可直接计量，方法已明确。' },
    { id:'to-buy',title:'验证节省价值与客户采购意愿',completed:false,feedback:'采购访谈结果尚未返回，不能以样本核验代替采购意愿。',difficulty:'需要真实采购反馈，是商业验证关键，存在外部不确定性。' },
  ] },
};
export type MissionAssessment = { source: string; assessedAt: string; percent: number; simplePercent: number; completed: number; total: number; rationale: string; items: { id: string; weight: number; completion: number; reason: string }[] };
export function calculateAssessment(missions: Mission[], raw: { rationale?: string; items?: MissionAssessment['items'] }): Omit<MissionAssessment,'source'|'assessedAt'> {
  if (!missions.length) throw new Error('没有 Mission 时不计算完成百分比');
  if (!Array.isArray(raw.items) || raw.items.length !== missions.length || new Set(raw.items.map(i=>i.id)).size !== missions.length) throw new Error('评估缺少 Mission 或重复');
  const items = missions.map(m => { const i = raw.items!.find(x=>x.id===m.id); if (!i || !Number.isFinite(i.weight) || i.weight < 1 || i.weight > 5 || !Number.isFinite(i.completion) || i.completion < 0 || i.completion > 100 || !i.reason?.trim()) throw new Error('评估口径无效');
    if (m.completed && i.completion !== 100 || !m.completed && i.completion === 100) throw new Error('评估与 Mission 验收状态矛盾');
    return {...i,reason:i.reason.slice(0,500)}; });
  const completed = missions.filter(m=>m.completed).length, total = missions.length;
  return { percent: Math.round(items.reduce((s,i)=>s+i.weight*i.completion,0)/items.reduce((s,i)=>s+i.weight,0)), simplePercent: total ? Math.round(completed/total*100) : 0, completed, total, items, rationale: String(raw.rationale||'按难度与结果贡献加权，完成度依据反馈评估。').slice(0,800) };
}
