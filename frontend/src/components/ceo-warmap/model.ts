/** Prototype scenarios. Historical references are distinguished from proposed targets. */
export type ViewId = 'radar' | 'capabilities' | 'strategy' | 'lighthouse' | 'tokenops';
export type IssueId = 'capacity' | 'growth' | 'hub' | 'payment' | 'participation' | 'voice';
export interface Campaign { id: string; name: string; achieved: string; focus: string; judgment: string; evidence: string; unknown: string }
export interface Zone { id: ViewId; name: string; owner: string; position: string; ltco: string; monthly: string; campaigns: Campaign[]; issues: IssueId[]; placeholder?: boolean }
export const zones: Zone[] = [
 { id: 'lighthouse', name: '灯塔项目战场', owner: '负责人', position: '单点价值出现；MVP验证，客户闭环尚未成立', ltco: '在真实客户中验证可复制的经营 Agent 使用与组织协同闭环。', monthly: '跑通内部真实使用，并明确客户持续使用和 DRI 参与的验证方式。', campaigns: [
  { id: 'ceo', name: 'CEO Agent', achieved: '跑通内部使用', focus: '内部独立使用价值待验证', judgment: '跑通链路与证明使用价值是两回事。下一步要看 CEO 能否围绕真实事项独立取得有用判断，随后再验证客户持续使用。', evidence: '8 月 Product Commitment Card 区分内部真实闭环与资方方向认可；二者不是同一个验收结果。', unknown: '客户是否会主动持续使用，以及在哪个工作时刻需要它，仍需真实记录。' },
  { id: 'dri', name: 'DRI Agent', achieved: '跑通内部使用', focus: '内部独立使用价值待验证', judgment: '承接和反馈的页面可用，还不能证明 DRI 会把真实工作带回来。应先验证一次完整的承接、推进、带回成果与反馈。', evidence: '9 月 Mission 对齐草案提出用客户 DRI 的真实动作和反馈检验协同；草案不等于已确认的当前目标。', unknown: '外部工具中完成的成果如何顺畅带回，客户 DRI 为何愿意持续参与，仍待验证。' },
 ], issues: ['payment','participation'] },
 { id: 'tokenops', name: 'TokenOps战场', owner: '负责人', position: '', ltco: '验证企业愿意为持续、可核验的模型使用优化付费。', monthly: '选定真实用量样本，明确节省价值与客户采购意愿的验证口径。', campaigns: [{ id:'cost',name:'用量与价值验证',achieved:'待补齐已核验结果',focus:'验证成本可见能否转化为客户价值',judgment:'用量可见只是基础能力；需要同时核验节省是否持续，以及客户是否愿意为此付费。',evidence:'案例依据来自词元云集测试议题库中的 FinOps、收费方式与 TokenHub 关系问题，属于探索方向。',unknown:'当前案例没有提供客户采购承诺，不能据此判断商业模式已成立。'}], issues: [] },
];
export interface Issue { id:IssueId; title:string; scope:string; judgment:string; options:string[]; evidence:string[]; unknown:string; research:string; source:string }
export interface IssuePreRead {
 dri:string;
 meetingId:string;
 readMinutes:number;
 decisionWindow:string;
 whyNow:string;
 changed:string[];
 reversibility:'单向门'|'双向门';
 missionRefs:string[];
}
export const issues: Record<IssueId,Issue> = {
 capacity:{id:'capacity',title:'交付力量先支持灯塔，还是 TokenOps？',scope:'公司战略议题 · 灯塔 / TokenOps',judgment:'先比较两边下一步要取得的关键证据与不能延期的承诺，再决定资源优先级。不能只依据谁催得更急。',options:['优先保住灯塔客户验证','优先验证 TokenOps 商业价值','保留两边最低验证力量'],evidence:['两边的关键节点与客户承诺尚需对齐。','8 月纲领明确 CEO 保留跨域方向、边界与资源取舍。'],unknown:'现有可用交付力量与机会成本没有在案例中量化。',research:'### 当前判断\n资源取舍应对应公司下一阶段最需要取得的证据。\n\n### 两种选择分别改变什么\n- **优先灯塔**：集中验证客户能否持续使用；可能推迟 TokenOps 的采购价值验证。\n- **优先 TokenOps**：先验证节省是否能转为收入；需要明确灯塔哪些承诺不可受损。\n\n### 拍板前还缺什么\n两边最小验证投入、客户时间窗口，以及推迟一轮的真实代价。\n\n本页为基于历史材料的案例分析，尚未进行新的外部取证。',source:'2026 年 8 月 Outcome-Mission 纲领：CEO 最终取舍与资源边界。'},
 growth:{id:'growth',title:'未来一年，公司首先靠 TKOS，还是 Token 业务形成增长？',scope:'公司战略议题',judgment:'比较真实需求、可复制交付与形成收入的路径，而不是比较市场叙事的吸引力。',options:['以 TKOS 为主攻','以 Token 业务为主攻','分阶段设证据门槛再选择'],evidence:['历史纲领要求依据验证证据决定后续主战场。','测试议题库包含 Token 供给、FinOps 和经营系统等候选方向。'],unknown:'候选方向尚不代表已确认的业务承诺。',research:'### 当前判断\n先统一增长成立的口径：谁付费、为何付费、公司需要持续承担什么。\n\n### 应比较的证据\n- TKOS：自主使用、协同反馈、采购意愿、交付可复制性。\n- Token 业务：持续需求、服务与供给成本、稳定收入。\n\n### 下一步\n为两个方向各明确一轮有意义的验证，避免用功能完成率决定主业。',source:'8 月纲领与词元云集测试议题库；候选议题并非已确认战略。'},
 hub:{id:'hub',title:'TokenHub 应继续作为内部底座，还是成为独立业务？',scope:'公司战略议题',judgment:'底座可用不自动意味着独立业务成立。对外经营还需要客户、持续服务承诺与独立的投入依据。',options:['继续支持内部战场','开始小范围外部验证','建立独立经营单元'],evidence:['8 月纲领将 TokenHub 定位为内部 MVP，保留未来商业扩展空间。'],unknown:'外部需求与持续服务成本尚未核验。',research:'### 已知边界\n历史材料中的 TokenHub 首先支撑内部调用、计量与稳定性。\n\n### 独立经营会新增什么\n外部客户、服务承诺、销售与运营投入。\n\n### 建议验证\n先找到愿意投入真实用量的外部客户，核验可持续收费依据，再讨论独立经营。',source:'8 月 Outcome-Mission 纲领：TokenHub 内部 MVP。'},
 payment:{id:'payment',title:'灯塔本阶段，是否必须验证客户付费？',scope:'灯塔项目 · 待讨论',judgment:'付费可以是重要证据，但不能直接把它改写成当前已经承诺的验收要求。应先讨论本阶段究竟要证明什么。',options:['本阶段加入付费验证','先验证持续使用，再验证付费','先补充客户采购研究'],evidence:['8 月确认稿采用内部真实闭环与资方方向认可两条验收路径。','历史确认稿没有将付费列为该阶段必达门槛。'],unknown:'当前生效目标是否已更新，以及客户能否在本阶段给出有意义的付费承诺。',research:'### 当前判断\n**不宜把“客户付费”未经讨论就加入当前验收。**\n\n### 为什么\n持续使用回答有没有经营价值，付费还涉及采购权限、预算与交易条件。两者相互关联，但不是同一件事。\n\n### 可以怎样推进\n1. 核对本阶段已确认的目标。\n2. 研究客户愿意为什么付费，以及谁有采购权。\n3. 有了依据，再决定是否更改验收。\n\n### 尚未证明\n客户已有付费意愿、预算或采购承诺。',source:'04_Product_Commitment_Card_2026-08_确认稿v0.2；历史材料，不代表当前未决事实。'},
 participation:{id:'participation',title:'客户 DRI 持续不参与，是否调整灯塔本阶段的验证目标？',scope:'灯塔项目 · 待讨论',judgment:'先识别参与障碍。不能因为反馈少，就直接把组织协同目标缩减成 CEO 个人使用。',options:['保留协同目标，先排查障碍','调整参与方式继续验证','提请调整本阶段验证目标'],evidence:['9 月对齐草案指出持续零反馈可能是组织导入问题，而非单纯产品问题。'],unknown:'客户是否理解目标、参与是否有价值、外部工作成果能否方便带回。',research:'### 当前判断\n反馈缺失首先意味着我们看不清，不能直接等同于目标不成立。\n\n### 需要区分\n- 不知道为什么参与。\n- 有意愿，但工具与工作方式不衔接。\n- 参与后确实没有获得价值。\n\n### 下一轮验证\n选一个真实 Mission，和对应 DRI 谈清目标及常用工具，完成一次成果带回和反馈，再判断目标是否需要调整。',source:'831交付与9月Mission对齐_v0.1_2026-08-18，草案中的组织导入风险。'},
 voice:{id:'voice',title:'首次交付承诺，是否必须包含语音体验？',scope:'灯塔项目 · 提请',judgment:'要判断的是语音是否决定首次真实使用，而不是替团队选择具体语音模型。',options:['纳入首次交付','首次交付后补充','先确认客户真实使用时刻'],evidence:['8 月 18 日对齐草案将首次交付是否纳入语音列为待拍板事项。'],unknown:'实际客户环境、识别质量和语音对使用频次的作用仍需验证。',research:'### 当前判断\n先明确首次交付需要支撑哪个真实工作时刻。\n\n如果 CEO 主要在移动和会议间隙使用，语音可能直接影响体验是否成立。若本次主要验证研究结果价值，则也可能先用屏幕完成。\n\n这是交付承诺的取舍；技术路径由负责人在明确边界后选择。',source:'8 月 18 日交付与 9 月 Mission 对齐草案 §4。'},
};
/** 会前阅读包的运行字段。后续由 M1B 的 Issue / Meeting / Mission 对象提供。 */
export const issuePreRead: Record<IssueId,IssuePreRead> = {
 capacity:{dri:'白田田',meetingId:'m1b-workshop',readMinutes:4,decisionWindow:'2 天内进入资源排期',whyNow:'两条战场都在形成下一轮投入安排，继续悬置会让两个 DRI 同时按满配计划推进。',changed:['灯塔新增客户连续使用验证','TokenOps 补入采购意愿验证'],reversibility:'单向门',missionRefs:['灯塔 · 客户连续使用验证','TokenOps · 商业价值验证']},
 growth:{dri:'刘明华',meetingId:'m1b-workshop',readMinutes:6,decisionWindow:'本月目标确定前',whyNow:'增长主路径会改变未来一年的资源与组织结构，需先统一证据门槛。',changed:['两个方向的验证口径已可并列比较'],reversibility:'单向门',missionRefs:['公司增长路径验证']},
 hub:{dri:'业务负责人',meetingId:'m1b-workshop',readMinutes:3,decisionWindow:'下一轮外部承诺前',whyNow:'一旦以独立业务对外承诺，就会新增销售、交付和持续服务责任。',changed:['内部底座已可用，外部需求仍无承诺'],reversibility:'单向门',missionRefs:['TokenHub · 用量与价值验证']},
 payment:{dri:'白田田',meetingId:'product-alignment',readMinutes:3,decisionWindow:'首次客户验证范围确定前',whyNow:'是否把付费写入本阶段验收，会直接改变客户沟通与交付范围。',changed:['当前确认稿未把付费列为必达门槛'],reversibility:'双向门',missionRefs:['灯塔 · 客户价值验证']},
 participation:{dri:'孙铭泽',meetingId:'product-alignment',readMinutes:4,decisionWindow:'下一轮客户 Mission 启动前',whyNow:'客户 DRI 的持续缺席正在削弱组织协同验证，但原因尚未被区分。',changed:['反馈减少已被记录，参与障碍尚未核验'],reversibility:'双向门',missionRefs:['灯塔 · DRI 协同闭环']},
 voice:{dri:'产品负责人',meetingId:'product-alignment',readMinutes:2,decisionWindow:'首次交付范围确认前',whyNow:'语音是否进入首次交付会改变交付承诺，但不应越级替团队选择技术方案。',changed:['移动与会议间隙被明确为候选使用时刻'],reversibility:'双向门',missionRefs:['CEO Agent · 首次真实使用']},
};
export const strategyIds:IssueId[]=['capacity','growth','hub'];
export type Command = {kind:'home'}|{kind:'view';view:ViewId;section?:'issues'|'goals'}|{kind:'issue';issue:IssueId;research:boolean}|{kind:'history'}|{kind:'close'}|{kind:'mute';muted:boolean}|{kind:'unknown'};
/** Only read/navigation intentions are executed. Organizational commands stay in discussion. */
export function resolveCommand(text:string, current:ViewId|null=null, currentIssue:IssueId|null=null):Command {
 const t=text.trim().replace(/战区/g,'战场');
 if(/^(不要|别|不用|暂时不要).*(打开|进入|返回|静音|关闭|显示|研究)/.test(t))return {kind:'unknown'};
 if(/^(请|帮我|先|现在|马上|把)*.*(停掉|暂停战役|增加预算|下发任务)/.test(t))return {kind:'unknown'};
 if(/^(返回|回到|打开|看看)?(首页|主页|全局)[。！!\s]*$/.test(t)||/回到全局|返回首页/.test(t))return {kind:'home'};
 if(/聊天记录|对话记录|刚才聊/.test(t))return {kind:'history'};
 if(/^(关闭|收起)(窗口|对话框|研究|这个)?[。！!\s]*$/.test(t))return {kind:'close'};
 if(/^(取消静音|打开声音|恢复声音)[。！!\s]*$/.test(t))return {kind:'mute',muted:false};
 if(/^(静音|关闭声音|不要出声)[。！!\s]*$/.test(t))return {kind:'mute',muted:true};
 const issue:IssueId|null=/交付(力量|资源)|先支持/.test(t)?'capacity':/付费/.test(t)?'payment':/DRI.*(参与|反馈)|不参与/.test(t)?'participation':/首次.*语音|语音.*交付/.test(t)?'voice':/TokenHub|独立业务|内部底座/i.test(t)?'hub':/增长|主业/.test(t)?'growth':(/这个议题|继续研究|深入研究|依据|证据/.test(t)?currentIssue:null);
 const explicitBrowse=/^(请|帮我|先|现在|给我|我想|想)?\s*(打开|看看|查看|显示|展开|研究一下|研究这个|深入研究|继续研究|分析一下)/.test(t);
 const currentEvidence=!!currentIssue&&/^(这个议题的?|当前判断的?)?(依据|证据)(是什么|呢)?[。？?\s]*$/.test(t);
 if(issue&&(explicitBrowse||currentEvidence))return {kind:'issue',issue,research:/研究|分析|为什么|依据|证据|深入|判断/.test(t)};
 // Merely mentioning a zone or issue is not a navigation command. A challenge
 // such as “为什么客户愿意付费” must reach the model, not repeat a canned card.
 if(!explicitBrowse&&!/^(灯塔项目|TokenOps|公司战略议题|公司能力|雷达信号|这个战场|当前战场|本月目标|LTCO|六个月目标|正在研究的议题)[。？?\s]*$/i.test(t))return {kind:'unknown'};
 let view:ViewId|null=/灯塔/.test(t)?'lighthouse':/TokenOps/i.test(t)?'tokenops':/公司战略|战略议题/.test(t)?'strategy':/雷达|信号/.test(t)?'radar':/公司能力|人才|基建/.test(t)?'capabilities':null;
 if(!view&&/这个战场|这里|当前战场/.test(t))view=current;
 if(!view&&current&&/^(看看|显示|打开|查看)?(当前月度目标|本月目标|LTCO|六个月目标|正在研究的议题)/i.test(t))view=current;
 if(view)return {kind:'view',view,section:/议题|研究|讨论/.test(t)?'issues':/目标|LTCO|六个月|6个月/.test(t)?'goals':undefined};
 return {kind:'unknown'};
}
