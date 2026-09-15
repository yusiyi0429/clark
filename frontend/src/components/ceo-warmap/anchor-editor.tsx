'use client';

import { useEffect, useRef, useState } from 'react';
import { Database, Link2, Plus, Trash2, X } from 'lucide-react';
import type { Anchor, MonitoringSource, OntologyMonitor } from '@/lib/warmap/radar-types';
import s from './anchor-editor.module.css';

const blankAnchor = { title: '', material: '' };
const blankSource = { title: '', url: '' };

export function AnchorEditor({ ontology, anchors, sources, scanning, error, onSave, onClose }: {
  ontology: OntologyMonitor[]; anchors: Anchor[]; sources: MonitoringSource[]; scanning: boolean; error: string;
  onSave: (anchors: Anchor[], sources: MonitoringSource[]) => Promise<boolean>; onClose: () => void;
}) {
  const [draftAnchors, setDraftAnchors] = useState(() => structuredClone(anchors));
  const [draftSources, setDraftSources] = useState(() => structuredClone(sources));
  const [anchorForm, setAnchorForm] = useState(false);
  const [sourceForm, setSourceForm] = useState(false);
  const [nextAnchor, setNextAnchor] = useState(blankAnchor);
  const [nextSource, setNextSource] = useState(blankSource);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [closing, setClosing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const exiting = useRef(false);
  const motion = useRef<Animation | null>(null);

  useEffect(() => {
    const element = dialog.current;
    const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    element?.showModal();
    return () => {
      motion.current?.cancel();
      element?.close();
      if (origin?.isConnected) origin.focus({ preventScroll: true });
    };
  }, []);

  function close() {
    if (exiting.current) return;
    exiting.current = true;
    setClosing(true);
    const element = dialog.current;
    if (!element || matchMedia('(prefers-reduced-motion: reduce)').matches) { onClose(); return; }
    const style = getComputedStyle(element);
    motion.current = element.animate([
      { opacity: style.opacity, transform: style.transform },
      { opacity: 0, transform: 'translateY(10px) scale(.985)' },
    ], { duration: 180, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' });
    motion.current.finished.then(onClose).catch(() => {});
  }

  function appendAnchor() {
    const title = nextAnchor.title.trim();
    const material = nextAnchor.material.trim();
    if (!title || material.length < 12) { setSaveError('请为监测锚点补充名称，以及至少 12 个字的监测内容。'); return; }
    setDraftAnchors(current => [...current, { id: crypto.randomUUID(), title, material, source: '人工追加 · CEO 雷达配置', fields: ['lighthouse', 'tokenops'] }]);
    setNextAnchor(blankAnchor); setAnchorForm(false); setSaveError('');
  }

  function appendSource() {
    const title = nextSource.title.trim();
    const entered = nextSource.url.trim();
    if (!title || !entered) { setSaveError('请填写来源名称和网址。'); return; }
    const url = /^https?:\/\//i.test(entered) ? entered : `https://${entered}`;
    try { new URL(url); } catch { setSaveError('请输入有效的网址。'); return; }
    setDraftSources(current => [...current, { id: crypto.randomUUID(), title, url }]);
    setNextSource(blankSource); setSourceForm(false); setSaveError('');
  }

  async function save() {
    if (saving || closing || scanning) return;
    setSaving(true); setSaveError('');
    try { if (await onSave(draftAnchors, draftSources)) close(); }
    catch { setSaveError('暂时无法保存，请重试。你的修改仍保留在这里。'); }
    finally { setSaving(false); }
  }

  return <dialog ref={dialog} className={s.dialog} data-closing={closing} aria-labelledby="anchor-editor-title" aria-describedby="anchor-editor-description"
    onCancel={event => { event.preventDefault(); if (!saving) close(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!saving) close(); } }}
    onClick={event => {
      if (event.target !== event.currentTarget || saving) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    }}>
    <header className={s.header}>
      <div><span className={s.eyebrow}>雷达 · 公司级监测</span><h2 id="anchor-editor-title">监测范围</h2><p id="anchor-editor-description">从公司本体出发，持续观察可能改变公司判断的外部变化。</p></div>
      <button type="button" className={s.close} aria-label="关闭监测范围" onClick={close} disabled={saving || closing}><X size={19}/></button>
    </header>

    <div className={s.scroll}>
      <section className={s.group} aria-labelledby="ontology-monitoring-title">
        <div className={s.groupHeading}>
          <div><span className={s.groupIcon}><Database size={15}/></span><div><h3 id="ontology-monitoring-title">公司本体中的监测内容</h3><p>随公司目标与 Mission 更新，在这里不可修改。</p></div></div>
          <span className={s.readonly}>本体读取 · 只读</span>
        </div>
        <div className={s.ontologyList}>{ontology.map((item, index) => <article key={item.id} className={s.ontologyItem}>
          <span className={s.index}>{String(index + 1).padStart(2, '0')}</span><div><small>{item.scope}</small><h4>{item.title}</h4><p>{item.material}</p></div>
        </article>)}</div>
      </section>

      <fieldset disabled={saving || closing} className={s.fields}>
        <legend className={s.srOnly}>人工追加的监测配置</legend>
        <section className={s.group} aria-labelledby="manual-anchor-title">
          <div className={s.groupHeading}>
            <div><div><h3 id="manual-anchor-title">追加的监测锚点</h3><p>补充本体尚未覆盖、但需要持续留意的变化。</p></div></div>
            <button className={s.addButton} type="button" disabled={draftAnchors.length >= 8 || scanning} onClick={() => { setAnchorForm(true); setSourceForm(false); }}><Plus size={15}/>添加监测锚点</button>
          </div>
          <div className={s.appendList}>{draftAnchors.map((anchor, index) => <article key={anchor.id} className={s.appendItem}>
            <span className={s.index}>{String(index + 1).padStart(2, '0')}</span><div><h4>{anchor.title}</h4><p>{anchor.material}</p><small>人工追加</small></div>
            <button type="button" className={s.remove} aria-label={`删除监测锚点：${anchor.title}`} onClick={() => setDraftAnchors(current => current.filter(item => item.id !== anchor.id))}><Trash2 size={15}/></button>
          </article>)}</div>
          {!draftAnchors.length && !anchorForm && <p className={s.empty}>尚未追加锚点。本体内容已经可以独立驱动监测。</p>}
          {anchorForm && <div className={s.composer}>
            <label>锚点名称<input autoFocus value={nextAnchor.title} onChange={event => setNextAnchor(current => ({ ...current, title: event.target.value }))} placeholder="例如：海外监管对企业 Agent 的影响"/></label>
            <label>监测内容<textarea rows={3} value={nextAnchor.material} onChange={event => setNextAnchor(current => ({ ...current, material: event.target.value }))} placeholder="说明需要持续观察什么变化，以及它为什么可能影响公司判断。"/></label>
            <div className={s.composerActions}><button type="button" onClick={() => { setAnchorForm(false); setNextAnchor(blankAnchor); }}>取消</button><button type="button" className={s.append} onClick={appendAnchor}>加入清单</button></div>
          </div>}
        </section>

        <section className={s.group} aria-labelledby="monitoring-source-title">
          <div className={s.groupHeading}>
            <div><span className={s.groupIcon}><Link2 size={15}/></span><div><h3 id="monitoring-source-title">监测来源</h3><p>指定需要优先检查的官网、机构或信息渠道。</p></div></div>
            <button className={s.addButton} type="button" disabled={draftSources.length >= 12 || scanning} onClick={() => { setSourceForm(true); setAnchorForm(false); }}><Plus size={15}/>添加来源</button>
          </div>
          <div className={s.appendList}>{draftSources.map((source, index) => <article key={source.id} className={s.appendItem}>
            <span className={s.index}>{String(index + 1).padStart(2, '0')}</span><div><h4>{source.title}</h4><p className={s.url}>{source.url}</p></div>
            <button type="button" className={s.remove} aria-label={`删除监测来源：${source.title}`} onClick={() => setDraftSources(current => current.filter(item => item.id !== source.id))}><Trash2 size={15}/></button>
          </article>)}</div>
          {!draftSources.length && !sourceForm && <p className={s.empty}>尚未指定来源。雷达将使用已配置的外部检索渠道。</p>}
          {sourceForm && <div className={s.composer}>
            <label>来源名称<input autoFocus value={nextSource.title} onChange={event => setNextSource(current => ({ ...current, title: event.target.value }))} placeholder="例如：国家市场监督管理总局"/></label>
            <label>网址<input value={nextSource.url} onChange={event => setNextSource(current => ({ ...current, url: event.target.value }))} placeholder="https://www.example.com" inputMode="url"/></label>
            <div className={s.composerActions}><button type="button" onClick={() => { setSourceForm(false); setNextSource(blankSource); }}>取消</button><button type="button" className={s.append} onClick={appendSource}>加入清单</button></div>
          </div>}
        </section>
      </fieldset>
    </div>

    <footer className={s.footer}>
      <div aria-live="polite">{(saveError || error) ? <p className={s.error}>{saveError || error}</p> : <span>{scanning ? '本轮监测进行中，结束后可调整' : '新增与删除将在下一轮监测生效'}</span>}</div>
      <div className={s.actions}><button type="button" onClick={close} disabled={saving || closing}>取消</button><button type="button" className={s.save} disabled={saving || closing || scanning} onClick={() => void save()}>{saving ? '保存中…' : '保存监测配置'}</button></div>
    </footer>
  </dialog>;
}
