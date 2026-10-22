"use client";

/**
 * 落点标签（回流设计稿 2）：写进本体时挂到的对象，「类型 名称」一枚（类型和名称一样时只写一次，如公司）。
 * 样子沿用影响卡的「落到」一排（ImpactFace 的 targets）。
 */
import { Building2, Flag, Layers, ListTodo, Mountain, Target } from "lucide-react";
import type { TWorldAnchor } from "@warmap/contracts";
import d from "./meeting-decisions.module.css";

const ICON = { lto: Mountain, po: Flag, mission: Target, task: ListTodo, unit: Layers, company: Building2 } as const;
const KIND = { lto: "LTO", po: "PO", mission: "Mission", task: "Task", unit: "单元", company: "公司" } as const;

export function WorldAnchors({ anchors, onRemove }: { anchors: TWorldAnchor[]; onRemove?: (anchor: TWorldAnchor) => void }) {
  if (!anchors.length) return null;
  return (
    <ul className={d.anchors} aria-label="挂到">
      {anchors.map((anchor) => {
        const Icon = ICON[anchor.kind];
        return (
          <li key={`${anchor.kind}:${anchor.id}`} className={d.anchor}>
            <Icon size={14} aria-hidden="true" />
            {KIND[anchor.kind] !== anchor.title ? <span className={d.anchorKind}>{KIND[anchor.kind]}</span> : null}
            <span className={d.anchorTitle}>{anchor.title}</span>
            {onRemove ? <button type="button" className={d.anchorRemove} aria-label={`去掉 ${anchor.title}`} onClick={() => onRemove(anchor)}>×</button> : null}
          </li>
        );
      })}
    </ul>
  );
}
