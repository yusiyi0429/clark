/**
 * Ticket 01 · 视觉基线专用 fixture。
 *
 * 它只服务于旧 Web 与新 Web 的视觉比较：所有可变文本按固定字符数补齐（等长），
 * 时间戳固定，ID 确定。它不是新系统的业务数据源，也不代表任何真实公司事实。
 *
 * 字段等长约定（JS 字符数，含 CJK；不足用全角空格 U+3000 右侧补齐）：
 *   signal.title 24 · signal.source 10 · summary 66 · implication 72 · unknown 48 · excerpt 160
 *   issue.judgment 60 · issue.reason 40 · issue.decision 48 · issue.options[*] 12
 *   anchor.title 18 · anchor.material 100 · anchor.source 20 · run.phase 24
 */

const PAD = '　'; // U+3000 全角空格，与 CJK 正文等宽。

/** 等长补齐。超长视为 fixture 编写错误，立即抛出。 */
function pad(value, length) {
  const text = String(value);
  if (text.length > length) throw new Error(`fixture 字段超长：${text.length} > ${length}：${text}`);
  return text + PAD.repeat(length - text.length);
}

const L = {
  title: 24, source: 10, summary: 66, implication: 72, unknown: 48, excerpt: 160,
  judgment: 60, reason: 40, decision: 48, option: 12,
  anchorTitle: 18, anchorMaterial: 100, anchorSource: 20, phase: 24,
};

function anchor(id, title, material, fields) {
  return { id, title: pad(title, L.anchorTitle), material: pad(material, L.anchorMaterial), source: pad('公司本体 · 战略锚点', L.anchorSource), fields };
}

function signal(values) {
  const {
    id, title, source, publishedAt, collectedAt, anchorId, anchorSnapshot,
    summary, implication, unknown, excerpt, url, score, read = false, saved = false,
    dismissed = false, issue,
  } = values;
  return {
    id, title: pad(title, L.title), url, source: pad(source, L.source),
    publishedAt, collectedAt, anchorId, anchorSnapshot,
    excerpt: pad(excerpt, L.excerpt), summary: pad(summary, L.summary),
    implication: pad(implication, L.implication), unknown: pad(unknown, L.unknown),
    score, read, saved, dismissed, issue,
  };
}

function issue(values) {
  const { title, judgment, options, fields, urgency, reason, status, decision } = values;
  return {
    title: pad(title, L.title), judgment: pad(judgment, L.judgment),
    options: options.map(option => pad(option, L.option)), fields, urgency, reason: pad(reason, L.reason),
    status, ...(decision ? { decision: pad(decision, L.decision) } : {}),
  };
}

const anchorLighthouse = anchor('anchor-fixture-lh', '灯塔客户持续使用', '客户连续使用与 DRI 参与闭环构成灯塔项目当前的监测基线。', ['lighthouse']);
const anchorTokenops = anchor('anchor-fixture-tp', 'TokenOps 采购意愿', '真实用量样本中的节省价值与客户付费意愿构成 TokenOps 的监测基线。', ['tokenops']);

/** 构建等长 RadarState。每次调用返回独立副本，方便 mock 在交互后做变更。 */
export function buildRadarFixture() {
  const ontology = [
    { id: 'ontology-fixture-outcome', title: '公司级 Outcome', material: '验证持续使用，以及从共识到负责人行动的闭环。', scope: '公司目标' },
    { id: 'ontology-fixture-lighthouse', title: '灯塔项目 · 当前 Mission', material: '跑通内部真实使用，并明确客户持续使用和 DRI 参与的验证方式。', scope: '经营验证' },
    { id: 'ontology-fixture-tokenops', title: 'TokenOps · 当前 Mission', material: '选定真实用量样本，明确节省价值与客户采购意愿的验证口径。', scope: '商业验证' },
    { id: 'ontology-fixture-capacity', title: '关键资源约束', material: '公司同时推进灯塔项目和 TokenOps，交付力量有限，需要持续识别会改变投入次序的外部变化。', scope: '公司能力' },
  ];
  return {
    version: 2,
    ontology,
    anchors: [anchorLighthouse, anchorTokenops],
    sources: [
      { id: 'source-fixture-a', title: pad('示例行业研报源', L.title), url: 'https://fixture.example.com/research' },
      { id: 'source-fixture-b', title: pad('示例客户通讯源', L.title), url: 'https://fixture.example.com/newsletter' },
    ],
    signals: [
      signal({
        id: 'signal-fixture-001',
        title: '某行业报告下调智能体交付预算',
        source: '行业研报',
        publishedAt: '2026-09-14T18:20:00+08:00',
        collectedAt: '2026-09-15T08:05:00+08:00',
        anchorId: anchorLighthouse.id, anchorSnapshot: anchorLighthouse,
        summary: '报告认为企业将推迟部分智能体交付预算，转向验证真实使用与可核验的经营结果。',
        implication: '灯塔项目以客户持续使用为验证目标的方向未被动摇，但外部预算节奏可能影响客户投入。',
        unknown: '客户本季度预算是否实际调整，以及调整幅度，尚未获得客户侧确认。',
        excerpt: '报告原文摘录：多家受访企业表示将在下一预算周期重新评估智能体采购规模，优先保留已经验证真实使用的项目，压缩尚未形成闭环的试点。',
        url: 'https://fixture.example.com/research/signal-001',
        score: 91,
        issue: issue({
          title: '客户预算调整是否影响灯塔验证目标', judgment: '先确认客户本季度预算是否实际调整，再判断验证目标是否需要修改。',
          options: ['维持目标', '收窄范围', '暂缓验证'], fields: ['lighthouse'], urgency: 'red',
          reason: '预算窗口两周内关闭，需要尽快决定是否调整验证范围。', status: 'pending',
        }),
      }),
      signal({
        id: 'signal-fixture-002',
        title: '某云厂商发布用量计费折扣方案',
        source: '厂商公告',
        publishedAt: '2026-09-14T11:40:00+08:00',
        collectedAt: '2026-09-15T08:06:00+08:00',
        anchorId: anchorTokenops.id, anchorSnapshot: anchorTokenops,
        summary: '厂商宣布对承诺用量客户提供阶梯折扣，可能改变 TokenOps 节省口径的对比基线。',
        implication: '节省价值的验证口径需要把折扣纳入对比，否则客户看到的节省与实际账单不一致。',
        unknown: '折扣适用条件与客户实际用量分布，需要真实样本才能核对。',
        excerpt: '公告原文摘录：自下月起，承诺用量的客户可按季度承诺量获得阶梯折扣，折扣幅度随承诺量递增，适用于全部按量计费产品线。',
        url: 'https://fixture.example.com/newsletter/signal-002',
        score: 74, read: true,
        issue: issue({
          title: '折扣方案是否纳入节省口径基线', judgment: '把折扣后的账单作为节省对比基线，避免客户感知与实际支出不一致。',
          options: ['纳入基线', '维持原口径', '暂不调整'], fields: ['tokenops'], urgency: 'yellow',
          reason: '口径影响本月样本采集，需要在下一次采样前确认。', status: 'pending',
        }),
      }),
      signal({
        id: 'signal-fixture-003',
        title: '两家同行同时推进经营与优化',
        source: '客户通讯',
        publishedAt: '2026-09-13T17:05:00+08:00',
        collectedAt: '2026-09-15T08:07:00+08:00',
        anchorId: 'anchor-fixture-lh', anchorSnapshot: anchorTokenops,
        summary: '同行同时布局经营智能体与用量优化，可能同时影响灯塔与 TokenOps 的比较优势。',
        implication: '两个战场同时受到挤压时，资源取舍需要升级为公司级议题统一判断。',
        unknown: '同行方案的交付能力与客户重合度尚未核验。',
        excerpt: '通讯原文摘录：两家公司分别公布了面向企业客户的经营助手与成本优化方案，均计划在第四季度完成首批客户交付并公开对比数据。',
        url: 'https://fixture.example.com/newsletter/signal-003',
        score: 82, read: true, saved: true,
        issue: issue({
          title: '同行双线推进是否改变资源排序', judgment: '先核对同行交付能力与客户重合度，再决定是否调整两个战场的投入排序。',
          options: ['维持排序', '调整倾斜', '升级战略'], fields: ['lighthouse', 'tokenops'], urgency: 'yellow',
          reason: '两家动作同期发生，牵动两个战场的共同资源。', status: 'pending',
        }),
      }),
      signal({
        id: 'signal-fixture-004',
        title: '某协会发布智能体应用守则草案',
        source: '行业研报',
        publishedAt: '2026-09-12T09:30:00+08:00',
        collectedAt: '2026-09-15T08:08:00+08:00',
        anchorId: anchorLighthouse.id, anchorSnapshot: anchorLighthouse,
        summary: '协会草案提出企业应用智能体的披露建议，当前不构成强制要求。',
        implication: '草案与灯塔验证目标无直接冲突，暂不需要进入决策面。',
        unknown: '正式版是否增加强制条款，需要持续观察。',
        excerpt: '草案原文摘录：建议企业在对外材料中说明智能体参与生产的范围与人工复核方式，目前以自律为主，不设置强制合规要求。',
        url: 'https://fixture.example.com/research/signal-004',
        score: 45,
      }),
      signal({
        id: 'signal-fixture-005',
        title: '某客户公开续约并扩大使用范围',
        source: '客户通讯',
        publishedAt: '2026-09-11T15:10:00+08:00',
        collectedAt: '2026-09-15T08:09:00+08:00',
        anchorId: anchorLighthouse.id, anchorSnapshot: anchorLighthouse,
        summary: '一家客户公开续约并扩大使用范围，与灯塔项目的持续使用验证方向一致。',
        implication: '属于支持现有验证目标的正面证据，不需要单独行动。',
        unknown: '该客户续约动因与灯塔客户群体是否可比，尚未核对。',
        excerpt: '通讯原文摘录：该客户宣布续约一年，并把经营助手从单一部门扩展到三个部门使用，同时开始按季度复盘使用数据。',
        url: 'https://fixture.example.com/newsletter/signal-005',
        score: 58, read: true, saved: true,
      }),
      signal({
        id: 'signal-fixture-006',
        title: '某论坛讨论智能体替换人力话题',
        source: '厂商公告',
        publishedAt: '2026-09-10T20:45:00+08:00',
        collectedAt: '2026-09-15T08:10:00+08:00',
        anchorId: anchorTokenops.id, anchorSnapshot: anchorTokenops,
        summary: '论坛讨论聚焦智能体替代人力的叙事，缺少可核验数据，与公司议题无直接关系。',
        implication: '叙事性内容不满足确定性门槛，已按规则排除在阅读列表之外。',
        unknown: '无需进一步跟进。',
        excerpt: '论坛原文摘录：多位发言人围绕智能体是否替代岗位展开讨论，观点分歧明显，没有给出可核对的数据或客户案例。',
        url: 'https://fixture.example.com/newsletter/signal-006',
        score: 21, read: true, dismissed: true,
      }),
      signal({
        id: 'signal-fixture-007',
        title: '某客户确认季度用量承诺框架',
        source: '客户通讯',
        publishedAt: '2026-09-09T10:15:00+08:00',
        collectedAt: '2026-09-15T08:11:00+08:00',
        anchorId: anchorTokenops.id, anchorSnapshot: anchorTokenops,
        summary: '一家客户确认按季度承诺用量的采购框架，TokenOps 节省口径获得首个真实样本来源。',
        implication: '样本来源成立，采样口径决定结果可信度，此前已完成判断。',
        unknown: '样本是否覆盖典型账单结构，由采样结果说明。',
        excerpt: '通讯原文摘录：客户确认下一季度起按承诺量计费，并同意提供脱敏账单用于节省核对，覆盖当前全部按量产品线。',
        url: 'https://fixture.example.com/newsletter/signal-007',
        score: 88, read: true,
        issue: issue({
          title: '首个用量样本是否采用季度承诺口径', judgment: '采用季度承诺口径作为首个采样基线，并把折扣账单纳入对比。',
          options: ['季度口径', '月度口径', '混合口径'], fields: ['tokenops'], urgency: 'yellow',
          reason: '客户窗口期明确，采样必须在承诺周期开始前定口径。', status: 'closed',
          decision: '采用季度承诺口径，并把折扣账单纳入节省对比。',
        }),
      }),
    ],
    run: {
      status: 'done',
      phase: pad('扫描完成，发现 12 条，新增 7 条', L.phase),
      startedAt: '2026-09-15T08:00:00+08:00',
      finishedAt: '2026-09-15T08:12:00+08:00',
      found: 12, added: 7, promoted: 3, warnings: [],
    },
  };
}

/** mock 后端动作语义，与旧 API 的可见行为保持一致（只覆盖截图需要的部分）。 */
export function applyRadarAction(state, body) {
  const signalItem = state.signals.find(item => item.id === body.id);
  switch (body.action) {
    case 'read': if (signalItem) signalItem.read = true; break;
    case 'save': if (signalItem) signalItem.saved = !signalItem.saved; break;
    case 'dismiss': if (signalItem) signalItem.dismissed = !signalItem.dismissed; break;
    case 'configuration':
      if (Array.isArray(body.anchors)) state.anchors = body.anchors;
      if (Array.isArray(body.sources)) state.sources = body.sources;
      break;
    default: break; // scan 等其余动作在截图流程中不改变状态。
  }
  return state;
}

/**
 * 战场背面 Agent 完成度评估的固定 mock。
 * 形状必须与 MissionAssessment 完全一致（source/assessedAt/percent/simplePercent/
 * completed/total/rationale/items），且 items 必须覆盖该战场全部 Mission id，
 * 否则旧组件会在评估渲染时崩溃。
 */
export function progressFixture(zone) {
  if (zone === 'lighthouse') {
    return {
      source: '9 月 Mission 演练快照 v1 · 尚未连接正式 Mission 台账',
      assessedAt: '2026-09-15T08:30:00+08:00',
      percent: 48, simplePercent: 33, completed: 1, total: 3,
      rationale: '内部独立使用已验收；客户持续使用有一半证据，DRI 参与尚未启动，加权后完成度约一半。',
      items: [
        { id: 'lh-use', weight: 3, completion: 100, reason: '内部使用者已独立完成真实事项探索，本项已验收。' },
        { id: 'lh-return', weight: 5, completion: 55, reason: '客户使用安排已有部分确认，持续行为证据仍缺。' },
        { id: 'lh-dri', weight: 4, completion: 0, reason: '客户参与人选未确认，本项尚未启动。' },
      ],
    };
  }
  if (zone === 'tokenops') {
    return {
      source: '9 月 Mission 演练快照 v1 · 尚未连接正式 Mission 台账',
      assessedAt: '2026-09-15T08:31:00+08:00',
      percent: 30, simplePercent: 0, completed: 0, total: 2,
      rationale: '三组样本已核验两组，采购意愿反馈尚未返回，整体完成度仍以样本核验为主。',
      items: [
        { id: 'to-sample', weight: 4, completion: 67, reason: '两组样本完成核验，第三组结果尚未返回。' },
        { id: 'to-buy', weight: 5, completion: 0, reason: '采购访谈未返回，采购意愿暂无证据。' },
      ],
    };
  }
  throw new Error(`fixture 没有这个战场的评估：${zone}`);
}

/** 对话 mock 回复。文本固定，长度固定。 */
export const chatFixture = {
  text: '已收到。当前交付力量集中在灯塔与 TokenOps 两条线；建议先明确本周期各自必须取得的验证证据，再决定取舍。',
  ms: 4213,
};
