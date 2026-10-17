"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Brain, Pencil, X } from "lucide-react";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { popPosition } from "./citations";
import c from "@/styles/citations.module.css";
import s from "@/styles/memory-mark.module.css";

type Item = components["schemas"]["PersonalMemoryItem"];
type Load = { state: "loading" } | { state: "missing" } | { state: "ready"; item: Item };

/** 回答里 `[记忆](cite:pmem:<id>)` 的这条个人记忆：只读本人的（接口按登录人绑定）。 */
async function loadMemory(id: string): Promise<Item | null> {
  const { data } = await browserApi.GET("/api/me/memory/personal", { params: { query: { status: "all" } } });
  return data?.items.find((item) => item.id === id) ?? null;
}

const STATUS_TAG: Record<Item["status"], string | null> = { active: null, superseded: "已替代", forgotten: "已忘掉" };

/**
 * 回答里用到个人记忆的地方（已定设计第 6 节第 5 条、7a）：一个很小的记忆图标，不写字。
 * 点开（电脑浮层、手机从底部升起）只有这条记忆本身和「修改」；修改走 PATCH /api/me/memory/personal/items/:id，当场生效。
 */
export function MemoryMark({ id }: { id: string }) {
  const button = useRef<HTMLButtonElement>(null);
  const [mode, setMode] = useState<"closed" | "pop" | "sheet">("closed");
  const pointer = useRef("mouse");
  const popId = useId();
  const close = useCallback(() => { setMode("closed"); button.current?.focus({ preventScroll: true }); }, []);
  const onClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (mode !== "closed") { setMode("closed"); return; }
    setMode(pointer.current !== "mouse" && event.detail > 0 ? "sheet" : "pop");
  };
  return (
    <>
      <button ref={button} type="button" className={s.mark} data-memory-mark={id} aria-label="个人记忆" aria-expanded={mode !== "closed"}
        aria-controls={mode !== "closed" ? popId : undefined}
        onPointerDown={(event) => { pointer.current = event.pointerType || "mouse"; }} onClick={onClick}>
        <Brain size={11} strokeWidth={2} aria-hidden />
      </button>
      {mode === "pop" ? <MemoryPop id={id} popId={popId} anchor={button} onClose={close} /> : null}
      {mode === "sheet" ? <MemorySheet id={id} popId={popId} onClose={close} /> : null}
    </>
  );
}

/** 浮层：标记下方（放不下就上方）；点外面、Esc 收起；滚动时跟着标记走。 */
function MemoryPop({ id, popId, anchor, onClose }: { id: string; popId: string; anchor: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<ReturnType<typeof popPosition> | null>(null);
  const measure = useCallback(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (rect) setPlace(popPosition(rect, { width: window.innerWidth, height: window.innerHeight }, box.current?.offsetHeight ?? 160));
  }, [anchor]);
  useLayoutEffect(measure, [measure]);
  useEffect(() => {
    // Esc 只收起这个浮层，不连带收起下面的对话层。
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!box.current?.contains(target) && !anchor.current?.contains(target)) onClose();
    };
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [anchor, measure, onClose]);
  return createPortal(
    <div ref={box} id={popId} role="dialog" aria-label="个人记忆" className={`${c.pop} ${s.pop}`} data-memory-pop=""
      style={place ? ({ left: place.left, top: place.top, bottom: place.bottom, width: place.width } as CSSProperties) : { visibility: "hidden" }}>
      <MemoryBody id={id} onLayout={measure} />
    </div>,
    document.body,
  );
}

/** 手机：从底部升起同样的内容。 */
function MemorySheet({ id, popId, onClose }: { id: string; popId: string; onClose: () => void }) {
  const closeKey = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeKey.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className={c.sheetLayer} data-memory-sheet="">
      <button type="button" className={c.sheetVeil} aria-label="收起" tabIndex={-1} onClick={onClose} />
      <section id={popId} className={`${c.sheet} ${s.sheet}`} role="dialog" aria-modal="true" aria-label="个人记忆">
        <span className={c.grabber} aria-hidden />
        <button ref={closeKey} type="button" className={`${c.sheetClose} ${s.sheetClose}`} aria-label="收起" onClick={onClose}>
          <X size={18} strokeWidth={1.9} aria-hidden />
        </button>
        <MemoryBody id={id} large />
      </section>
    </div>,
    document.body,
  );
}

/** 这条记忆本身（标题、正文）与修改。 */
export function MemoryBody({ id, large = false, onLayout, initial }: { id: string; large?: boolean; onLayout?: () => void; initial?: Load }) {
  const [load, setLoad] = useState<Load>(initial ?? { state: "loading" });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: "", text: "" });
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (initial) return;
    let live = true;
    loadMemory(id).then((item) => { if (live) setLoad(item ? { state: "ready", item } : { state: "missing" }); }, () => { if (live) setLoad({ state: "missing" }); });
    return () => { live = false; };
  }, [id, initial]);
  useLayoutEffect(() => { onLayout?.(); }, [load, editing, onLayout]);

  if (load.state === "loading") return <div className={s.skeleton} aria-busy="true"><i /><i /><i /></div>;
  if (load.state === "missing") return <p className={s.tag} data-memory-state="missing">已删除</p>;
  const { item } = load;
  const tag = STATUS_TAG[item.status];
  const save = async () => {
    const title = draft.title.trim(), text = draft.text.trim();
    if (!title || !text) return;
    setSaving(true);
    setFailed(false);
    const { data } = await browserApi.PATCH("/api/me/memory/personal/items/{id}", { params: { path: { id: item.id } }, body: { title, text } }).catch(() => ({ data: undefined }));
    setSaving(false);
    if (!data) { setFailed(true); return; }
    setLoad({ state: "ready", item: data });
    setEditing(false);
  };

  if (editing) {
    return (
      <form className={`${s.body} ${large ? s.large : ""}`} onSubmit={(event) => { event.preventDefault(); void save(); }} data-memory-editing="">
        <input className={s.titleInput} value={draft.title} maxLength={200} aria-label="标题" autoFocus
          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
        <textarea className={s.textInput} value={draft.text} maxLength={4000} aria-label="内容" rows={4}
          onChange={(event) => setDraft((current) => ({ ...current, text: event.target.value }))}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); } }} />
        <div className={s.actions}>
          {failed ? <span className={s.failed} role="alert">没存上</span> : null}
          <button type="button" className={s.ghost} onClick={() => { setEditing(false); setFailed(false); }} disabled={saving}>取消</button>
          <button type="submit" className={s.primary} disabled={saving || !draft.title.trim() || !draft.text.trim()}>保存</button>
        </div>
      </form>
    );
  }
  return (
    <div className={`${s.body} ${large ? s.large : ""}`} data-memory-status={item.status}>
      <div className={s.head}>
        <p className={s.title}>{item.title}</p>
        {tag ? <span className={s.tag}>{tag}</span>
          : <button type="button" className={s.edit} aria-label="修改" title="修改"
            onClick={() => { setDraft({ title: item.title, text: item.text }); setEditing(true); }}>
            <Pencil size={large ? 15 : 13} strokeWidth={1.9} aria-hidden />
          </button>}
      </div>
      <p className={s.text}>{item.text}</p>
    </div>
  );
}
