import React from 'react';
import {discussionMinutes,minuteSentence,waitingSentence} from './discussion-minutes.mjs';
export default function DiscussionMinutes({topics,records,drafts,busy,error,listening,onAnalyze,onSource,onProposal}){
 const minutes=discussionMinutes(topics,records,drafts);
 return <section className="discussion-minutes" aria-label="沟通纪要">
  {['agreement','discussing','pending'].map(status=><section className={`minutes-section minutes-${status}`} key={status}>
   <h3 title={status==='agreement'?'讨论一致不代表已修订或已握手。':undefined}>{{agreement:'已共识',discussing:'正在讨论',pending:'待讨论'}[status]}</h3>
   {status==='discussing'&&busy&&<p className="minutes-note">Co-agent 正在整理…</p>}
   {!minutes[status].length&&!(status==='discussing'&&minutes.proposals.length)&&<p className="minutes-empty">{{agreement:'暂无已形成的讨论共识',discussing:'暂无正在讨论的议题',pending:'暂无待讨论的问题'}[status]}</p>}
   <ul className="minutes-list">{minutes[status].map(t=><li key={t.id||t.title}>{minuteSentence(t)}{waitingSentence(t)&&<p className="minutes-waiting">{waitingSentence(t)}</p>}</li>)}
   {status==='discussing'&&minutes.proposals.map(p=><li key={p.id}>{p.status==='accepted'?`负责人已接受“${drafts[p.cardId]?.title||p.cardId}”的修订，材料确认另行进行。`:p.status==='rejected'?`负责人未采用“${drafts[p.cardId]?.title||p.cardId}”的修订建议。`:`${p.reviewerName||'负责人'}待核对“${drafts[p.cardId]?.title||p.cardId}”的修订建议${p.stale?'（材料版本已变化）':''}。`}</li>)}</ul>
  </section>)}
 </section>;
}
