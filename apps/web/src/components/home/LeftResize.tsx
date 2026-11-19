"use client";

/**
 * 栏宽能拖：左栏（17.2 第 24 条，改掉第 15 条的「不能拖」）拖右边缘，240–360；没拖过照 --home-left 的 clamp 随窗口变。
 * 右边的面板（11/11）拖左边缘，260–560；没拖过照 --home-right（288）。放文件时另记一个宽（第 73 条），360–1400，没拖过约占展示区一半（--home-file）。窗口窄时右栏让中栏至少留 480（CSS 里夹，见 home.module.css .app）。
 * 拖过记住本人的宽度（这台浏览器 localStorage，读写都包 try/catch），双击边缘回到默认；键盘聚焦把手后左右键一次 8。手机走抽屉，不画。
 * 左栏还能收起（设计 4.1，只电脑）：宽变 0，中间左上角一颗按钮（PanelLeft）开合；收没收起按这台电脑记。
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { PanelLeft } from "lucide-react";
import type { Project } from "@/lib/home/projects";
import { showUnseen, type SeenMarks } from "@/lib/home/seen";
import { LEFT_COLLAPSED_ATTR, LEFT_COLLAPSED_KEY } from "@/lib/home/leftCollapse";
import type { LocalPhase } from "@/lib/local/connection";
import { ICON } from "./StateIcon";
import h from "@/styles/home.module.css";

export const LEFT_MIN = 240;
export const LEFT_MAX = 360;
export const RIGHT_MIN = 260;
export const RIGHT_MAX = 560;
const STEP = 8;

type Spec = { key: string; min: number; max: number };
const LEFT: Spec = { key: "tianshu-home-left-width-v1", min: LEFT_MIN, max: LEFT_MAX };
const RIGHT: Spec = { key: "tianshu-home-right-width-v1", min: RIGHT_MIN, max: RIGHT_MAX };
const FILE: Spec = { key: "tianshu-home-file-width-v1", min: 360, max: 1400 };

const clampTo = (spec: Spec, width: number) => Math.round(Math.min(spec.max, Math.max(spec.min, width)));
export const clampLeft = (width: number) => clampTo(LEFT, width);
export const clampRight = (width: number) => clampTo(RIGHT, width);

function readSaved(spec: Spec): number | null {
  try {
    const value = Number(localStorage.getItem(spec.key));
    return Number.isFinite(value) && value > 0 ? clampTo(spec, value) : null;
  } catch { return null; }
}
function writeSaved(spec: Spec, width: number | null) {
  try { if (width === null) localStorage.removeItem(spec.key); else localStorage.setItem(spec.key, String(width)); } catch { /* 存不了就只在这一页 */ }
}

/** 本人拖过的宽度（没拖过为 null，用默认）；dragging 时根上停掉列宽的过渡，跟手。 */
function useColumnWidth(spec: Spec) {
  const [width, setWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => { setWidth(readSaved(spec)); }, [spec]);
  return {
    width, dragging, setDragging, min: spec.min, max: spec.max,
    set: (next: number, persist = true) => { const value = clampTo(spec, next); setWidth(value); if (persist) writeSaved(spec, value); },
    reset: () => { setWidth(null); writeSaved(spec, null); },
  };
}
export const useLeftWidth = () => useColumnWidth(LEFT);
export const useRightWidth = () => useColumnWidth(RIGHT);
export const useFileWidth = () => useColumnWidth(FILE);
type Control = ReturnType<typeof useColumnWidth>;

/**
 * 栏边缘的把手：悬停光标变左右拖、边缘出一条细线；拖、双击、左右键。
 * side 是把手在哪一栏：左栏的把手在右边缘（往右拖变宽），右栏的在左边缘（往左拖变宽）。
 */
function ColumnResize({ control, side, label }: { control: Control; side: "left" | "right"; label: string }) {
  const handle = useRef<HTMLDivElement>(null);
  const edge = useRef(0);
  const grow = side === "left" ? 1 : -1;
  // 当前宽度：拖过的照记下的（列宽在过渡时量出来的会落后）；没拖过量这一栏。
  const current = () => control.width ?? handle.current?.parentElement?.getBoundingClientRect().width ?? control.min;
  const widthAt = (x: number) => (x - edge.current) * grow;
  const down = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const rect = event.currentTarget.parentElement?.getBoundingClientRect();
    // 栏的另一边不动：左栏量左边，右栏量右边。
    edge.current = (side === "left" ? rect?.left : rect?.right) ?? 0;
    event.currentTarget.setPointerCapture(event.pointerId);
    control.setDragging(true);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (!control.dragging) return;
    control.set(widthAt(event.clientX), false);
  };
  const up = (event: PointerEvent<HTMLDivElement>) => {
    if (!control.dragging) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    control.setDragging(false);
    control.set(widthAt(event.clientX));
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    control.set(current() + (event.key === "ArrowRight" ? STEP : -STEP) * grow);
  };
  return (
    <div ref={handle} className={side === "left" ? h.leftHandle : h.rightHandle} role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0}
      aria-valuemin={control.min} aria-valuemax={control.max} aria-valuenow={Math.round(control.width ?? current())}
      data-dragging={control.dragging ? "" : undefined} data-testid={`${side}-resize`}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={control.reset} onKeyDown={keys} />
  );
}

export const LeftResize = ({ control }: { control: Control }) => <ColumnResize control={control} side="left" label="左栏宽度" />;
export const RightResize = ({ control }: { control: Control }) => <ColumnResize control={control} side="right" label="右栏宽度" />;

/**
 * 左栏收没收起：挂载后读这台电脑记的（首帧按展开，和服务端一致；收着时首屏脚本已经给 <html> 写上了，画面不先展开），
 * 开合时记下、跟着改 <html> 上那个属性；存不了就只在这一页。
 */
export function useLeftCollapsed(): { collapsed: boolean; toggle(): void } {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try { setCollapsed(localStorage.getItem(LEFT_COLLAPSED_KEY) === "1"); } catch { /* 读不了按展开 */ }
  }, []);
  const toggle = useCallback(() => {
    const next = !collapsed;
    setCollapsed(next);
    if (next) document.documentElement.setAttribute(LEFT_COLLAPSED_ATTR, "closed"); else document.documentElement.removeAttribute(LEFT_COLLAPSED_ATTR);
    try { if (next) localStorage.setItem(LEFT_COLLAPSED_KEY, "1"); else localStorage.removeItem(LEFT_COLLAPSED_KEY); } catch { /* 存不了就只在这一页 */ }
  }, [collapsed]);
  return { collapsed, toggle };
}

/** 收起那一刻：等你的件数，和已经没看的项目（各记那一刻的最近动静）。 */
export type LeftSnapshot = { waiting: number; unseen: ReadonlyMap<string, string> };

export function leftSnapshot(projects: Project[], seen: SeenMarks | undefined, waitingCount: number): LeftSnapshot {
  const unseen = new Map(projects.filter((project) => !project.scratch && showUnseen(project.unseen, seen, "project", project.id, project.lastActivity))
    .map((project) => [project.id, project.lastActivity ?? ""] as const));
  return { waiting: waitingCount, unseen };
}

/**
 * 收起期间有新东西（按钮上一颗蓝点，设计 4.1）：哪个项目出了没看过的蓝点（同左栏的「刚看过」），而收起那一刻（since）它没有、或那之后又有了新动静；
 * 或者等你的件数比那一刻多了。收起那一刻已经没看的不算。还没记下那一刻（刷新后数据没到）、展开了都不亮。「随手」项目不算（左栏不列它，本人 11/19）。
 */
export function leftUnseen({ collapsed, projects, seen, waitingCount, since }: {
  collapsed: boolean; projects: Project[]; seen?: SeenMarks; waitingCount: number; since: LeftSnapshot | null;
}): boolean {
  if (!collapsed || !since) return false;
  return waitingCount > since.waiting || projects.some((project) => !project.scratch && showUnseen(project.unseen, seen, "project", project.id, project.lastActivity)
    && since.unseen.get(project.id) !== (project.lastActivity ?? ""));
}

/**
 * 按钮上的蓝点：收起那一刻（since）记在这一页的内存里，展开就扔掉。等你的件数要等它的几样来源都到齐了再记——
 * 首页数据、会议（usePartnerMeetings 的 loaded）、本机程序报了连没连上（「这台电脑没连上」那一行）；
 * 收着刷新时它们先后到，先记就会把本来就有的当成新来的。
 */
export function useLeftDot({ collapsed, homeReady, meetingsLoaded, localPhase, projects, seen, waitingCount }: {
  collapsed: boolean; homeReady: boolean; meetingsLoaded: boolean; localPhase: LocalPhase; projects: Project[]; seen?: SeenMarks; waitingCount: number;
}): boolean {
  const settled = homeReady && meetingsLoaded && localPhase !== "checking";
  const [since, setSince] = useState<LeftSnapshot | null>(null);
  useEffect(() => {
    if (!collapsed) setSince(null);
    else if (since === null && settled) setSince(leftSnapshot(projects, seen, waitingCount));
  }, [collapsed, since, settled, projects, seen, waitingCount]);
  return leftUnseen({ collapsed, projects, seen, waitingCount, since });
}

/** 中间左上角的开合按钮（画在外壳上，所有页面都在）。 */
export function LeftToggle({ collapsed, unseen, onToggle }: { collapsed: boolean; unseen: boolean; onToggle: () => void }) {
  const label = collapsed ? "展开左栏" : "收起左栏";
  return (
    <button type="button" className={`${h.icon} ${h.leftToggle}`} aria-label={label} title={label} onClick={onToggle}
      data-unseen={unseen ? "" : undefined} data-testid="left-toggle">
      <PanelLeft {...ICON} />
      {unseen ? <i className={h.cornerDot} data-tone="accent" aria-hidden /> : null}
    </button>
  );
}
