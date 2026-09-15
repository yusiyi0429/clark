'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import { Check, Quote, X } from 'lucide-react';
import type { CardReference, SelectedReference } from '@/lib/warmap/card-reference';
import s from './card-references.module.css';

export const CardReferenceContext = createContext<{
  items: SelectedReference[];
  toggle: (item: CardReference) => void;
  refresh: (item: CardReference) => void;
} | null>(null);

/** A sibling of a card's open/action button, never a nested button. */
export function ReferenceButton({ item, corner = false }: { item: CardReference; corner?: boolean }) {
  const context = useContext(CardReferenceContext);
  const refresh = context?.refresh;
  useEffect(() => { refresh?.(item); }, [item, refresh]);
  if (!context) return null;
  const selected = context.items.some(ref => ref.id === item.id);
  return <button type="button" className={`${s.quoteButton} ${corner ? s.corner : ''}`} data-reference-id={item.id}
    aria-label={`${selected ? '取消引用' : '引用到全局对话'}：${item.title}`} aria-pressed={selected}
    title={selected ? '已引用到全局对话 · 点击移除' : '引用到全局对话'}
    onClick={event => { event.stopPropagation(); context.toggle(item); }}>
    {selected ? <Check size={14} /> : <Quote size={14} />}
  </button>;
}

export function ReferenceTray({ items, onRemove, onClear }: { items: SelectedReference[]; onRemove: (id: string) => void; onClear: () => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const item = items.find(ref => ref.id === preview);
  if (!items.length) return null;
  return <div className={s.tray} data-testid="reference-tray" onKeyDown={event => { if (event.key === 'Escape' && preview) { event.stopPropagation(); setPreview(null); } }}>
    <div className={s.chips} aria-label="已引用卡片">
      {items.map(ref => <div className={s.chip} key={ref.id}>
        <button className={s.chipTitle} type="button" onClick={() => setPreview(preview === ref.id ? null : ref.id)} aria-expanded={preview === ref.id} title={ref.title}>{ref.title}</button>
        <button type="button" onClick={() => onRemove(ref.id)} aria-label={`移除引用：${ref.title}`}><X size={12} /></button>
      </div>)}
    </div>
    {items.length > 1 && <button className={s.clear} type="button" onClick={onClear} aria-label="清空引用" title="清空引用"><X size={13}/></button>}
    {item && <section className={s.preview} aria-label={`引用内容：${item.title}`}>
      <header><span>{item.kind}</span><button type="button" aria-label="关闭引用预览" onClick={() => setPreview(null)}><X size={15} /></button></header>
      <h3>{item.title}</h3><small>{item.source}</small><pre>{item.content}</pre>
    </section>}
  </div>;
}

export function MessageReferences({ items }: { items?: SelectedReference[] }) {
  if (!items?.length) return null;
  return <details className={s.sentReferences}><summary><Quote size={12} />引用了 {items.length} 张卡片</summary>
    {items.map(item => <details key={item.id}><summary>{item.title}</summary><small>{item.source} · 发送时快照</small><pre>{item.content}</pre></details>)}
  </details>;
}
