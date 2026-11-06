"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { parseSourceRef, shortDate } from "@/cards/meetingSources";
import { cleanDisplayText } from "@/lib/displayText";
import d from "@/styles/decision-workspace.module.css";
import s from "@/styles/citation-panel.module.css";

/**
 * 本体出处（cite:world:<object_id>@<version>）：浮层写「本体 · 类型 · 第几版」，依据面板里是出处卡——
 * 标题、状态、负责人和当前进展（摘要和日期）。数据走天枢的只读接口 GET /api/ontology/objects/:id（按本人授权的域读），网页不直连本体。
 */

type WorldSourceView = components["schemas"]["WorldSourceView"];
type WorldLoad ={ state: "loading" } | { state: "missing" } | { state: "error" } | { state: "ready"; source: WorldSourceView };

const TYPE_LABELS: Record<string, string> = {
  Company: "公司", Strategy: "战略", LongTermGoal: "长期目标", PeriodGoal: "周期目标", ResponsibilityUnit: "责任单元", Activity: "执行事项",
};
const worldTypeLabel = (type: string): string => TYPE_LABELS[type] ?? type;

/** 第二行：本体 · 类型 · 引用时第几版；本体里已经有更新的版本时注明。 */
export function worldLocator(version: number, source?: WorldSourceView): string {
  return ["本体", source ? worldTypeLabel(source.type) : null, `第 ${version} 版`, source && source.version > version ? "已有新版" : null].filter(Boolean).join(" · ");
}

/** 同一对象一页里只读一次；读不到（本体暂时不可用）的不记住，下次再读。 */
const loads = new Map<string, Promise<WorldLoad>>();
function loadWorldSource(objectId: string): Promise<WorldLoad> {
  const cached = loads.get(objectId);
  if (cached) return cached;
  const next = browserApi.GET("/api/ontology/objects/{id}", { params: { path: { id: objectId } } }).then(
    ({ data, response }): WorldLoad => (data ? { state: "ready", source: data } : response.status === 404 ? { state: "missing" } : { state: "error" }),
    (): WorldLoad => ({ state: "error" }),
  );
  loads.set(objectId, next);
  void next.then((result) => { if (result.state === "error") loads.delete(objectId); });
  return next;
}

/** 一条出处对应的本体对象；不是 world: 出处时为 null。active 时才去读（浮层、底部弹层、面板打开时）。 */
export function useWorldSource(ref: string | null, active: boolean): WorldLoad | null {
  const parsed = ref ? parseSourceRef(ref) : null;
  const objectId = parsed?.kind === "world" ? parsed.objectId : null;
  const [result, setResult] = useState<{ objectId: string; load: WorldLoad } | null>(null);
  useEffect(() => {
    if (!objectId || !active) return;
    let alive = true;
    void loadWorldSource(objectId).then((load) => { if (alive) setResult({ objectId, load }); });
    return () => { alive = false; };
  }, [objectId, active]);
  if (!objectId) return null;
  return result?.objectId === objectId ? result.load : { state: "loading" };
}

/** 依据面板里的出处卡（同议题依据一套 .drawer）。 */
export function WorldEvidence({ citeRef, trigger, onClose }: { citeRef: string; trigger: HTMLElement | null; onClose: () => void }) {
  const parsed = parseSourceRef(citeRef);
  const load = useWorldSource(citeRef, true) ?? { state: "missing" };
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose);
  close.current = () => {
    onClose();
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  };
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    // Esc 先关面板：标记已处理，外壳这一次不收放大。
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  const source = load.state === "ready" ? load.source : undefined;
  const title = source?.title ?? "本体对象";
  const progress = source?.progress;
  return (
    <aside className={d.drawer} role="dialog" aria-modal="false" aria-label={`依据：${title}`} data-source-drawer>
      <header className={d.drawerHead}>
        <div>
          <small>{worldLocator(parsed.kind === "world" ? parsed.version : 0, source)}</small>
          <h2>{title}</h2>
        </div>
        <button ref={closeRef} type="button" className={d.drawerClose} onClick={() => close.current()} aria-label="关闭依据">
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <div className={d.drawerBody}>
        {load.state === "loading" ? <p className={d.muted} role="status">正在读取…</p>
          : load.state === "missing" ? <p className={d.muted} role="alert">读不到这个本体对象，可能已删除或不在你可读的范围里。</p>
            : load.state === "error" ? <p className={d.muted} role="alert">本体暂时读不到，请稍后再试。</p>
              : (
                <>
                  <p className={d.drawerMeta}>{[load.source.status, load.source.owners.length ? `负责人：${load.source.owners.join("、")}` : null].filter(Boolean).join(" · ")}</p>
                  <section className={s.block} aria-label="当前进展">
                    <h3>当前进展</h3>
                    {progress ? (
                      <>
                        <p className={d.drawerMeta}>{[shortDate(progress.asOf), progress.author, progress.unconfirmed ? "未确认" : null].filter(Boolean).join(" · ")}</p>
                        <ul>{progress.lines.map((line, index) => <li key={index}>{cleanDisplayText(line)}</li>)}</ul>
                      </>
                    ) : <p className={d.muted}>还没有进展记录</p>}
                  </section>
                </>
              )}
      </div>
    </aside>
  );
}
