"use client";

/**
 * 挑挂点（约会议、会议页页头「改」共用，样稿 anchor-picker-v1）：挑一个，点别的就是换。
 * - 上面一个搜索框，搜 Mission、LTO、PO（有字时下面直接列搜到的，每项写类型或负责人）。
 * - 没搜时：「我的 Mission」直接列；其余收成「别人的 Mission / LTO / PO」三行，点进去是二级（‹ 返回）。
 * - CEO（company）：先直接列公司目标（LTO、PO），再按战场一行一个，点进去是这个战场的 Mission。
 * - PO 二级：点一个 PO 就挂在它上面，下面展开服务这个 PO 的 Mission（parentId），再点其中一个就改挂到那个 Mission。
 * 选中的那行前面一个勾、浅底；草稿在名字后面写灰字「草稿」。没有分组框线、没有类型色块。责任单元不在这里列。
 */
import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import type { TWorldAnchor, TWorldAnchorOption } from "@warmap/contracts";
import d from "./meeting-decisions.module.css";

type View = "root" | "others" | "lto" | "po" | `group:${string}`;
const LEVEL: Record<"others" | "lto" | "po", string> = { others: "别人的 Mission", lto: "LTO", po: "PO" };
const OTHER_GROUP = "其他";
const levelName = (view: Exclude<View, "root">) => view.startsWith("group:") ? view.slice(6) : LEVEL[view as keyof typeof LEVEL];
const same = (a: Pick<TWorldAnchor, "kind" | "id">, b: Pick<TWorldAnchor, "kind" | "id">) => a.kind === b.kind && a.id === b.id;

/** 已选挂点下面那行灰字：我的 Mission / 某某的 Mission / LTO / PO（约会议收起时那一行也用）。 */
export function anchorRole(option: Pick<TWorldAnchorOption, "kind" | "ownerId">, viewerId: string, nameOf?: (personId: string) => string): string {
  if (option.kind === "mission") {
    if (option.ownerId === viewerId) return "我的 Mission";
    const name = option.ownerId ? nameOf?.(option.ownerId) : "";
    return name ? `${name}的 Mission` : "Mission";
  }
  return option.kind === "po" ? "PO" : option.kind === "lto" ? "LTO" : "";
}

export function WorldAnchorPicker({ options, value, onChange, viewerId = "", nameOf, company = false }: {
  options: TWorldAnchorOption[]; value: TWorldAnchor[]; onChange(next: TWorldAnchor[]): void;
  /** 登录的人：负责人是他的 Mission 列在最前。 */
  viewerId?: string;
  /** personId → 名字：别人的 Mission 下面写负责人。 */
  nameOf?: (personId: string) => string;
  /** CEO 约会：公司目标在前，Mission 按战场分组。 */
  company?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("root");
  const pickable = useMemo(() => options.filter((option) => option.kind !== "unit"), [options]);
  const missions = pickable.filter((option) => option.kind === "mission");
  const mine = missions.filter((option) => option.ownerId === viewerId);
  const others = missions.filter((option) => option.ownerId !== viewerId);
  const ltos = pickable.filter((option) => option.kind === "lto");
  const pos = pickable.filter((option) => option.kind === "po");
  const childrenOf = (po: TWorldAnchorOption) => missions.filter((option) => option.parentId === po.id);
  const isOn = (option: TWorldAnchorOption) => value.some((item) => same(item, option));
  const pick = (option: TWorldAnchorOption) => onChange([{ kind: option.kind, id: option.id, title: option.title }]);
  const ownerOf = (option: TWorldAnchorOption) => (option.ownerId ? nameOf?.(option.ownerId) : "") || "";
  const groups = useMemo(() => {
    const byName = new Map<string, TWorldAnchorOption[]>();
    for (const option of missions) byName.set(option.group ?? OTHER_GROUP, [...(byName.get(option.group ?? OTHER_GROUP) ?? []), option]);
    return [...byName].sort(([a], [b]) => Number(a === OTHER_GROUP) - Number(b === OTHER_GROUP) || a.localeCompare(b, "zh-CN"));
  }, [missions]);

  const row = (option: TWorldAnchorOption, sub?: string) => (
    <li key={`${option.kind}:${option.id}`}>
      <button type="button" className={d.pickOption} aria-pressed={isOn(option)} onClick={() => pick(option)}>
        <span className={d.pickCheck} aria-hidden="true">{isOn(option) ? <Check size={14} strokeWidth={2.2} /> : null}</span>
        <span className={d.pickText}>
          {option.title}
          {option.lifecycle === "draft" ? <span className={d.pickDraft}>草稿</span> : null}
          {sub ? <small>{sub}</small> : null}
        </span>
      </button>
    </li>
  );
  const level = (target: Exclude<View, "root">, count: number) => count ? (
    <li key={target}>
      <button type="button" className={d.pickOption} data-level={target} onClick={() => setView(target)}>
        <span className={d.pickCheck} aria-hidden="true" />
        <span className={d.pickText}>{levelName(target)}</span>
        <span className={d.pickCount}>{count} ›</span>
      </button>
    </li>
  ) : null;

  // PO：选中它、或选中了它下面的 Mission 时，下面展开服务这个 PO 的 Mission。
  const poRow = (option: TWorldAnchorOption) => {
    const children = childrenOf(option);
    const open = children.length > 0 && (isOn(option) || children.some(isOn));
    return [row(option, children.length ? `${children.length} 个 Mission` : company ? "PO" : undefined),
      open ? <li key={`${option.id}:children`}><ul className={d.pickChildren}>{children.map((child) => row(child, ownerOf(child)))}</ul></li> : null];
  };

  const needle = query.trim().toLowerCase();
  let body;
  if (needle) {
    const found = pickable.filter((option) => `${option.title} ${option.brief ?? ""}`.toLowerCase().includes(needle));
    body = found.length
      ? <ul>{found.map((option) => row(option, anchorRole(option, viewerId, nameOf)))}</ul>
      : <p className={d.pickEmpty}>没有搜到</p>;
  } else if (view === "root" && company) {
    body = <>
      {ltos.length || pos.length ? <><h4>公司目标</h4><ul>{ltos.map((option) => row(option, "LTO"))}{pos.map(poRow)}</ul></> : null}
      {groups.length ? <><h4>战场</h4><ul>{groups.map(([name, list]) => level(`group:${name}`, list.length))}</ul></> : null}
    </>;
  } else if (view === "root") {
    body = <>
      {mine.length ? <><h4>我的 Mission</h4><ul>{mine.map((option) => row(option))}</ul></> : null}
      {mine.length ? <h4>其他</h4> : null}
      <ul>{level("others", others.length)}{level("lto", ltos.length)}{level("po", pos.length)}</ul>
    </>;
  } else {
    const grouped = view.startsWith("group:") ? groups.find(([name]) => `group:${name}` === view)?.[1] ?? [] : null;
    const list = grouped ?? (view === "others" ? others : view === "lto" ? ltos : pos);
    body = <>
      <button type="button" className={d.pickBack} onClick={() => setView("root")}>‹ {levelName(view)}</button>
      <ul>
        {list.map((option) => grouped || view === "others" ? row(option, ownerOf(option)) : view === "lto" ? row(option) : poRow(option))}
      </ul>
    </>;
  }

  return (
    <div className={d.picker}>
      <input type="search" aria-label="搜对象" placeholder="搜 Mission、LTO、PO" value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className={d.pickList}>{body}</div>
    </div>
  );
}
