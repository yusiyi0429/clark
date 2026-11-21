// Synthetic data only. No production records, credentials, or network calls.
export const fixtureTime = '2026-11-15T04:00:00.000Z';
const at = (clock) => `2026-11-15T${clock}:00.000Z`;
const file = (id, fileName) => ({ id, fileName, size: 24576, sha256: 'abc12345'.repeat(8), href: `/api/fixture-only/files/${id}` });
const reply = (id, status, text, attachments = []) => ({ id, status, text, attachments, createdAt: at('03:20') });
export const sentDelivery = {
  id: 'fixture-team-sent', kind: 'question', text: '请核对伙伴工作间的交接清单：哪些已经完成，哪些需要补材料？请在今天下班前回复，并注明需要谁继续推进。',
  sender: { personId: 'fixture-me', displayName: '我（示例）' }, createdAt: at('02:00'), dueAt: at('10:00'),
  sourceUrl: 'https://example.com/fixture-only/brief', attachments: [file('fixture-brief', '示例交接清单.pdf')],
  recipients: [
    { personId: 'fixture-lan', displayName: '小岚（示例）', status: 'answered', error: null, replies: [
      reply('fixture-lan-1', 'answered', '已核对资料和负责人。会议纪要中的三处变化已经标注，请查看附件。', [file('fixture-review', '示例核对结果.txt')]),
      reply('fixture-lan-2', 'clarification', '补充说明：只需要确认本轮变化，后续计划保留在原项目中。'),
    ] },
    { personId: 'fixture-chen', displayName: '小辰（示例）', status: 'needs_info', error: null, replies: [reply('fixture-chen-1', 'needs_info', '还缺预算边界和最新一版验收标准，请补充后我继续。')] },
    { personId: 'fixture-he', displayName: '小禾（示例）', status: 'failed', error: '示例错误：对方的接收通道暂时不可用，请稍后重试。', replies: [] },
    { personId: 'fixture-yu', displayName: '小予（示例）', status: 'pending', error: null, replies: [] },
  ],
};
export const incomingDelivery = {
  ...sentDelivery, id: 'fixture-team-incoming', text: '这份示例方案还缺哪些材料？请给出你的意见；如果没有足够信息，可以直接请求补充。',
  sender: { personId: 'fixture-lan', displayName: '小岚（示例）' },
  recipients: [{ personId: 'fixture-me', displayName: '我（示例）', status: 'needs_info', error: null,
    replies: [reply('fixture-my-question', 'needs_info', '我需要补充用户范围和本轮截止时间。'), reply('fixture-their-answer', 'clarification', '范围只包括内部协作，截止时间为今天18:00。')] }],
};
const meeting = (id, title, extra) => ({ id: `meeting:${id}`, meetingId: id, title, at: at('02:30'), stage: 'scheduled', statusText: '已预约',
  needsAction: false, source: 'tianshu', href: `/me/work/meetings/${id}`, joinUrl: null, ...extra });
export const meetings = [
  meeting('fixture-schedule', '明天 · 示例评审安排', { at: '2026-11-16T01:30:00.000Z', stage: 'scheduled', joinUrl: 'https://example.com/fixture-only/join' }),
  meeting('fixture-live', '伙伴工作间 · 示例协作会', { stage: 'live', statusText: '会议进行中', joinUrl: 'https://example.com/fixture-only/live' }),
  meeting('fixture-confirm', '示例方案评审 · 待本人确认', { at: at('01:30'), stage: 'ready', statusText: '有 2 处变化等你确认', needsAction: true,
    recordHref: '/api/fixture-only/meeting-record', sourceUrl: 'https://example.com/fixture-only/minutes', preflightText: '会前材料已齐备（示例）' }),
  meeting('fixture-processing', '示例复盘 · 正在整理记录', { at: at('01:00'), stage: 'processing', statusText: '记录正在整理，尚未进入确认' }),
  meeting('fixture-minute', '未关联的示例妙记', { id: 'feishu-minute:fixture-minute', meetingId: null, source: 'feishu', stage: 'unmatched',
    statusText: '需要整理到已有会议或新会议', needsAction: true, href: '/me/work/partner#minute-fixture-minute', sourceUrl: 'https://example.com/fixture-only/minute' }),
];
const target = (id, kind = 'task') => ({ kind, projectId: 'fixture-project', id });
export const targets = [
  { ...target('fixture-current'), projectName: '示例项目', name: '本轮交接清单' },
  { ...target('fixture-next', 'topic'), projectName: '示例项目', name: '需要继续讨论的边界' },
];
const conclusion = (id, question, value, minute) => ({ confirmationRef: `fixture-confirmation-${id}`, requestId: `fixture-request-${id}`, itemId: `fixture-change-${id}`,
  meetingId: 'fixture-meeting', revision: 2, confirmedAt: at(minute), confirmedBy: 'fixture-me', decision: 'confirmed', question,
  content: { classification: 'fact', targetRef: 'fixture-current', value },
  source: { id: 'fixture-source', version: 'v2', hash: 'fixture-hash-only', minutesRef: 'https://example.com/fixture-only/minutes',
    quote: '示例摘录：先把已确认的变化交给现有工作，再核对递送回执。', readState: 'excerpt', reference: null, turnId: null } });
const receipt = (id, status, destination, extra = {}) => ({ id, target: destination, status, instruction: '请沿用现有工作继续核对本轮变化（示例）。',
  reason: status === 'failed' ? '示例错误：权限已经变化，尚未递送。' : null, authorizedAt: at('03:00'), deliveredAt: status === 'delivered' ? at('03:01') : null, ...extra });
export const handoffs = [
  { conclusion: conclusion('mixed', '哪些变化已经交接，哪些还需要处理？', '已确认：保留当前项目，补齐验收证据后继续推进。', '03:00'),
    receipts: [receipt('fixture-receipt-done', 'delivered', target('fixture-current')), receipt('fixture-receipt-pending', 'pending', target('fixture-next', 'topic')),
      receipt('fixture-receipt-failed', 'failed', target('fixture-unavailable'))] },
  { conclusion: conclusion('history', '已经交给归档工作的内容还能在哪里看？', '已确认的历史交接仍保留原工作链接（示例）。', '02:50'),
    receipts: [receipt('fixture-receipt-history', 'delivered', target('fixture-retired', 'card'))] },
  { conclusion: conclusion('new', '这一轮是否继续推进？', '已确认：请在既有工作中补齐下一轮材料。尚未选择递送去向。', '02:40'), receipts: [] },
];
const intake = (id, state, message, extra = {}) => ({ id, scope: 'global', state, message, priority: false, error: null, createdAt: at('03:30'), updatedAt: at('03:30'), ...extra });
export const queue = [
  intake('fixture-queue-failed', 'failed', '请核对本轮会议材料与交接去向，并保留未确认的证据。', { error: '示例错误：尚未收到服务端回执。' }),
  intake('fixture-queue-sending', 'sending', '请读取示例清单，先列出已经接下的事项和需要我补充的材料。'),
  intake('fixture-queue-first', 'queued', '这件优先处理：补齐示例验收标准。', { priority: true }),
  intake('fixture-queue-normal', 'queued', '这是一条较长的示例需求，用来检查完整正文是否保留。请在本轮工作完成后整理剩余问题，逐条说明负责人、证据和下一步；不要把已经递送误认为已经完成验收。'.repeat(2)),
];
const sub = (id, title, extra = {}) => ({ id, title, kind: 'card', letter: 'A', state: 'waiting', waiting: null, stopWhy: 'turn_done', unseen: false,
  queueReason: null, role: null, sessionId: null, deviceId: null, autoStart: false, updatedAt: at('03:50'), merge: null, holdUntil: null, ...extra });
export const projects = [{ id: 'fixture-project', name: '伙伴工作间（示例项目）', subSessions: [
  sub('fixture-running', '核对交接清单', { state: 'running' }), sub('fixture-failed', '验收证据需要重做', { state: 'failed', letter: 'B' }),
  sub('fixture-wait', '等你补充预算边界', { waiting: 'needs_person', letter: 'C' }), sub('fixture-done', '已验收并合回', { state: 'done', letter: 'D' }),
  sub('fixture-queued', '下一轮示例任务', { state: 'queued', letter: 'E', queueReason: 'folder_busy', heldBy: { id: 'fixture-running', kind: 'card', letter: 'A', title: '核对交接清单' } }),
] }];
