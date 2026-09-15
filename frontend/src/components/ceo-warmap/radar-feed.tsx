'use client';
import { ReferenceButton } from './card-references';
import { signalReference } from './reference-model';
import { useState } from 'react';
import { ArrowUpRight, Bookmark, ChevronLeft, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { fieldNames, issueLocation, type RadarState, type Signal } from '@/lib/warmap/radar-types';
import s from './radar-feed.module.css';
import { AnchorEditor } from './anchor-editor';
const published=(value?:string)=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleDateString('zh-CN'):'日期未提供';
type SortMode = 'time' | 'importance';
const signalTime=(signal:Signal)=>Date.parse(signal.publishedAt||signal.collectedAt)||0;
type Act = (action:string,extra?:Record<string,unknown>)=>Promise<boolean>;
export function RadarFeed({data,error,act,selected,onSelect}: {data?:RadarState;error:string;act:Act;selected:string|null;onSelect:(id:string|null)=>void}) {
  const [filter,setFilter]=useState('全部');const [sortMode,setSortMode]=useState<SortMode>('time');const [editing,setEditing]=useState(false);
  const [acting,setActing]=useState(false);
  const [selection,setSelection]=useState(selected);
  if(selection!==selected){setSelection(selected);}
  const signal=data?.signals.find(s=>s.id===selected);
  async function handle(action:string,extra:Record<string,unknown>={}) {if(acting)return;setActing(true);await act(action,extra);setActing(false);}
  const list = (data?.signals??[])
    .filter(x=>!x.dismissed&&(filter==='全部'||filter==='未读'&&!x.read||filter==='收藏'&&x.saved))
    .sort((a,b)=>sortMode==='importance'
      ? b.score-a.score||signalTime(b)-signalTime(a)
      : signalTime(b)-signalTime(a)||b.score-a.score);
  if(signal)return <div className={s.reader} key={signal.id} data-radar-reader>
    <div className={s.article}><button className={s.back} onClick={()=>onSelect(null)}><ChevronLeft size={15}/>返回信号</button><div className={s.meta}>{signal.source} · {published(signal.publishedAt)}<button aria-label={signal.saved?'取消收藏':'收藏信号'} aria-pressed={signal.saved} onClick={()=>void handle('save',{id:signal.id})} disabled={acting}><Bookmark size={17} fill={signal.saved?'currentColor':'none'}/></button></div>
      <h2>{signal.title}</h2><p className={s.lead}>{signal.summary}</p>
      <section><h3>对我们的影响</h3><p>{signal.implication}</p></section>
      <section className={s.anchor}><span>{signal.anchorSnapshot.title}</span><p>{signal.anchorSnapshot.material}</p><small>{signal.anchorSnapshot.source}</small></section>
      {signal.issue&&<section className={s.issue}><ReferenceButton item={signalReference(signal)}/><div className={s.meta}>已进入{issueLocation(signal.issue.fields)==='strategy'?'公司战略议题':`${fieldNames[signal.issue.fields[0]]}战场`} · {signal.issue.status==='closed'?'已处理':'尚未排会'}</div><h3>{signal.issue.title}</h3><p>{signal.issue.judgment}</p>{signal.issue.reason&&<small>{signal.issue.reason}</small>}
        {signal.issue.status==='pending'?<div className={s.clarify}><strong>尚未安排会议</strong><p>这说明判断所需的信息还不充分。可用底部输入继续与 Agent 沟通，形成清晰分歧与依据后再排入会议。</p></div>:<div className={s.receipt}><p>{signal.issue.decision}</p><button disabled={acting} onClick={()=>void handle('reopen',{id:signal.id})}>重新讨论</button></div>}
      </section>}
      <section><h3>尚未确定</h3><p>{signal.unknown}</p></section><details className={s.sources}><summary>来源摘录与战略锚点</summary><p>{signal.excerpt}</p><small>检索服务返回的摘录，未宣称阅读全文。采集于 {new Date(signal.collectedAt).toLocaleString('zh-CN')}</small><a href={signal.url} target="_blank" rel="noopener noreferrer">阅读来源原文<ArrowUpRight size={15}/></a></details>
      <button className={s.quiet} disabled={acting} onClick={async()=>{if(await act('dismiss',{id:signal.id}))onSelect(null);}}>{signal.dismissed?'恢复到阅读列表':'不再出现在阅读列表'}</button>{error&&<p role="alert">{error}</p>}
    </div>
  </div>;
  return <div className={s.feed} data-testid="radar-feed">
    <div className={s.toolbar}><div className={s.toolbarGroups}><div className={s.filters}>{['全部','未读','收藏'].map(f=><button key={f} aria-pressed={filter===f} onClick={()=>setFilter(f)}>{f}</button>)}</div><div className={s.sorts} role="group" aria-label="雷达排序方式"><button aria-pressed={sortMode==='time'} onClick={()=>setSortMode('time')}>按时间</button><button aria-pressed={sortMode==='importance'} onClick={()=>setSortMode('importance')}>按重要程度</button></div></div><div className={s.toolbarActions}><button aria-label="设置监测范围" aria-haspopup="dialog" aria-expanded={editing} onClick={()=>setEditing(true)} disabled={!data}><SlidersHorizontal size={16}/>监测范围</button><button disabled={!data||data.run.status==='running'||acting} onClick={()=>void handle('scan')}><RefreshCw size={16} className={data?.run.status==='running'?s.spinning:''}/>{data?.run.status==='running'?'正在扫描':'刷新信号'}</button></div></div>
    <div className={s.status} role="status">{data?.run.phase||'正在读取雷达'}{data?.run.finishedAt&&<time> · {new Date(data.run.finishedAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time>}</div>
    {error&&<p className={s.error} role="alert">{error}</p>}{data?.run.warnings.length? <p className={s.error}>{[...new Set(data.run.warnings)].join(' ')}</p>:null}
    {editing&&<AnchorEditor ontology={data?.ontology??[]} anchors={data?.anchors??[]} sources={data?.sources??[]} scanning={data?.run.status==='running'} error={error} onSave={(anchors,sources)=>act('configuration',{anchors,sources})} onClose={()=>setEditing(false)}/>}
    {!list.length?<div className={s.empty}><div className={s.orbit}/><h2>{data?.run.status==='running'?'正在寻找值得关注的变化':filter==='全部'?'从公司本体出发，看看外面发生了什么':'这里暂时没有信号'}</h2><p>{filter==='全部'?'本体中的公司目标与 Mission 已经构成监测基线；也可以追加锚点或指定来源。':'换一个筛选，或刷新外部信息。'}</p></div>:<div className={s.stories}>{list.map(signal=><div className={s.storyWrapper} key={signal.id}><button className={s.story} onClick={()=>{onSelect(signal.id);void act('read',{id:signal.id});}}><div className={s.meta}><span>{signal.source} · {published(signal.publishedAt)}</span><span>{signal.issue?'已成议题':signal.read?'已读':'新信号'}</span></div><h2>{signal.title}</h2><p>{signal.summary}</p><div className={s.storyBottom}><span>{signal.anchorSnapshot.title}</span><ArrowUpRight size={17}/></div></button></div>)}</div>}
  </div>;
}
export function RadarIssueRows({signals,location,onSelect}: {signals:Signal[];location:string;onSelect:(id:string)=>void}) {
  return <>{signals.filter(s=>s.issue?.status==='pending'&&issueLocation(s.issue.fields)===location).map(signal=><div className={s.referenceRow} key={signal.id}><button className={s.inlineIssue} data-radar-issue={signal.id} onClick={()=>onSelect(signal.id)}><i data-urgency={signal.issue!.urgency}/><span>{signal.issue!.title}</span><ArrowUpRight size={14}/></button><ReferenceButton item={signalReference(signal)}/></div>)}</>;
}
