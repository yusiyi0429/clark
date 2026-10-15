"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type Ref } from "react";
import { formatDate, richTitle, roadmapEnd, roadmapReferenceYear, type RoadmapBlock } from "./parse";
import { ROADMAP_ROW_HEIGHT, ROADMAP_STATUS_TEXT, roadmapItemDates, roadmapLayout, type RoadmapLayout } from "./roadmapLayout";
import r from "@/styles/rich-blocks.module.css";

/**
 * 多泳道路线图（```roadmap，版式见 roadmapLayout.ts）：量时间轴的宽度，先在正文栏里排；放不下才加宽成横向滚动，
 * 两侧渐隐、下方一行「左右滑动查看完整时间轴」，泳道名在滚动时贴住左边。
 * 每项是一行名称加下面一道细条（单点是圆点）。状态不加新颜色：已确认蓝色实条、计划灰色实条、推断灰色虚线框（圆点同一套）；「现在」一条蓝色竖线。
 */
export function Roadmap({ block }: { block: RoadmapBlock }) {
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [edges, setEdges] = useState({ start: false, end: false });
  const layout = roadmapLayout(block, width);
  useLayoutEffect(() => {
    const element = track.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      setWidth(Math.max(0, element.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0")));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const readEdges = () => {
    const element = track.current;
    if (!element) return;
    const next = { start: element.scrollLeft > 2, end: element.scrollLeft + element.clientWidth < element.scrollWidth - 2 };
    setEdges((previous) => (previous.start === next.start && previous.end === next.end ? previous : next));
  };
  useLayoutEffect(readEdges, [layout.mode, layout.width]);
  return <RoadmapBody block={block} layout={layout} trackRef={track} onScroll={readEdges}
    edges={layout.mode === "scroll" ? edges : { start: false, end: false }} hint={width > 0 && layout.mode === "scroll"} />;
}

/** 路线图的画法（纯展示，版式由外面给）。 */
export function RoadmapBody({ block, layout, trackRef, onScroll, edges = { start: false, end: false }, hint = layout.mode === "scroll" }: {
  block: RoadmapBlock; layout: RoadmapLayout; trackRef?: Ref<HTMLDivElement>; onScroll?: () => void; edges?: { start: boolean; end: boolean }; hint?: boolean;
}) {
  const year = roadmapReferenceYear(block);
  const title = richTitle(block);
  const itemCount = block.lanes.reduce((sum, lane) => sum + lane.items.length, 0);
  const span = `${block.now ? `${formatDate(block.now, year)}起` : ""}至 ${formatDate(roadmapEnd(block), year)}`;
  const canvas = { width: layout.mode === "scroll" ? `${layout.width}px` : "100%" } as CSSProperties;
  return (
    <figure className={r.block} data-rich="roadmap" data-layout={layout.mode}>
      <figcaption className={r.head}>
        <span className={r.title}>{title}</span>
        <span className={r.meta}>{span}</span>
      </figcaption>
      <div ref={trackRef} className={`${r.track} ${r.rmTrack}`} tabIndex={0} onScroll={onScroll}
        aria-label={`${title}，${block.lanes.length} 条主线，${itemCount} 项`}
        data-more-start={edges.start || undefined} data-more-end={edges.end || undefined}>
        <div className={r.rmCanvas} style={canvas}>
          <div className={r.rmAxis} aria-hidden>
            {layout.ticks.map((tick, index) => (
              <span key={index} className={r.rmTick} style={{ left: tick.left }} data-hidden={tick.hidden || undefined}>{tick.label}</span>
            ))}
            {layout.now ? <span className={r.rmNowLabel} style={{ left: layout.now.labelLeft }}>现在</span> : null}
          </div>
          <div className={r.rmGrid} aria-hidden>
            {layout.ticks.map((tick, index) => <span key={index} className={r.rmGridLine} style={{ left: tick.left }} />)}
            {layout.now ? <span className={r.rmNowLine} style={{ left: layout.now.left }} /> : null}
          </div>
          {layout.lanes.map((lane, laneIndex) => (
            <section key={laneIndex} className={r.rmLane} aria-label={lane.label}>
              <h4 className={r.rmLaneLabel}>{lane.label}</h4>
              <ul className={r.rmRows} style={{ height: lane.rows * ROADMAP_ROW_HEIGHT }}>
                {lane.items.map((placed, index) => {
                  const dates = roadmapItemDates(placed.item, year, formatDate);
                  const status = ROADMAP_STATUS_TEXT[placed.item.status];
                  return (
                    <li key={index} className={r.rmItem} data-status={placed.item.status} data-shape={placed.point ? "point" : "bar"} data-label={placed.labelSide}
                      style={{ top: placed.row * ROADMAP_ROW_HEIGHT }} aria-label={`${placed.item.label}，${dates}，${status}`} title={`${placed.item.label} · ${dates} · ${status}`}>
                      <span className={r.rmMark} style={{ left: placed.left, width: placed.width }} aria-hidden />
                      <span className={r.rmLabel} style={{ left: placed.labelLeft }} aria-hidden>{placed.item.label}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
      {layout.statuses.length > 1 || layout.statuses.includes("inferred") ? (
        <ul className={r.rmLegend} aria-label="图例">
          {layout.statuses.map((status) => (
            <li key={status} data-status={status}><span className={r.rmSwatch} aria-hidden />{ROADMAP_STATUS_TEXT[status]}</li>
          ))}
        </ul>
      ) : null}
      {hint ? <p className={r.scrollHint} data-rich-scroll-hint="">左右滑动查看完整时间轴</p> : null}
    </figure>
  );
}
