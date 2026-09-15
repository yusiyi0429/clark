'use client';

import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatResearch, ChatStage } from '@/lib/warmap/chat-research';
import { MessageReferences } from './card-references';
import type { SelectedReference } from '@/lib/warmap/card-reference';
import s from './conversation-transcript.module.css';

export type ConversationMessage = {
  id: number; role: 'user' | 'assistant'; content: string; context: string;
  ms?: number; research?: ChatResearch; references?: SelectedReference[];
};
export type ConversationActivity = { started: number; stage: ChatStage };
const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} 秒`;
const sourceHost = (url: string) => { try { return new URL(url).hostname; } catch { return ''; } };

export function ConversationTurn({ message }: { message: ConversationMessage }) {
  const user = message.role === 'user';
  const research = message.research;
  const sources = research?.sources.filter((source, i, all) => /^https?:\/\//.test(source.url) && all.findIndex(other => other.url === source.url) === i) ?? [];
  return <article className={user ? s.user : s.assistant} data-chat-role={message.role} aria-label={user ? '你' : '天枢'}>
    {!user && message.ms !== undefined && <div className={s.meta}>
      <span title="本轮处理的实际用时，包含模型生成、检索与服务等待">用时 {seconds(message.ms)}</span>
      {research && <span>· {research.status === 'found' ? `已查证 ${sources.length} 个来源` : research.status === 'not_found' ? '未取得有效证据' : '查证未完成'}</span>}
    </div>}
    {user && <MessageReferences items={message.references}/>}
    <div className={s.prose}><Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown></div>
    {!user && sources.length > 0 && <details className={s.sources}>
      <summary>查看来源 · {sources.length}</summary>
      {sources.map(source => <a key={source.url} href={source.url} target="_blank" rel="noreferrer">{source.title}<span>{sourceHost(source.url)}</span></a>)}
      <p>{research?.independentGroups} 组独立来源；引用不等于结论已成立。</p>
    </details>}
  </article>;
}

export function ConversationThinking({ activity, onStop }: { activity: ConversationActivity; onStop: () => void }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const update = () => setElapsed(Date.now() - activity.started);
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [activity.started]);
  return <div className={s.thinking} data-testid="conversation-thinking">
    <span className={s.pulse} aria-hidden />
    <span role="status">{activity.stage === 'researching' ? '正在快速查证' : activity.stage === 'answering' ? '正在整理回答' : '正在思考'}</span>
    <span className={s.elapsed}>{seconds(elapsed)}</span>
    <button onClick={onStop} aria-label="停止本次回答">停止</button>
  </div>;
}
