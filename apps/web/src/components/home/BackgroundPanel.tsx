"use client";

/**
 * 右栏：后台任务（新首页设计第 3 节）。跟着展示区走：看哪条对话，就列哪条开出去的后台任务（首页列全部）。
 * - 第一行是资源：本机在不在线、几个位置用了几个、模型、今天的花费。
 * - 「进行中 N」「已完成 N」两组（排着的在进行中那组后面，空心圈）。每行名字、用时、停止按钮；失败写「失败」。行点不进去。
 * - 收起后只剩一个细条，上面写进行中的数量。手机上从页头的图标打开，是底部抽屉。
 */
import { useEffect, useState } from "react";
import { LoaderCircle, PanelRightClose, PanelRightOpen, Square } from "lucide-react";
import { Slots } from "@/components/work/Slots";
import { duration, groupBackground } from "@/lib/home/derive";
import type { BackgroundItem } from "@/lib/home/types";
import type { Resources } from "@/lib/work/useWork";
import { StateIcon } from "./StateIcon";
import h from "@/styles/home.module.css";

const ICON = { size: 16, strokeWidth: 1.5, "aria-hidden": true } as const;
const money = (usd: number | null) => (usd === null ? null : `${usd.toFixed(2)}`);

export function BackgroundPanel({ items, resources, model, onStop, onCollapse }: {
  items: BackgroundItem[];
  resources: Resources;
  /** 默认用的模型（本机的默认档）。 */
  model: string | null;
  onStop: (item: BackgroundItem) => Promise<void>;
  /** 桌面：收成细条（手机抽屉没有，点外面或 Esc 关）。 */
  onCollapse?: () => void;
}) {
  const groups = groupBackground(items);
  const now = useNow(groups.running.some((item) => item.state === "running"));
  const [stopping, setStopping] = useState<string | null>(null);
  const stop = async (item: BackgroundItem) => {
    setStopping(item.id);
    try { await onStop(item); } finally { setStopping(null); }
  };
  const row = (item: BackgroundItem) => (
    <li key={item.id} className={h.bgRow} data-state={item.state} data-testid="bg-row">
      <StateIcon state={item.state} />
      <span className={h.bgTitle} title={item.title}>{item.title}</span>
      <span className={h.bgTime}>{item.state === "failed" ? "失败" : item.state === "stopped" ? "已停止" : item.state === "queued" ? "已排队" : duration(item.startedAt, item.finishedAt ?? now)}</span>
      {item.stoppable && (item.state === "running" || item.state === "queued") ? (
        <button type="button" className={h.icon} aria-label={`停止 ${item.title}`} title="停止" disabled={stopping === item.id} onClick={() => void stop(item)}><Square {...ICON} /></button>
      ) : <span className={h.bgStopGap} />}
    </li>
  );
  return (
    <div className={h.bg} data-testid="background-panel">
      <div className={h.bgHead}>
        <span className={h.res} data-testid="resources">
          <i className={h.live} data-off={!resources.local.online || undefined} aria-hidden />
          <span>本机</span>
          <Slots used={resources.local.used} cap={resources.local.cap} off={!resources.local.online} />
          <span className={h.num}>{resources.local.used}/{resources.local.cap}</span>
          {model ? <span className={h.resSep}>{model}</span> : null}
          {money(resources.todayUsd) ? <span className={h.resSep}>今天 <span className={h.num}>{money(resources.todayUsd)}</span></span> : null}
        </span>
        {onCollapse ? <button type="button" className={h.icon} aria-label="收起" title="收起" onClick={onCollapse}><PanelRightClose {...ICON} /></button> : null}
      </div>
      <div className={h.bgBody}>
        {groups.running.length ? (
          <section aria-label="进行中" className={h.bgGroup}>
            <p className={h.bgLabel}>进行中 <span>{groups.running.length}</span></p>
            <ul>{groups.running.map(row)}</ul>
          </section>
        ) : null}
        {groups.finished.length ? (
          <section aria-label="已完成" className={h.bgGroup}>
            <p className={h.bgLabel}>已完成 <span>{groups.finished.length}</span></p>
            <ul>{groups.finished.map(row)}</ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

/** 收起后的细条：展开键，下面是进行中的数量。 */
export function BackgroundStrip({ running, onExpand }: { running: number; onExpand: () => void }) {
  return (
    <button type="button" className={h.strip} onClick={onExpand} aria-label={`后台任务，进行中 ${running}`} title="后台任务" data-testid="background-strip">
      <PanelRightOpen {...ICON} />
      {running ? <span className={h.stripCount}><LoaderCircle {...ICON} />{running}</span> : null}
    </button>
  );
}

/** 用时每秒走，只在有在跑的时候。 */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}
