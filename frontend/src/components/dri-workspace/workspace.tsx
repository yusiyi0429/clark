'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowUp,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  FileCheck2,
  FileText,
  Link2,
  MessageCircle,
  Mic,
  Pause,
  Radio,
  RefreshCw,
  Send,
  Sparkles,
  Target,
} from 'lucide-react';
import { TianshuMark } from '@/components/brand/tianshu-mark';
import { LockScreenButton } from '@/components/log-out-button';
import {
  createReviewComment,
  driWorkspaceFixture,
  routeMeetingPublication,
  unansweredProgressQuestions,
  type DriNoticeId,
  type DriWorkspaceGateway,
  type MeetingActionDraft,
  type ReviewAnchor,
  type ReviewComment,
  type WeeklySignal,
} from './model';
import s from './workspace.module.css';

type AgentMessage = { id: string; role: 'agent' | 'human'; body: string };
type MeetingStage = 'scheduled' | 'recording' | 'extracting' | 'review' | 'published';

const anchorLabels: Record<ReviewAnchor, string> = {
  outcome: '本月 PCO',
  mission: '当前 Mission',
  'success-evidence': '成功证据',
  milestone: '关键里程碑',
  boundary: '责任与交付边界',
};

const signalLabels: Record<WeeklySignal, string> = { green: '绿', yellow: '黄', red: '红' };

function countdownTo(endsAt: string, now: Date | null) {
  if (!now) return '正在校时';
  const remaining = new Date(endsAt).getTime() - now.getTime();
  if (remaining <= 0) return '反馈窗口已关闭';
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return hours >= 24 ? `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后关闭` : `${hours} 小时 ${minutes} 分钟后关闭`;
}

function ClockCapsule({ now }: { now: Date | null }) {
  return (
    <div className={s.railClock}>
      <button type="button" className={s.homeCapsule} aria-label="天枢 DRI 工作面">
        <TianshuMark className={s.clockLogo} />
        <span>{now?.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</span>
        <small>{now?.toLocaleDateString('zh-CN', { weekday: 'short' })}</small>
        <time>{now?.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}</time>
      </button>
      <LockScreenButton compact className={s.railLock} />
    </div>
  );
}

function NotificationRail({
  active,
  onSelect,
  now,
  countdown,
  meetingStage,
}: {
  active: DriNoticeId;
  onSelect: (id: DriNoticeId) => void;
  now: Date | null;
  countdown: string;
  meetingStage: MeetingStage;
}) {
  const notices: Array<{
    id: DriNoticeId;
    eyebrow: string;
    title: string;
    detail: string;
    tone: string;
    icon: React.ReactNode;
  }> = [
    {
      id: 'mission-review',
      eyebrow: '月初协商 · 待处理',
      title: '核对 9 月 Mission Draft',
      detail: countdown,
      tone: 'monthly',
      icon: <Target size={17} />,
    },
    {
      id: 'weekly-review',
      eyebrow: '本周进展 · 待确认',
      title: 'Agent 已先读取 3 类来源',
      detail: '还剩 1 个未被资料回答的问题',
      tone: 'progress',
      icon: <FileCheck2 size={17} />,
    },
    {
      id: 'ceo-return',
      eyebrow: 'CEO Review · 已返回',
      title: '3 处语义调整待核对',
      detail: '只看改动，不重读整份 Mission Card',
      tone: 'review',
      icon: <MessageCircle size={17} />,
    },
    {
      id: 'meeting',
      eyebrow: meetingStage === 'recording' ? '会议进行中 · 正在录音' : '今天 16:30 · 你是主责 DRI',
      title: 'CEO / DRI 核心体验对齐',
      detail: meetingStage === 'published' ? '结果已分流到对应通知栏' : '由 DRI 开启会议并核对结果',
      tone: 'meeting',
      icon: <CalendarDays size={17} />,
    },
  ];

  return (
    <aside className={s.rail} aria-label="孙铭泽的通知">
      <ClockCapsule now={now} />
      <div className={s.noticeList}>
        {notices.map((notice) => (
          <button
            key={notice.id}
            type="button"
            className={s.noticeCard}
            data-tone={notice.tone}
            data-selected={active === notice.id}
            aria-pressed={active === notice.id}
            onClick={() => onSelect(notice.id)}
          >
            <span className={s.noticeIcon}>{notice.icon}</span>
            <span className={s.noticeCopy}>
              <span>{notice.eyebrow}</span>
              <strong>{notice.title}</strong>
              <small>{notice.detail}</small>
            </span>
            <ChevronRight size={16} className={s.noticeArrow} />
          </button>
        ))}
      </div>
      <p className={s.railFoot}>页面样例 · 处理结果仅保存在当前页面</p>
    </aside>
  );
}

function MissionDocument({
  selectedMissionId,
  onSelectMission,
  comments,
}: {
  selectedMissionId: string;
  onSelectMission: (id: string) => void;
  comments: ReviewComment[];
}) {
  const data = driWorkspaceFixture;
  const mission = data.missions.find((item) => item.id === selectedMissionId) ?? data.missions[0];
  const missionComments = comments.filter((comment) => comment.targetId === mission.id || comment.targetId === data.companyOutcome.id);

  return (
    <section className={s.documentPane} aria-label="Mission Draft 信息">
      <div className={s.documentTopline}>
        <span>{data.companyOutcome.version}</span>
        <span>{data.reviewWindow.candidateVersion}</span>
      </div>
      <div className={s.outcomeBlock}>
        <span>本月公司 Outcome</span>
        <h1>{data.companyOutcome.title}</h1>
        <p>{data.companyOutcome.context}</p>
      </div>
      <div className={s.anchorBlock}>
        <span>我的价值锚点</span>
        <p>{data.personalAnchor}</p>
      </div>
      <div className={s.missionTabs} aria-label="选择 Mission">
        {data.missions.map((item) => (
          <button key={item.id} type="button" data-active={item.id === mission.id} onClick={() => onSelectMission(item.id)}>
            <span>{item.priority}</span>
            <strong>{item.title}</strong>
            <small>{item.reviewState === 'reviewed' ? '已提交意见' : '待核对'} · {item.version}</small>
          </button>
        ))}
      </div>
      <article className={s.missionCard}>
        <div className={s.missionTitleRow}>
          <div><span>{mission.priority} · {mission.version}</span><h2>{mission.title}</h2></div>
          <div className={s.readOnlyPill}><FileText size={13} />只读草稿</div>
        </div>
        <section className={s.missionLead}><span>Mission Outcome</span><p>{mission.outcome}</p></section>
        <div className={s.missionGrid}>
          <section><span>Why</span><p>{mission.why}</p></section>
          <section><span>Success Evidence</span><ul>{mission.successEvidence.map((item) => <li key={item}>{item}</li>)}</ul></section>
        </div>
        <section className={s.milestoneSection}>
          <span>Key Milestones</span>
          <div className={s.milestones}>
            {mission.milestones.map((item) => (
              <div key={item.date} data-state={item.state}>
                <i><Check size={11} /></i><time>{item.date}</time><p>{item.label}</p>
              </div>
            ))}
          </div>
        </section>
        <details className={s.documentDetails}>
          <summary>依赖与边界 <ChevronRight size={14} /></summary>
          <div><span>Key Dependencies</span>{mission.dependencies.map((item) => <p key={item}>{item}</p>)}</div>
          <div><span>Boundary</span>{mission.boundary.map((item) => <p key={item}>{item}</p>)}</div>
        </details>
      </article>
      <section className={s.commentLedger}>
        <div className={s.sectionLabel}><span>Review Record</span><small>独立于原始草稿</small></div>
        {missionComments.length ? missionComments.map((comment) => (
          <article key={comment.id}>
            <div><strong>{comment.authorName}</strong><span>{anchorLabels[comment.anchor]} · 修订 {comment.revision}</span></div>
            <p>{comment.body}</p>
            <small>{comment.targetVersion} · {new Date(comment.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>
          </article>
        )) : <p className={s.emptyState}>这条 Mission 尚无已发布意见。右侧对话不会自动写入这里。</p>}
      </section>
    </section>
  );
}

function MissionConversation({
  missionId,
  comments,
  onPublish,
  reviewOpen,
}: {
  missionId: string;
  comments: ReviewComment[];
  onPublish: (comment: ReviewComment) => void;
  reviewOpen: boolean;
}) {
  const data = driWorkspaceFixture;
  const mission = data.missions.find((item) => item.id === missionId) ?? data.missions[0];
  const [messages, setMessages] = useState<AgentMessage[]>([
    { id: 'agent-opening', role: 'agent', body: '我已经读过本月 PCO、这条 Mission 和现有 Review Record。你可以先验证成功证据、里程碑或责任边界。' },
  ]);
  const [input, setInput] = useState('');
  const [anchor, setAnchor] = useState<ReviewAnchor>('mission');
  const [draft, setDraft] = useState('');
  const [receipt, setReceipt] = useState('');

  function ask(text?: string) {
    const question = (text ?? input).trim();
    if (!question) return;
    const reply = question.includes('证据')
      ? '现有证据里最需要收紧的是“真实使用”。建议明确谁使用、完成哪条工作路径、留下什么可复核记录；页面或功能数量不能作为替代。'
      : question.includes('边界')
        ? '这条 Mission 的边界已基本清楚。需要特别保留：DRI 侧复用 CEO 侧产品语言，不另建 Action Item 中心；P0 与 P1 冲突时优先 P0。'
        : '从现有资料看，这不是执行动作是否充分的问题，而是月底结果能否被第三方复核。建议把意见锚定到具体字段，再由你决定是否正式发布。';
    setMessages((previous) => [
      ...previous,
      { id: `human-${previous.length}`, role: 'human', body: question },
      { id: `agent-${previous.length + 1}`, role: 'agent', body: reply },
    ]);
    if (!draft) {
      setAnchor('success-evidence');
      setDraft('请将“完成交互”收紧为真实 DRI 能完成一条从承接 Outcome、推进问题到正式 Review 的路径，并保留可复核证据。');
    }
    setInput('');
  }

  function publish() {
    if (!draft.trim() || !reviewOpen) return;
    const targetId = anchor === 'outcome' ? data.companyOutcome.id : mission.id;
    const targetVersion = anchor === 'outcome' ? data.companyOutcome.version : mission.version;
    const comment = createReviewComment({
      authorName: data.actor.name,
      body: draft,
      anchor,
      targetId,
      targetVersion,
      previousComments: comments,
      createdAt: new Date().toISOString(),
    });
    onPublish(comment);
    setDraft('');
    setReceipt(`已发布修订 ${comment.revision}。原始 ${targetVersion} 未被改写。`);
  }

  return (
    <aside className={s.conversationPane} aria-label="与 Mission Agent 对话">
      <div className={s.agentHead}>
        <span className={s.agentMark}><Sparkles size={17} /></span>
        <div><strong>你的 Mission Agent</strong><small>先私下推演，再由你正式发布</small></div>
        <span className={s.privatePill}>私人草稿</span>
      </div>
      <div className={s.contextReceipt}><Link2 size={14} /><span>已读 PCO、{mission.version}、现有 Comments</span></div>
      <div className={s.agentMessages}>
        {messages.slice(-6).map((message) => <p key={message.id} data-role={message.role}>{message.body}</p>)}
      </div>
      <div className={s.quickPrompts}>
        <button type="button" onClick={() => ask('成功证据够清楚吗？')}>检查成功证据</button>
        <button type="button" onClick={() => ask('责任边界有没有重叠？')}>检查责任边界</button>
      </div>
      <form className={s.chatComposer} onSubmit={(event) => { event.preventDefault(); ask(); }}>
        <textarea rows={2} value={input} onChange={(event) => setInput(event.target.value)} placeholder="围绕这条 Mission 继续讨论…" aria-label="与 Mission Agent 对话" />
        <button type="submit" disabled={!input.trim()} aria-label="发送"><ArrowUp size={17} /></button>
      </form>
      <div className={s.publishDesk}>
        <div className={s.publishLabel}><span>准备发布的 Comment</span><small>不会直接修改原文件</small></div>
        <select value={anchor} onChange={(event) => setAnchor(event.target.value as ReviewAnchor)} aria-label="Comment 关联位置">
          {Object.entries(anchorLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <textarea rows={4} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Agent 的建议会先出现在这里，确认后才进入 Review Record。" aria-label="Comment 草稿" />
        <button type="button" className={s.primaryDarkButton} onClick={publish} disabled={!draft.trim() || !reviewOpen}><Send size={14} />确认并发布</button>
        {receipt && <p className={s.darkReceipt} role="status"><Check size={13} />{receipt}</p>}
      </div>
    </aside>
  );
}

function WeeklyReview({ gateway }: { gateway?: DriWorkspaceGateway }) {
  const data = driWorkspaceFixture;
  const weekly = data.weekly;
  const [signal, setSignal] = useState<WeeklySignal>(weekly.signal);
  const [answer, setAnswer] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [messages, setMessages] = useState<AgentMessage[]>([
    { id: 'progress-agent-1', role: 'agent', body: '我先读取了 Mission Card、本周复盘和可见的 Codex 工作上下文。已有事实足够生成周复盘，只剩一个会改变判断的问题。' },
  ]);
  const missing = unansweredProgressQuestions(weekly.questions.map((question) => ({ ...question, answer })));

  function refreshSources() {
    setSyncing(true);
    window.setTimeout(() => setSyncing(false), 850);
    void gateway?.dispatch({ type: 'progress.sources.refresh', actorId: data.actor.id, missionIds: data.missions.map((mission) => mission.id) });
  }

  function sendAnswer() {
    if (!answer.trim()) return;
    setMessages((previous) => [
      ...previous,
      { id: `progress-human-${previous.length}`, role: 'human', body: answer.trim() },
      { id: `progress-agent-${previous.length + 1}`, role: 'agent', body: '收到。我会把这条作为人工确认事实保留来源，并重新判断里程碑；不会把“已有方案”误写成“已经验收”。' },
    ]);
  }

  function confirmReview() {
    if (!answer.trim()) return;
    setConfirmed(true);
    void gateway?.dispatch({ type: 'progress.weekly.confirm', signal, answer: answer.trim() });
  }

  return (
    <div className={s.twoPane}>
      <section className={s.progressPane}>
        <div className={s.progressHeading}>
          <div><span>9 月 Mission · 周进展</span><h1>{weekly.period}</h1></div>
          <div className={s.signalChoice} aria-label="本周状态">
            {(['green', 'yellow', 'red'] as WeeklySignal[]).map((value) => <button type="button" key={value} data-active={signal === value} data-signal={value} onClick={() => setSignal(value)}>{signalLabels[value]}</button>)}
          </div>
        </div>
        <div className={s.judgmentCard} data-signal={signal}>
          <span>本周总体判断 · {signalLabels[signal]}</span>
          <p>{weekly.headline}</p>
          <small>{weekly.caveat}</small>
        </div>
        <section className={s.progressTrack}>
          <div className={s.sectionLabel}><span>结果路径</span><small>不用百分比，只看证据状态</small></div>
          {weekly.milestones.map((item) => (
            <article key={item.label} data-state={item.state}>
              <i>{item.state === 'verified' ? <Check size={12} /> : <Circle size={9} />}</i>
              <div><strong>{item.label}</strong><small>{item.evidence}</small></div>
              <span>{item.state === 'verified' ? '已有证据' : item.state === 'current' ? '当前节点' : '尚未开始'}</span>
            </article>
          ))}
        </section>
        <div className={s.reviewSections}>
          <section><span>关键进展与 Evidence</span>{weekly.advances.map((item) => <p key={item}>{item}</p>)}<small>来源：{weekly.evidence.join('、')}</small></section>
          <section><span>最重要的问题及 Why</span><p>{weekly.problem}</p></section>
          <section><span>判断变化 / Implication</span><p>{weekly.implication}</p></section>
          <section><span>当前处理</span><p>{weekly.handling}</p></section>
        </div>
      </section>
      <aside className={s.conversationPane}>
        <div className={s.agentHead}>
          <span className={s.agentMark}><Sparkles size={17} /></span>
          <div><strong>进展 Agent</strong><small>先读取，再只问缺口</small></div>
          <button type="button" className={s.refreshButton} onClick={refreshSources} disabled={syncing}><RefreshCw size={14} className={syncing ? s.spinning : undefined} />{syncing ? '读取中' : '刷新'}</button>
        </div>
        <div className={s.sourceList}>
          {weekly.sources.map((source) => (
            <article key={source.id} data-state={source.state}>
              <i>{source.state === 'read' ? <Check size={11} /> : <Clock3 size={11} />}</i>
              <div><strong>{source.label}</strong><p>{source.detail}</p></div>
              <time>{source.observedAt}</time>
            </article>
          ))}
        </div>
        <div className={s.agentMessages}>
          {messages.map((message) => <p key={message.id} data-role={message.role}>{message.body}</p>)}
        </div>
        <div className={s.gapQuestion} data-resolved={!missing.length}>
          <span>{missing.length ? '唯一未被资料回答的问题' : '信息缺口已补齐'}</span>
          <strong>{weekly.questions[0].prompt}</strong>
          <small>{weekly.questions[0].reason}</small>
        </div>
        <div className={s.answerComposer}>
          <textarea rows={3} value={answer} onChange={(event) => { setAnswer(event.target.value); setConfirmed(false); }} placeholder="直接回答；如有证据链接，可一起粘贴…" aria-label="回答进展缺口" />
          <button type="button" onClick={sendAnswer} disabled={!answer.trim()}><ArrowUp size={16} /></button>
        </div>
        <button type="button" className={s.primaryDarkButton} onClick={confirmReview} disabled={!answer.trim() || confirmed}>{confirmed ? <Check size={14} /> : <FileCheck2 size={14} />}{confirmed ? '本周复盘已确认' : '确认本周复盘'}</button>
        <p className={s.panelFoot}>确认后才写回周复盘；连接与写回由后续接口接管。</p>
      </aside>
    </div>
  );
}

function SemanticReview({ gateway }: { gateway?: DriWorkspaceGateway }) {
  const data = driWorkspaceFixture;
  const [selected, setSelected] = useState(data.semanticDiffs[0].id);
  const [response, setResponse] = useState<'idle' | 'accepted' | 'comment'>('idle');
  const [input, setInput] = useState('');
  const active = data.semanticDiffs.find((diff) => diff.id === selected) ?? data.semanticDiffs[0];

  function respond(next: 'accept' | 'comment') {
    setResponse(next === 'accept' ? 'accepted' : 'comment');
    void gateway?.dispatch({ type: 'review.diff.respond', diffIds: data.semanticDiffs.map((diff) => diff.id), response: next });
  }

  return (
    <div className={s.twoPane}>
      <section className={s.diffPane}>
        <div className={s.diffHeading}>
          <div><span>CEO Agent · Semantic Diff</span><h1>只核对本轮发生的变化</h1></div>
          <small>3 处变化 · 1 条来源评论</small>
        </div>
        <p className={s.diffIntro}>以下是 CEO 对原 Draft 和按时间排列的 DRI Comments 进行 Review 后形成的语义差异，不是直接覆盖后的全文。</p>
        <div className={s.diffList}>
          {data.semanticDiffs.map((diff) => (
            <button key={diff.id} type="button" data-active={selected === diff.id} onClick={() => setSelected(diff.id)}>
              <span data-kind={diff.kind}>{diff.kind === 'adjust' ? '调整' : diff.kind === 'add' ? '新增' : '保留'}</span>
              <div><strong>{diff.scope}</strong><p>{diff.after}</p></div>
              <ChevronRight size={15} />
            </button>
          ))}
        </div>
        <article className={s.diffDetail}>
          <div className={s.diffColumns}>
            <section><span>原 Draft</span><p>{active.before}</p></section>
            <section><span>建议调整后</span><p>{active.after}</p></section>
          </div>
          <div className={s.diffReason}><strong>为什么改</strong><p>{active.rationale}</p><small>{active.source}</small></div>
        </article>
      </section>
      <aside className={s.conversationPane}>
        <div className={s.agentHead}><span className={s.agentMark}><Sparkles size={17} /></span><div><strong>Review Agent</strong><small>解释差异，不替你接受修改</small></div><span className={s.privatePill}>当前差异</span></div>
        <div className={s.agentMessages}>
          <p>这 3 处变化来自同一个核心判断：共同 Outcome 可以重叠，但个人价值锚点、优先级和修正责任必须清楚。</p>
          {input && <p data-role="human">{input}</p>}
        </div>
        <div className={s.quickPrompts}>
          <button type="button" onClick={() => setInput('这项调整会不会扩大我的责任边界？')}>检查责任变化</button>
          <button type="button" onClick={() => setInput('这项变化来自哪条原始 Comment？')}>追溯来源</button>
        </div>
        <div className={s.answerComposer}><textarea rows={4} value={input} onChange={(event) => setInput(event.target.value)} placeholder="先与 Agent 讨论；需要时再提交补充意见…" /><button type="button" disabled={!input.trim()}><ArrowUp size={16} /></button></div>
        <div className={s.reviewDecision}>
          <button type="button" onClick={() => respond('comment')}>形成补充 Comment</button>
          <button type="button" onClick={() => respond('accept')}><Check size={14} />核对完成</button>
        </div>
        {response !== 'idle' && <p className={s.darkReceipt}><Check size={13} />{response === 'accepted' ? '已记录核对完成；等待生成下一版候选稿。' : '已转为补充意见草稿，尚未发布。'}</p>}
        <p className={s.panelFoot}>这里确认的是 Review 结果，不会直接覆盖 Mission Card。</p>
      </aside>
    </div>
  );
}

function MeetingWorkspace({ gateway, stage, setStage }: { gateway?: DriWorkspaceGateway; stage: MeetingStage; setStage: (stage: MeetingStage) => void }) {
  const data = driWorkspaceFixture;
  const [actions, setActions] = useState<MeetingActionDraft[]>(data.meeting.actions.map((action) => ({ ...action })));
  const route = useMemo(() => routeMeetingPublication(actions, [...data.meeting.ceoItems], data.meeting.leadDri), [actions, data.meeting.ceoItems, data.meeting.leadDri]);

  useEffect(() => {
    if (stage !== 'extracting') return;
    const timer = window.setTimeout(() => setStage('review'), 900);
    return () => window.clearTimeout(timer);
  }, [setStage, stage]);

  function start() {
    setStage('recording');
    void gateway?.dispatch({ type: 'meeting.start', meetingId: data.meeting.id, recordingRequested: true });
  }

  function finish() {
    setStage('extracting');
    void gateway?.dispatch({ type: 'meeting.finish', meetingId: data.meeting.id, extractRequested: true });
  }

  function publish() {
    setStage('published');
    void gateway?.dispatch({ type: 'meeting.outcome.publish', meetingId: data.meeting.id, route });
  }

  return (
    <div className={s.twoPane}>
      <section className={s.meetingPane}>
        <div className={s.meetingTime}><span>{data.meeting.time}</span><small>主责 DRI · {data.meeting.leadDri}</small></div>
        <h1>{data.meeting.title}</h1>
        <p className={s.meetingPurpose}>{data.meeting.purpose}</p>
        <div className={s.issueList}><span>本场只解决</span>{data.meeting.issues.map((issue, index) => <article key={issue}><small>0{index + 1}</small><p>{issue}</p></article>)}</div>
        <div className={s.meetingRelation}><Target size={15} /><span>关联 Mission</span><strong>DRI Agent V1 核心体验与真实验证</strong></div>
      </section>
      <aside className={s.meetingControl} data-stage={stage}>
        {stage === 'scheduled' && <><span className={s.meetingGlyph}><Mic size={24} /></span><h2>由主责 DRI 开启</h2><p>开启会议时同时请求录音。CEO 页面不会出现这个按钮。</p><button type="button" onClick={start}><Radio size={15} />开启会议并录音</button><small>已预留 meeting.start / recording.request 接口</small></>}
        {stage === 'recording' && <><span className={s.recordingGlyph}><i /><Mic size={25} /></span><span>会议与录音已开启</span><h2>正在保留讨论上下文</h2><p>录音不会直接成为正式决定，散会后仍由主责 DRI 核对。</p><button type="button" onClick={finish}><Pause size={15} />结束会议并提取</button></>}
        {stage === 'extracting' && <><span className={s.meetingGlyph}><Sparkles size={24} /></span><h2>正在形成核对稿</h2><div className={s.extractSteps}><span><Check size={12} />录音已封存</span><span><RefreshCw size={12} className={s.spinning} />提取总结与行动</span><span><Circle size={8} />预演通知分流</span></div></>}
        {stage === 'review' && <div className={s.meetingReview}>
          <span>会后核对稿</span><h2>{data.meeting.generatedSummary}</h2>
          <div className={s.actionRoutes}>{actions.map((action, index) => <article key={action.id}><p>{action.text}</p><select value={action.ownerName ?? ''} onChange={(event) => setActions((previous) => previous.map((item) => item.id === action.id ? { ...item, ownerName: event.target.value || undefined } : item))}><option value="">未明确 → 本场 DRI</option><option value="孙铭泽">孙铭泽</option><option value="陈溪南">陈溪南</option></select><small>{action.due} · {route.actionNotifications[index].recipientName}</small></article>)}</div>
          <div className={s.ceoRoute}><strong>推送 CEO 确认</strong><p>{data.meeting.ceoItems[0].text}</p><small>{data.meeting.ceoItems[0].whyCeo}</small></div>
          <button type="button" onClick={publish}><Send size={14} />确认并发布会议结果</button>
        </div>}
        {stage === 'published' && <><CheckCircle2 size={38} /><h2>会议结果已分流</h2><p>{route.actionNotifications.length} 项行动已推送负责人；未明确归属的事项回到 {data.meeting.leadDri}。CEO 只收到 1 项战略确认。</p></>}
      </aside>
    </div>
  );
}

export function DriWorkspace({ gateway }: { gateway?: DriWorkspaceGateway }) {
  const data = driWorkspaceFixture;
  const [now, setNow] = useState<Date | null>(null);
  const [active, setActive] = useState<DriNoticeId>('mission-review');
  const [selectedMissionId, setSelectedMissionId] = useState(data.missions[1].id);
  const [comments, setComments] = useState<ReviewComment[]>([...data.comments]);
  const [meetingStage, setMeetingStage] = useState<MeetingStage>('scheduled');

  useEffect(() => {
    let timer: number;
    const update = () => {
      const current = new Date();
      setNow(current);
      timer = window.setTimeout(update, 60_000 - current.getTime() % 60_000 + 20);
    };
    timer = window.setTimeout(update, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const countdown = countdownTo(data.reviewWindow.endsAt, now);
  const reviewOpen = !now || new Date(data.reviewWindow.endsAt).getTime() > now.getTime();

  function publishComment(comment: ReviewComment) {
    setComments((previous) => [comment, ...previous]);
    void gateway?.dispatch({ type: 'review.comment.publish', comment });
  }

  return (
    <div className={s.shell} data-testid="dri-workspace" data-active-view={active}>
      <NotificationRail active={active} onSelect={setActive} now={now} countdown={countdown} meetingStage={meetingStage} />
      <main className={s.mainSurface}>
        <div className={s.contextBar}>
          <div>
            {active === 'mission-review' && <><Target size={15} /><span>9 月 Mission Draft</span><small>{countdown}</small></>}
            {active === 'weekly-review' && <><FileCheck2 size={15} /><span>本周进展确认</span><small>3 类来源已读取 · 1 个问题</small></>}
            {active === 'ceo-return' && <><MessageCircle size={15} /><span>CEO Review 返回</span><small>Semantic Diff · 3 处变化</small></>}
            {active === 'meeting' && <><CalendarDays size={15} /><span>会议工作面</span><small>{meetingStage === 'recording' ? '录音中' : data.meeting.time}</small></>}
          </div>
          <span className={s.interfaceStatus}><i />连接接口已预留</span>
        </div>
        {active === 'mission-review' && <div className={s.twoPane}><MissionDocument selectedMissionId={selectedMissionId} onSelectMission={setSelectedMissionId} comments={comments} /><MissionConversation key={selectedMissionId} missionId={selectedMissionId} comments={comments} onPublish={publishComment} reviewOpen={reviewOpen} /></div>}
        {active === 'weekly-review' && <WeeklyReview gateway={gateway} />}
        {active === 'ceo-return' && <SemanticReview gateway={gateway} />}
        {active === 'meeting' && <MeetingWorkspace gateway={gateway} stage={meetingStage} setStage={setMeetingStage} />}
      </main>
    </div>
  );
}
