"use client";

/**
 * 交付物：上面一排版本（v1 · 50、v2 · 评审中……，点哪个看哪个），下面是这一版的材料小条——类型小标、名字（点开原文件或链接）、
 * 读取状态（读不了时是原因，用警示色），最后是附的那句话。
 */
import type { TDeliverableVersion } from "@warmap/contracts";
import { itemState, itemTag, versionLabel } from "./deliverableFormat";
import d from "@/styles/task-deliverable.module.css";

export function VersionItems({ versions, selected, onPick, itemHref }: {
  /** 新的在前。 */
  versions: TDeliverableVersion[];
  selected: TDeliverableVersion;
  onPick: (versionId: string) => void;
  itemHref: (itemId: string) => string;
}) {
  return (
    <section className={d.section} aria-label="交付物">
      <div className={d.versionRow}>
        <h3 className={d.label}>交付物</h3>
        <div className={d.versions} role="tablist" aria-label="版本">
          {[...versions].reverse().map((version) => (
            <button key={version.id} type="button" role="tab" className={d.version} aria-selected={version.id === selected.id} onClick={() => onPick(version.id)}>
              {versionLabel(version)}
            </button>
          ))}
        </div>
      </div>
      {selected.items.length ? (
        <ul className={d.items}>
          {selected.items.map((item) => (
            <li key={item.id} className={d.item} data-kind={item.kind} data-read={item.read}>
              <span className={d.tag}>{itemTag(item)}</span>
              <a className={d.itemName} href={item.kind === "link" ? item.url ?? undefined : itemHref(item.id)} target="_blank" rel="noreferrer">{item.name}</a>
              <span className={d.itemState}>{itemState(item)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {selected.statement ? <p className={d.statement}>{selected.statement}</p> : null}
    </section>
  );
}
