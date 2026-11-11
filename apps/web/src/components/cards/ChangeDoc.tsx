"use client";

/**
 * 「改动」开着时预览的正文那一块（设计第 72 条第一步，照示意）：可滚，里面是全文；marks 关着时是改完以后的干净全文。
 * 左边一条窄边栏，每处一条小横线，位置对着它在全文的哪儿，点了滚过去；打开时滚到第一处。
 * 点一处改动，它下面出一个小浮层，只有「恢复」（restorable 为 false 时不出：一轮正在跑、Word / Excel 只能看）；点别处、Esc 收起。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { diffLayout, type DiffMode, type FileChanges } from "@/lib/local/fileChanges";
import { ChangeView, DocChunk } from "./ChangeView";
import c from "@/styles/change-view.module.css";

type Tick = { key: string; top: number };
type Pop = { ids: string[]; top: number; left: number };

const escapeAttr = (value: string) => value.replace(/["\\]/g, "\\$&");

export function ChangeDoc({ data, mode, marks, restorable, onRestore, bodyClass, docClass }: {
  data: Pick<FileChanges, "path" | "range" | "before" | "after" | "changes">; mode: DiffMode; marks: boolean; restorable: boolean;
  onRestore: (ids: string[]) => Promise<unknown>; bodyClass: string; docClass: string;
}) {
  const sections = useMemo(() => diffLayout(data, mode), [data, mode]);
  const showMarks = marks && sections !== null;
  const body = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [pop, setPop] = useState<Pop | null>(null);
  const [busy, setBusy] = useState(false);

  const measure = useCallback(() => {
    const root = body.current;
    if (!root || !showMarks) { setTicks([]); return; }
    const top = root.getBoundingClientRect().top - root.scrollTop;
    const total = Math.max(root.scrollHeight, 1);
    const view = root.clientHeight;
    setTicks([...root.querySelectorAll<HTMLElement>("[data-anchor]")].map((el) => ({
      key: el.dataset.anchor!, top: Math.round(12 + ((el.getBoundingClientRect().top - top) / total) * Math.max(view - 36, 0)),
    })));
  }, [showMarks]);
  useLayoutEffect(() => { measure(); }, [measure, sections]);
  useEffect(() => {
    const root = body.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(root);
    const doc = root.querySelector("article");
    if (doc) observer.observe(doc);
    return () => observer.disconnect();
  }, [measure]);

  const center = (el: Element, smooth: boolean) => {
    const root = body.current;
    if (!root) return;
    const y = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    root.scrollTo({ top: Math.max(0, y - root.clientHeight / 2), behavior: smooth ? "smooth" : "auto" });
  };
  // 打开时（换了文件或换了看哪一段）滚到第一处。
  const opened = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = `${data.path}:${data.range}`;
    if (opened.current === key) return;
    opened.current = key;
    const first = body.current?.querySelector("[data-anchor]");
    if (first) center(first, false);
  }, [data.path, data.range, sections]);

  // 点开的那一处加深底色；内容变了、关了「改动」、不能恢复了就收起浮层。
  useEffect(() => {
    const root = body.current;
    root?.querySelectorAll("[data-open]").forEach((el) => el.removeAttribute("data-open"));
    if (pop && root) for (const id of pop.ids) root.querySelectorAll(`[data-change~="${escapeAttr(id)}"]`).forEach((el) => el.setAttribute("data-open", ""));
  }, [pop, sections]);
  useEffect(() => { setPop(null); }, [sections, showMarks, restorable]);
  useEffect(() => {
    if (!pop) return;
    const away = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target && (popRef.current?.contains(target) || target.closest("[data-change]"))) return;
      setPop(null);
    };
    // 先于预览的「Esc 关」接住：浮层开着时 Esc 只收浮层。
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setPop(null); } };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", away, true); window.removeEventListener("keydown", escape, true); };
  }, [pop]);

  const pick = (event: MouseEvent) => {
    const root = body.current;
    const target = (event.target as Element).closest<HTMLElement>("[data-change]");
    if (!root || !target || !showMarks || !restorable) { setPop(null); return; }
    const ids = target.dataset.change!.split(" ");
    if (pop?.ids.join(" ") === ids.join(" ")) { setPop(null); return; }
    // 折了行的一处：浮层放在它最后一行的下面、对着那一行的开头。
    const lines = target.getClientRects();
    const rect = lines.length ? lines[lines.length - 1]! : target.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    setPop({ ids, top: rect.bottom - box.top + root.scrollTop + 6, left: Math.max(8, Math.min(rect.left - box.left + root.scrollLeft, root.clientWidth - 88)) });
  };
  const restore = async () => {
    if (!pop || busy) return;
    setBusy(true);
    try { await onRestore(pop.ids); setPop(null); } finally { setBusy(false); }
  };

  return (
    <div ref={body} className={`${bodyClass} ${c.body}`} data-testid="change-doc" data-marks={showMarks ? "on" : "off"}>
      {showMarks && ticks.length ? (
        <div className={c.rail}>
          {ticks.map((tick) => (
            <button key={tick.key} type="button" className={c.tick} style={{ top: tick.top }} aria-label="到这一处" data-testid="change-tick"
              onClick={() => { const el = body.current?.querySelector(`[data-anchor="${escapeAttr(tick.key)}"]`); if (el) center(el, true); }} />
          ))}
        </div>
      ) : null}
      <article className={docClass} onClick={pick}>
        {showMarks ? <ChangeView sections={sections!} mode={mode} /> : <DocChunk text={data.after ?? ""} mode={mode} />}
      </article>
      {pop ? <div ref={popRef} className={c.pop} style={{ top: pop.top, left: pop.left }}><button type="button" disabled={busy} onClick={() => void restore()} data-testid="change-restore">恢复</button></div> : null}
    </div>
  );
}
