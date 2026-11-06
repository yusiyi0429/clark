"use client";

/**
 * 右栏（新首页设计 5.4.5）：资源块 → 发丝线 →「进行中 N」→「已完成 N」，不写标题。跟着展示区走（首页列全部，二级页只留资源块）。
 * - 资源块：「这台电脑 · 就绪」（七种状态：检查中、等浏览器允许、被拦截、离线、未配对、暂停中、就绪；没就绪的前面一个琥珀点，下面一行一个次按钮：
 *   配对、继续或重试）；位置条（用着的 --ink-muted，空的发丝线，不上色）+「2/3」+ 模型。额度行等本机程序给 quota 再加（只显示读得到的）。
 * - 后台任务：组头 12/16 600 淡色，「进行中」前面一颗转圈（整栏只有它在转）；「已完成」默认收起，有失败时自动展开、组头后面加「· 失败 1」。
 *   行高 36：种类、名字、用时，停止按钮鼠标移上去或有焦点时才出（手持上一直显示），不能停的不画。行里不放状态图标，失败的行首一个叉、用时换成「失败」，
 *   停了的用时换成「已停止」。后台任务点不进去，行没有悬停底。
 * - 收起后是 44 宽的细条：展开键；有在跑的是转圈加数字；本机要处理时一个琥珀点。
 */
import { useEffect, useState } from "react";
import { ChevronRight, LoaderCircle, PanelRightClose, PanelRightOpen, Square, X } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { Slots } from "@/components/work/Slots";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import type { LocalPhase } from "@/lib/local/connection";
import { duration, groupBackground } from "@/lib/home/derive";
import type { BackgroundItem } from "@/lib/home/types";
import type { Resources } from "@/lib/work/useWork";
import { ICON } from "./StateIcon";
import h from "@/styles/home.module.css";

const KIND: Record<BackgroundItem["kind"], string> = { plan: "规划", verify: "验收", merge: "合回", subagent: "子 agent", command: "命令" };
const PHASE: Record<LocalPhase, string> = { checking: "检查中", prompt: "等浏览器允许", blocked: "被拦截", offline: "离线", unpaired: "未配对", ready: "就绪" };

/** 这台电脑现在是什么状态、要不要本人动手（本人行、细条上的琥珀点也用这个）。 */
export function useMachine() {
  const local = useLocalRunner();
  const paused = local.phase === "ready" && !!local.status?.settings.paused;
  const word = paused ? "暂停中" : PHASE[local.phase];
  const alert = paused || local.phase === "prompt" || local.phase === "blocked" || local.phase === "offline" || local.phase === "unpaired";
  const action = local.phase === "unpaired" ? { label: "配对", run: () => local.pair() }
    : paused ? { label: "继续", run: async () => { await local.runner.patchSettings({ paused: false }); await local.refresh(); } }
    : local.phase === "offline" || local.phase === "blocked" || local.phase === "prompt" ? { label: "重试", run: () => local.refresh() }
    : null;
  return { word, alert, action };
}

export function BackgroundPanel({ items, resources, model, onStop, onCollapse, handheld = false }: {
  items: BackgroundItem[];
  resources: Resources;
  /** 默认用的模型（本机的默认档）。 */
  model: string | null;
  onStop: (item: BackgroundItem) => Promise<void>;
  /** 桌面：收成细条（手机抽屉没有，点外面或 Esc 关）。 */
  onCollapse?: () => void;
  handheld?: boolean;
}) {
  const groups = groupBackground(items);
  const now = useNow(groups.running.some((item) => item.state === "running"));
  const machine = useMachine();
  const [stopping, setStopping] = useState<string | null>(null);
  const failed = groups.finished.filter((item) => item.state === "failed").length;
  const [open, setOpen] = useState(false);
  const finishedOpen = open || failed > 0;
  const [acting, setActing] = useState(false);
  const stop = async (item: BackgroundItem) => {
    setStopping(item.id);
    try { await onStop(item); } finally { setStopping(null); }
  };
  const row = (item: BackgroundItem) => (
    <li key={item.id} className={h.bgRow} data-state={item.state} data-handheld={handheld ? "" : undefined} data-testid="bg-row">
      {item.state === "failed" ? <span className={h.bgFail}><X {...ICON} aria-label="失败" /></span> : null}
      <span className={h.bgKind}>{KIND[item.kind]}</span>
      <span className={h.bgTitle} title={item.title}>{item.title}</span>
      <span className={h.bgTime}>{item.state === "failed" ? "失败" : item.state === "stopped" ? "已停止" : item.state === "queued" ? "已排队" : duration(item.startedAt, item.finishedAt ?? now)}</span>
      {item.stoppable && (item.state === "running" || item.state === "queued") ? (
        <span className={h.bgStop}>
          <HeroButton variant="ghost" size="sm" isIconOnly title="停止" aria-label={`停止 ${item.title}`} isDisabled={stopping === item.id} onPress={() => void stop(item)}><Square {...ICON} /></HeroButton>
        </span>
      ) : null}
    </li>
  );
  return (
    <div className={h.bg} data-testid="background-panel">
      <div className={h.bgHead} data-testid="resources">
        <div className={h.resLine}>
          {machine.alert ? <i className={h.warnDot} aria-hidden /> : null}
          <span className={h.resName}>这台电脑</span><span className={h.resWord}> · {machine.word}</span>
          <span className={h.grow} />
          {onCollapse ? <HeroButton variant="ghost" size="sm" isIconOnly title="收起" aria-label="收起" onPress={onCollapse}><PanelRightClose {...ICON} /></HeroButton> : null}
        </div>
        {machine.action ? (
          <div className={h.resLine}>
            <HeroButton variant="tertiary" size="sm" isDisabled={acting} onPress={() => { setActing(true); void machine.action!.run().finally(() => setActing(false)); }}>{machine.action.label}</HeroButton>
          </div>
        ) : null}
        <div className={h.resMeta}>
          <Slots used={resources.local.used} cap={resources.local.cap} off={!resources.local.online} />
          <span className={h.num}>{resources.local.used}/{resources.local.cap}</span>
          {model ? <span className={h.resModel}>{model}</span> : null}
        </div>
      </div>
      <div className={h.bgBody}>
        {groups.running.length ? (
          <section aria-label="进行中" className={h.bgGroup}>
            <p className={h.bgLabel}><LoaderCircle {...ICON} className={h.bgSpin} />进行中 <span className={h.num}>{groups.running.length}</span></p>
            <ul>{groups.running.map(row)}</ul>
          </section>
        ) : null}
        {groups.finished.length ? (
          <section aria-label="已完成" className={h.bgGroup}>
            <button type="button" className={h.bgLabel} aria-expanded={finishedOpen} onClick={() => setOpen(!finishedOpen)}>
              <ChevronRight {...ICON} className={h.chevron} data-open={finishedOpen ? "" : undefined} />已完成 <span className={h.num}>{groups.finished.length}</span>
              {failed ? <span className={h.bgFailCount}> · 失败 {failed}</span> : null}
            </button>
            {finishedOpen ? <ul>{groups.finished.map(row)}</ul> : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}

/** 收起后的细条：展开键；有在跑的是转圈加数字；本机要处理时一个琥珀点。 */
export function BackgroundStrip({ running, onExpand }: { running: number; onExpand: () => void }) {
  const machine = useMachine();
  return (
    <button type="button" className={h.strip} onClick={onExpand} aria-label={`展开，进行中 ${running}`} title="展开" data-testid="background-strip">
      <PanelRightOpen {...ICON} />
      {running ? <span className={h.runningCount}><LoaderCircle {...ICON} />{running}</span> : null}
      {machine.alert ? <i className={h.warnDot} aria-label="这台电脑要处理" role="img" /> : null}
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
