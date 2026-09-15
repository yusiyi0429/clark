'use client';

import { ReferenceButton } from './card-references';
import { cardReference } from '@/lib/warmap/card-reference';
import { Check, CheckCheck, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { HeavyNoticeId } from './decision-model';
import s from './heavy-workspace.module.css';

type Props = { notice: HeavyNoticeId; onClose: () => void; onCloseStart?: () => void; onComplete: (id: HeavyNoticeId, summary: string) => void; onMaterialsChange?: (text: string) => void; onDirty?: (id: HeavyNoticeId) => void };
type ReviewItem = { id: string; title: string; proposal: string; basis: string };
type Draft = { checked: string[]; values: Record<string, string>; note: string; submitted: boolean };

export const heavyNoticeTitles: Record<HeavyNoticeId, string> = {
  'preflight-product': '灯塔项目 · 产品交互对齐会议',
  'preflight-workshop': '灯塔项目 · M1B L4/5 workshop',
  monthly: '9 月目标与任务制定',
};
export const heavyTitles = heavyNoticeTitles;

const cases: Record<HeavyNoticeId, { eyebrow: string; intro: string; items: ReviewItem[]; question: string }> = {
  'preflight-product': {
    eyebrow: '会前预审 · 10:00 - 12:00',
    intro: '本次会议要对齐 CEO 首页的注意力分配、议题入口和语音交互边界。',
    items: [
      { id: 'attention', title: '首页需要呈现什么', proposal: '首页聚焦待 CEO 判断的议题，按战场和战役归属呈现；红色议题同时出现在通知区，处理后同步更新。', basis: '讨论材料：当前首页布局与三色议题机制；需确认信息是否足够支持判断。' },
      { id: 'interaction', title: '如何从通知进入讨论', proposal: '少量内容在卡片上直接处理；会议预审在主区以单栏展开材料，底部输入自动切换到当前材料，左侧保留会议位置和选中状态。', basis: '讨论材料：通知分层交互与会前预审合并方案；仍需核对真实使用反馈。' },
      { id: 'voice', title: '语音优先的承诺边界', proposal: '支持围绕当前材料连续追问，切换材料时同步切换上下文。正式承诺语音体验前，验证延迟、打断与控制指令准确性。', basis: '尚待验证：真实语音控制的可用性与首次交付范围，不把视觉原型视为能力已交付。' },
    ],
    question: '可以问：“哪些交互还需要实际验证才能作出交付承诺？”',
  },
  'preflight-workshop': {
    eyebrow: '会前预审 · 13:00 - 15:00',
    intro: '本次 workshop 要澄清长期方向、本月结果与 Missions 之间的承接，以及负责人协商边界。',
    items: [
      { id: 'direction', title: '长期方向如何落到本月', proposal: '对照六个月目标，确认本月希望取得的可验证结果，以及哪些假设仍待验证。', basis: '讨论材料：当前目标草稿；不能用时间经过比例替代真实结果进展。' },
      { id: 'ownership', title: '目标与 Missions 如何达成共识', proposal: 'CEO 与 Agent 提出草稿，DRI 与 Agent 审阅后返回，通过多轮协商确认当前生效版本与责任人。', basis: '讨论材料：月初 OM 协商链路；各域的成功证据和投入边界仍需逐项对齐。' },
      { id: 'boundary', title: '推进中如何处理变化', proposal: '会后行动指导现有 Mission 的下一步；确需新增 Mission 时，记录目标制定的缺口和边界变化，再进行协商确认。', basis: '讨论材料：会后确认与新增 Mission 例外；会议行动不自动成为新的 Mission。' },
    ],
    question: '可以问：“目标与任务之间，哪一处承接还不清楚？”',
  },
  monthly: {
    eyebrow: '月度协商',
    intro: '先对齐本月希望取得的经营结果，再逐项审阅支撑它的任务。以下仍是待协商草稿。',
    items: [
      { id: 'outcome', title: '公司本月 Outcome', proposal: '验证灯塔项目的首轮客户价值，并为 TokenOps 取得可判断商业价值的需求证据。', basis: '承接六个月方向：验证可复制的客户经营闭环，同时明确企业模型优化业务的成立条件。' },
      { id: 'lighthouse', title: '灯塔项目 · Outcome 与 Missions', proposal: 'Outcome：明确客户采用的首轮场景和继续验证条件。\nMission 1：完成内部真实议题的连续使用验证。\nMission 2：与客户对齐试用边界、参与方式和成功证据。', basis: '待协商边界：首次交付承诺、客户 DRI 参与，以及付费验证是否属于本月范围。' },
      { id: 'tokenops', title: 'TokenOps · Outcome 与 Missions', proposal: 'Outcome：形成是否继续投入的商业判断依据。\nMission 1：取得可比较的企业模型用量样本。\nMission 2：验证客户的优化需求与采购意愿。', basis: '资源约束：交付力量有限，先明确与灯塔项目的投入边界；不以会后行动项自动新增 Mission。' },
    ],
    question: '可以问：“两个战场的目标，在哪些资源上存在冲突？”',
  },
};

export const heavyMaterials: Record<HeavyNoticeId, string> = Object.fromEntries(
  Object.entries(cases).map(([id, data]) => [id, `演练材料，非已核验战况。\n${data.intro}\n${data.items.map(item => `${item.title}：${item.proposal}\n${item.basis}`).join('\n')}`]),
) as Record<HeavyNoticeId, string>;

/** Call at send time so discussion uses the edited materials currently shown. */
export function currentHeavyMaterials(notice: HeavyNoticeId): string {
  if (typeof window === 'undefined') return heavyMaterials[notice];
  try {
    const stored = localStorage.getItem(`tianshu-heavy-draft-v1-${notice}`);
    if (!stored) return heavyMaterials[notice];
    const draft = JSON.parse(stored) as Partial<Draft>;
    const data = cases[notice];
    return `演练材料，非已核验战况。编辑和核对不代表正式通过或发送。\n${data.intro}\n${data.items.map(item => `${item.title}：${typeof draft.values?.[item.id] === 'string' ? draft.values[item.id] : item.proposal}\n${item.basis}`).join('\n')}${notice === 'monthly' ? '' : `\n补充意见：${typeof draft.note === 'string' ? draft.note : '无'}`}`;
  } catch { return heavyMaterials[notice]; }
}

function freshDraft(notice: HeavyNoticeId): Draft {
  return { checked: [], values: Object.fromEntries(cases[notice].items.map(item => [item.id, item.proposal])), note: '', submitted: false };
}

/** Independent local demonstration drafts; closing never submits or writes company records. */
export function HeavyWorkspace(props: Props) {
  return <HeavyWorkspaceContent key={props.notice} {...props} />;
}

function HeavyWorkspaceContent({ notice, onClose, onCloseStart, onComplete, onMaterialsChange, onDirty }: Props) {
  const data = cases[notice];
  const title = heavyNoticeTitles[notice];
  const [draft, setDraft] = useState<Draft>(() => freshDraft(notice));
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const key = `tianshu-heavy-draft-v1-${notice}`;

  // Browser storage is an external source, hydrated after the server's first render.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored) {
        const value = JSON.parse(stored) as Partial<Draft>;
        const base = freshDraft(notice);
        const values = { ...base.values };
        for (const item of data.items) {
          if (typeof value.values?.[item.id] === 'string') values[item.id] = value.values[item.id];
        }
        const checked = Array.isArray(value.checked) ? value.checked.filter(id => typeof id === 'string' && data.items.some(item => item.id === id) && values[id].trim()) : [];
        setDraft({ values, checked, note: typeof value.note === 'string' ? value.note : '', submitted: value.submitted === true && checked.length === data.items.length });
      }
    } catch { setSaveError(true); }
    setLoaded(true);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [key, notice, data]);

  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(key, JSON.stringify(draft)); setSaveError(false); }
    catch { setSaveError(true); }
  }, [draft, loaded, key]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!loaded) return;
    onMaterialsChange?.(`演练材料，非已核验战况。编辑和核对不代表正式通过或发送。\n${data.intro}\n${data.items.map(item => `${item.title}（${draft.checked.includes(item.id) ? '本项已核对' : '本项待核对'}）：${draft.values[item.id]}\n${item.basis}`).join('\n')}${notice === 'monthly' ? '' : `\n补充意见：${draft.note || '无'}\n本轮意见：${draft.submitted ? '已在本机提交' : '草稿，尚未提交'}`}`);
  }, [draft, loaded, data, notice, onMaterialsChange]);

  function close() {
    if (closing) return;
    setClosing(true);
    onCloseStart?.();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    timer.current = setTimeout(onClose, reduce ? 0 : 240);
  }

  function updateItem(id: string, value: string) {
    if (draft.submitted) onDirty?.(notice);
    setDraft(current => ({ ...current, submitted: false, values: { ...current.values, [id]: value }, checked: current.checked.filter(item => item !== id) }));
  }

  function toggleReview(id: string) {
    if (draft.submitted) onDirty?.(notice);
    setDraft(current => ({ ...current, submitted: false, checked: current.checked.includes(id) ? current.checked.filter(item => item !== id) : [...current.checked, id] }));
  }

  function submit() {
    if (!loaded || draft.submitted || draft.checked.length !== data.items.length) return;
    const summary = notice !== 'monthly' ? '已完成会前预审，3 项材料已逐项核对' : '已提交本轮月度协商意见，3 项目标与任务已核对';
    try {
      localStorage.setItem(key, JSON.stringify({ ...draft, submitted: true }));
      setSaveError(false);
    } catch { setSaveError(true); return; }
    setDraft(current => ({ ...current, submitted: true }));
    onComplete(notice, summary);
  }

  return <section className={`${s.workspace} ${notice === 'monthly' ? s.monthly : s.preflight} ${closing ? s.closing : ''}`} role="dialog" aria-modal="false" aria-label={title} data-heavy-workspace={notice}>
    <header className={s.header}>
      <div className={s.identity}><span className={s.marker} aria-hidden="true" /><div><span className={s.eyebrow}>{data.eyebrow}</span><h1>{title}</h1></div></div>
      <ReferenceButton item={cardReference(`material:${notice}`,title,'材料',`${data.intro}\n${data.items.map(item=>`${item.title}：${draft.values[item.id]}\n依据：${item.basis}`).join('\n\n')}${notice === 'monthly' ? '' : `\n补充意见：${draft.note}\n状态：${draft.submitted?'已提交本轮意见（演练）':'草稿'}`}`)}/><button type="button" className={s.close} onClick={close} aria-label="关闭工作区，保留草稿"><X size={19} /></button>
    </header>
    <div className={s.body}>
      <div className={s.materials}>
        <div className={s.intro}><span className={s.demo}>演练材料 · 不代表已核验战况</span><p>{data.intro}</p></div>
        <div className={s.reviewList}>
          {data.items.map((item, index) => <article className={s.reviewItem} key={item.id} data-reviewed={draft.checked.includes(item.id)}>
            <div className={s.itemHeading}><span className={s.number}>{String(index + 1).padStart(2, '0')}</span><h2>{item.title}</h2><ReferenceButton item={cardReference(`material:${notice}:${item.id}`,item.title,title,`${draft.values[item.id]}\n依据：${item.basis}\n${draft.checked.includes(item.id)?'已核对（演练）':'尚未核对'}`)}/></div>
            <p className={s.proposal}>{draft.values[item.id]}</p>
            <p className={s.basis}>{item.basis}</p>
            <div className={s.itemControls}>
              <details className={s.edit}><summary>调整表述</summary><label htmlFor={`heavy-${notice}-${item.id}`}>本项内容</label><textarea id={`heavy-${notice}-${item.id}`} value={draft.values[item.id]} onChange={event => updateItem(item.id, event.target.value)} rows={notice === 'monthly' ? 5 : 3} disabled={!loaded} /><small>修改后需要重新核对本项。</small></details>
              <button className={s.reviewButton} type="button" aria-pressed={draft.checked.includes(item.id)} disabled={!loaded || !draft.values[item.id].trim()} onClick={() => toggleReview(item.id)}><Check size={14} />{draft.checked.includes(item.id) ? '已核对' : '核对此项'}</button>
            </div>
          </article>)}
        </div>
        {notice !== 'monthly' && <>
          <div className={s.notes}><label htmlFor={`heavy-${notice}-note`}>补充意见</label><textarea id={`heavy-${notice}-note`} placeholder="保留需要补充的依据、修改意见或讨论重点…" rows={2} value={draft.note} disabled={!loaded} onChange={event => { if (draft.submitted) onDirty?.(notice); setDraft(current => ({ ...current, note: event.target.value, submitted: false })); }} /></div>
          <div className={s.commitArea}>
            <div className={s.commitInfo}><span>{draft.checked.length} / {data.items.length} 项已核对</span><small>{saveError ? '本机保存失败，请保留此页面后重试' : loaded ? '草稿保存在本机，关闭不会提交' : '正在读取草稿'}</small></div>
            <button className={s.submit} type="button" disabled={!loaded || draft.checked.length !== data.items.length || draft.submitted} onClick={submit}>{draft.submitted ? <><CheckCheck size={16} />已提交本轮意见</> : '完成本次预审'}</button>
          </div>
          {draft.submitted && <p className={s.receipt} role="status">预审结果已保存。仅为本机演示，未发送或写入公司记录。</p>}
        </>}
      </div>
    </div>
  </section>;
}
