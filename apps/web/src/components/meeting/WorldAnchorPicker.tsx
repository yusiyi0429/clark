"use client";

/**
 * 挑挂点（约会议、会议页页头「改」共用）：上面是已选的标签（可去掉），一个搜索框，下面按 PO / LTO / Mission / 单元 分组列候选。
 * 每项一行名称 + 类型（草稿再加「草稿」），下一行灰字是对象已确认的内容（brief）。点一项选上，再点取消。
 */
import { useMemo, useState } from "react";
import type { TWorldAnchor, TWorldAnchorOption } from "@warmap/contracts";
import { WorldAnchors } from "./WorldAnchors";
import d from "./meeting-decisions.module.css";

const GROUPS = [["po", "PO"], ["lto", "LTO"], ["mission", "Mission"], ["unit", "单元"]] as const;
const KIND = Object.fromEntries(GROUPS) as Record<TWorldAnchorOption["kind"], string>;
const same = (a: Pick<TWorldAnchor, "kind" | "id">, b: Pick<TWorldAnchor, "kind" | "id">) => a.kind === b.kind && a.id === b.id;
/** lifecycle 是草稿（本体的 draft、Mission 轮次没确认）。 */
const isDraftLifecycle = (lifecycle: string | null) => Boolean(lifecycle && /草稿|draft/i.test(lifecycle));

export function WorldAnchorPicker({ options, value, onChange, min = 0 }: {
  options: TWorldAnchorOption[]; value: TWorldAnchor[]; onChange(next: TWorldAnchor[]): void;
  /** 至少留几个：已选到这个数时标签上不给去掉。 */
  min?: number;
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? options.filter((option) => `${option.title} ${option.brief ?? ""}`.toLowerCase().includes(needle)) : options;
  }, [options, query]);
  const toggle = (option: TWorldAnchor) => {
    if (value.some((item) => same(item, option))) {
      if (value.length > min) onChange(value.filter((item) => !same(item, option)));
    } else onChange([...value, { kind: option.kind, id: option.id, title: option.title }]);
  };

  return (
    <div className={d.picker}>
      {value.length ? <WorldAnchors anchors={value} onRemove={value.length > min ? toggle : undefined} /> : null}
      <input type="search" aria-label="搜对象" placeholder="搜对象" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className={d.pickList}>
        {GROUPS.map(([kind, label]) => {
          const items = shown.filter((option) => option.kind === kind);
          return items.length ? (
            <section key={kind} className={d.pickGroup} aria-label={label}>
              <h4>{label}</h4>
              <ul>
                {items.map((option) => (
                  <li key={`${option.kind}:${option.id}`}>
                    <button type="button" className={d.pickOption} aria-pressed={value.some((item) => same(item, option))} onClick={() => toggle(option)}>
                      <span className={d.pickHead}>
                        <span className={d.pickTitle}>{option.title}</span>
                        <span className={d.pickKind}>{KIND[option.kind]}</span>
                        {isDraftLifecycle(option.lifecycle) ? <span className={d.pickDraft}>草稿</span> : null}
                      </span>
                      {option.brief && option.brief !== option.title ? <span className={d.pickBrief}>{option.brief}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null;
        })}
      </div>
    </div>
  );
}
