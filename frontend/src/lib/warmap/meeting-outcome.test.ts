import { describe,expect,it } from 'vitest';
import { normalizeMeetingOutcome,routePublishedOutcome } from './meeting-outcome';

const input={meetingId:'m-1',recordingId:'REC-1',transcriptUpdatedAt:'2026-09-13T01:00:00.000Z',title:'战略会',leadDri:'白田田',ceoName:'刘明华',participants:['刘明华','白田田','孙铭泽'],issueIds:['capacity'],issues:[{id:'capacity',title:'资源顺序',scope:'公司战略',missionRefs:['灯塔 · 客户连续使用验证']}],transcript:'[00:01] 刘明华：灯塔优先，TokenOps 保留最低验证力量。\n[00:04] 刘明华：先执行到本月复盘，客户窗口变化就重新讨论。\n[00:08] 白田田：我周五前出资源排期。\n[00:15] 孙铭泽：客户范围还没有定。'};

describe('meeting outcome',()=>{
  it('keeps only traceable facts and routes explicit owners',()=>{
    const value=normalizeMeetingOutcome({summary:'资源顺序已明确，客户范围仍未决。',decisions:[{text:'灯塔优先',issueId:'capacity',quote:{speaker:'刘明华',text:'灯塔优先，TokenOps 保留最低验证力量。'},scope:{text:'执行到本月复盘',quote:{speaker:'刘明华',text:'先执行到本月复盘，客户窗口变化就重新讨论。'}},reopenWhen:[{text:'客户窗口变化',quote:{speaker:'刘明华',text:'先执行到本月复盘，客户窗口变化就重新讨论。'}}]}],actions:[{text:'产出资源排期',ownerName:'白田田',due:'周五前',issueId:'capacity',quote:{speaker:'白田田',text:'我周五前出资源排期。'}}],open:[{text:'客户范围待定',quote:{speaker:'孙铭泽',text:'客户范围还没有定。'}}],ceoJudgments:[{text:'灯塔优先，TokenOps 保留最低验证力量',whyCeo:'涉及跨战场资源配置',kind:'resource_allocation',issueId:'capacity',quote:{speaker:'刘明华',text:'灯塔优先，TokenOps 保留最低验证力量。'}}]},input);
    expect(value.actions[0].ownerName).toBe('白田田');
    expect(value.decisions[0]).toMatchObject({issueId:'capacity',scope:{text:'执行到本月复盘'},reopenWhen:[{text:'客户窗口变化'}]});
    expect(value.source).toEqual({recordingId:'REC-1',transcriptUpdatedAt:'2026-09-13T01:00:00.000Z'});
    expect(value.ceoJudgments).toHaveLength(1);
    expect(routePublishedOutcome(value).actionsByDri['白田田']).toHaveLength(1);
  });
  it('does not guess owners or promote non-CEO speech',()=>{
    const value=normalizeMeetingOutcome({actions:[{text:'产出排期',ownerName:'孙铭泽',quote:{speaker:'白田田',text:'我周五前出资源排期。'}}],ceoJudgments:[{text:'客户范围待定',whyCeo:'很重要',kind:'company_direction',quote:{speaker:'孙铭泽',text:'客户范围还没有定。'}}]},input);
    expect(value.actions[0].ownerName).toBeUndefined();
    expect(value.ceoJudgments).toEqual([]);
    expect(value.warnings).toHaveLength(2);
  });
  it('drops claims without an exact source quote',()=>{
    const value=normalizeMeetingOutcome({decisions:[{text:'凭空结论',quote:{speaker:'刘明华',text:'逐字稿里没有这句'}}]},input);
    expect(value.decisions).toEqual([]);
    expect(value.warnings[0]).toContain('缺少可核对原话');
  });
  it('drops unsupported decision metadata without dropping the sourced decision',()=>{
    const value=normalizeMeetingOutcome({decisions:[{text:'灯塔优先',quote:{speaker:'刘明华',text:'灯塔优先，TokenOps 保留最低验证力量。'},assumptions:[{text:'客户一定续约',quote:{speaker:'刘明华',text:'逐字稿没有这句'}}]}]},input);
    expect(value.decisions).toHaveLength(1);
    expect(value.decisions[0].assumptions).toEqual([]);
    expect(value.warnings[0]).toContain('关键假设');
  });
  it('drops invented due dates and out-of-scope mission references',()=>{
    const value=normalizeMeetingOutcome({actions:[{text:'产出排期',ownerName:'白田田',due:'下周一',missionRef:'不存在的 Mission',quote:{speaker:'白田田',text:'我周五前出资源排期。'}}]},input);
    expect(value.actions[0]).toMatchObject({ownerName:'白田田',due:undefined,missionRef:undefined});
    expect(value.warnings).toHaveLength(2);
  });
});
