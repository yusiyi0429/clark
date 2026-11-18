"use client";

/**
 * 右栏（新首页设计 5.4.5）：资源块 → 发丝线 →「进行中 N」→「已完成 N」，不写标题。跟着展示区走（首页列全部，二级页只留资源块）。
 * - 资源块（14.4）：「这台电脑 · 就绪」一行能点开，逐项列本机程序、Claude Code、Codex、gh、飞书命令行（照本机报的 tools）；有一项不对就前面一个琥珀点、
 *   自动展开，下面一个次按钮（配对、继续或重试；重试真的再探一遍）；离线时上面先给安装命令和「复制」（同连接页）。「在跑的子会话」+ 位置条 +「2/3」（这台电脑就绪时才有）。「剩余用量」两列小格（见 lib/home/quota）：
 *   这台电脑就绪时用本机的，不然用云端各台设备报的（只显示读得到的）。
 * - 后台任务：组头 12/16 600 淡色，「进行中」前面一颗转圈（整栏只有它在转）；「已完成」默认收起，有失败时自动展开、组头后面加「· 失败 1」。
 *   行高 36：种类、名字、用时，停止按钮鼠标移上去或有焦点时才出（手持上一直显示），不能停的不画。行里不放状态图标，失败的行首一个叉、用时换成「失败」，
 *   停了的用时换成「已停止」，停着等额度恢复的换成「等额度恢复 · 08:00」。后台任务点不进去，行没有悬停底。
 * 这一整块（带资源块）给手机的底部抽屉用；电脑上（设计 4.3）右边的会话面板里放资源块（MachineBlock）和后台任务两组（BackgroundTasks）。
 */
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, LoaderCircle, Square, X } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { MANY_SESSIONS, Slots } from "@/components/work/Slots";
import { FailedLine } from "@/components/work/DecisionBox";
import { LocalInstall, isMac } from "@/components/local/PluginsPage";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import type { LocalPhase } from "@/lib/local/connection";
import { duration, groupBackground, queueText } from "@/lib/home/derive";
import { usageCells, type UsageCell } from "@/lib/home/quota";
import type { BackgroundItem } from "@/lib/home/types";
import type { Resources } from "@/lib/work/useWork";
import type { TLocalToolStatus } from "@warmap/contracts";
import { ICON } from "./StateIcon";
import h from "@/styles/home.module.css";

const KIND: Record<BackgroundItem["kind"], string> = { plan: "规划", verify: "验收", merge: "合回", subagent: "子 agent", command: "命令" };
const PHASE: Record<LocalPhase, string> = { checking: "检查中", prompt: "等浏览器允许", blocked: "被拦截", offline: "离线", unpaired: "未配对", ready: "就绪" };
const TOOL: Record<TLocalToolStatus["kind"], string> = { "claude-code": "Claude Code", codex: "Codex", gh: "gh", "lark-cli": "飞书命令行" };
export const TOOL_STATE: Record<TLocalToolStatus["state"], string> = { ready: "已登录", not_installed: "没装", not_logged_in: "没登录", expired: "登录过期", unknown: "检查中" };
type Check = { name: string; value: string; bad: boolean };

/**
 * 这台电脑现在是什么状态、要不要本人动手（本人行的点、首页「等你」里「这台电脑没连上」那一行也用这个）。
 * checks 是「这台电脑」点开后的逐项：本机程序，再照本机报的 tools 列执行方和命令行工具；没就绪时工具那几项写「—」。
 * cloudQuota 是各台设备同步给云端的额度：这台电脑没就绪（手机、未配对、离线）或读不到额度时，每台设备一格「Claude · 设备名」；
 * 这台电脑就绪且读得到时只列它自己的。
 * Mac 上离线算中性（这一版没有 Mac 版，本人什么都做不了）：不亮琥珀点、不给「重试」，展开后只写「暂不支持 Mac」。
 */
export function useMachine(cloudQuota: Resources["quota"]) {
  const local = useLocalRunner();
  const ready = local.phase === "ready";
  const paused = ready && !!local.status?.settings.paused;
  const word = paused ? "暂停中" : PHASE[local.phase];
  const alert = paused || local.phase === "prompt" || local.phase === "blocked" || (local.phase === "offline" && !isMac()) || local.phase === "unpaired";
  const tools = local.status?.tools ?? [];
  const checks: Check[] = [
    { name: "本机程序", value: ready ? (paused ? "暂停中" : "已连接") : PHASE[local.phase], bad: alert },
    ...tools.map((tool) => ready
      ? { name: TOOL[tool.kind], value: TOOL_STATE[tool.state], bad: tool.state !== "ready" && tool.state !== "unknown" }
      : { name: TOOL[tool.kind], value: "—", bad: false }),
  ];
  const action = local.phase === "unpaired" ? { label: "配对", run: () => local.pair() }
    : paused ? { label: "继续", run: async () => { await local.runner.patchSettings({ paused: false }); await local.refresh(); } }
    : alert || checks.some((check) => check.bad) ? { label: "重试", run: () => local.refresh({ fresh: true }) }
    : null;
  // 用量（本机 status.quota，读不到用云端的）：剩 ≤25% 琥珀点、≤10% 或用完红点，和本机要处理的点是同一颗（5.4.5、5.6），看列出来的那几格。
  const now = Date.now();
  const here = ready ? usageCells(local.status?.quota ?? [], now) : [];
  // 云端的一项一条（契约 WorkerResources.quota = 本机报的 LocalQuotaSync 加设备）：名字后面加「 · 设备名」。
  const usage = here.length ? here : usageCells(cloudQuota.map((entry) => ({ ...entry, id: `${entry.id}:${entry.deviceId}`, device: entry.deviceName })), now);
  const quotaAlert = usage.some((cell) => cell.tone === "danger") ? "danger" as const : usage.some((cell) => cell.tone === "warning") ? "warning" as const : null;
  // 没连上、没配对（首页「等你」里那一行，第 73 条）：暂停、检查中不算；Mac 上离线不算（同 alert）。
  const disconnected = alert && !paused;
  return { ready, offline: local.phase === "offline", word, alert, disconnected, checks, action, usage, quotaAlert };
}

/** 用量一格：圆环（订阅剩多少）或「¥」、名字、数；明细在 title 里。 */
function UsageItem({ cell }: { cell: UsageCell }) {
  const r = 5.5, round = 2 * Math.PI * r;
  return (
    <li className={h.usageCell} data-tone={cell.tone} data-stale={cell.stale ? "" : undefined} title={`${cell.name}\n${cell.tip}`} data-testid="quota-row">
      {cell.percent === null && cell.value ? <span className={h.usageMoney} aria-hidden>¥</span> : (
        // 一个数都没有（只是读不到）时只画底圈，占住位置
        <svg className={h.usageRing} viewBox="0 0 14 14" aria-hidden>
          <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2" />
          {cell.percent !== null ? <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${(round * cell.percent / 100).toFixed(2)} ${round.toFixed(2)}`} /> : null}
        </svg>
      )}
      <span className={h.usageName}>{cell.name}</span>
      {cell.value ? <span className={`${h.usageValue} ${h.num}`}>{cell.value}</span> : null}
      {cell.unreadable ? <span className={h.usageNote}>暂时读不到</span> : null}
    </li>
  );
}

export function BackgroundPanel({ items, resources, onStop, handheld = false }: {
  items: BackgroundItem[];
  resources: Resources;
  onStop: (item: BackgroundItem) => Promise<void>;
  handheld?: boolean;
}) {
  return (
    <div className={h.bg} data-testid="background-panel">
      <MachineBlock resources={resources} handheld={handheld} />
      <div className={h.bgBody}><BackgroundTasks items={items} onStop={onStop} handheld={handheld} /></div>
    </div>
  );
}

/** 资源块（这台电脑、在跑的子会话、剩余用量）：手机抽屉里的 BackgroundPanel 和电脑上右边的会话面板（设计 4.3）都用。 */
export function MachineBlock({ resources, handheld = false }: { resources: Resources; handheld?: boolean }) {
  const machine = useMachine(resources.quota);
  const [acting, setActing] = useState(false);
  // 逐项检查：有一项不对时默认展开；本人点过就照本人的来。
  const [checksOpen, setChecksOpen] = useState<boolean | null>(null);
  const bad = machine.checks.some((check) => check.bad);
  const showChecks = checksOpen ?? bad;
  return (
    <div className={h.bgHead} data-testid="resources">
      <div className={h.resLine}>
        <button type="button" className={h.pcRow} aria-expanded={showChecks} onClick={() => setChecksOpen(!showChecks)} data-testid="machine-row">
          {bad ? <i className={h.warnDot} aria-hidden /> : null}
          <span className={h.resName}>这台电脑</span><span className={h.resWord}> · {machine.word}</span>
          <ChevronDown size={14} strokeWidth={1.8} aria-hidden className={h.pcChevron} data-open={showChecks ? "" : undefined} />
        </button>
      </div>
      {showChecks ? (
        <>
          <ul className={h.checks} data-testid="machine-checks">
            {machine.checks.map((check) => <li key={check.name} data-bad={check.bad ? "" : undefined}><span>{check.name}</span><span className={h.checkValue}>{check.value}</span></li>)}
          </ul>
          {machine.offline && !handheld ? <LocalInstall /> : null}
          {machine.action ? (
            <div className={h.checkFix}>
              <HeroButton variant="tertiary" size="sm" isDisabled={acting} onPress={() => { setActing(true); void machine.action!.run().finally(() => setActing(false)); }}>{machine.action.label}</HeroButton>
            </div>
          ) : null}
        </>
      ) : null}
      {machine.ready ? (
        <div className={h.runLine} title={`同时最多跑 ${resources.local.cap} 张卡`}>
          在跑的子会话<span className={h.grow} />
          {resources.local.cap <= MANY_SESSIONS ? <Slots used={resources.local.used} cap={resources.local.cap} /> : null}
          <span className={`${h.runCount} ${h.num}`}>{resources.local.used}/{resources.local.cap}</span>
        </div>
      ) : null}
      {machine.usage.length ? (
        <>
          <p className={h.usageHead}>剩余用量</p>
          <ul className={h.usage}>{machine.usage.map((cell) => <UsageItem key={cell.id} cell={cell} />)}</ul>
        </>
      ) : null}
    </div>
  );
}

/** 后台任务两组（「进行中」「已完成」）：右栏默认内容里有，右栏的会话详情下面也用（这个会话的）。 */
export function BackgroundTasks({ items, onStop, handheld = false }: { items: BackgroundItem[]; onStop: (item: BackgroundItem) => Promise<void>; handheld?: boolean }) {
  const groups = groupBackground(items);
  const now = useNow(groups.running.some((item) => item.state === "running"));
  const [stopping, setStopping] = useState<string | null>(null);
  const failed = groups.finished.filter((item) => item.state === "failed").length;
  // 有失败时默认展开「已完成」；本人点过（收起或展开）就照本人的来（5.4.5）。
  const [open, setOpen] = useState<boolean | null>(null);
  const finishedOpen = open ?? failed > 0;
  /** 没停下：那一行停止按钮的位置写「失败 · 重试」（原因在 title 里），不弹 toast。 */
  const [stopFailed, setStopFailed] = useState<{ id: string; reason: string } | null>(null);
  const stop = async (item: BackgroundItem) => {
    setStopping(item.id);
    setStopFailed(null);
    try { await onStop(item); }
    catch (error) { setStopFailed({ id: item.id, reason: error instanceof Error ? error.message : "" }); }
    finally { setStopping(null); }
  };
  const row = (item: BackgroundItem) => (
    <li key={item.id} className={h.bgRow} data-state={item.state} data-handheld={handheld ? "" : undefined} data-testid="bg-row">
      {item.state === "failed" ? <span className={h.bgFail}><X {...ICON} aria-label="失败" /></span> : null}
      <span className={h.bgKind}>{KIND[item.kind]}</span>
      {/* 规划、验收：名字下面一行淡色小字写「来源 · 模型 · 思考」（56 条），本机报的才有。 */}
      {item.model ? <span className={h.bgMain}><span className={h.bgTitle} title={item.title}>{item.title}</span><span className={h.bgModel} title={item.model} data-testid="bg-model">{item.model}</span></span>
        : <span className={h.bgTitle} title={item.title}>{item.title}</span>}
      {/* 停着等额度恢复：放不下就省略，不挤掉停止按钮。 */}
      {item.state === "queued" && item.holdUntil ? <span className={`${h.bgTime} ${h.bgHold}`}>{queueText("quota", item.holdUntil)}</span>
        : <span className={h.bgTime}>{item.state === "failed" ? "失败" : item.state === "stopped" ? "已停止" : item.state === "queued" ? "已排队" : duration(item.startedAt, item.finishedAt ?? now)}</span>}
      {stopFailed?.id === item.id && stopping !== item.id ? <FailedLine inline reason={stopFailed.reason} onRetry={() => void stop(item)} />
      : item.stoppable && (item.state === "running" || item.state === "queued") ? (
        <span className={h.bgStop}>
          <HeroButton variant="ghost" size="sm" isIconOnly title="停止" aria-label={`停止 ${item.title}`} isDisabled={stopping === item.id} onPress={() => void stop(item)}><Square {...ICON} /></HeroButton>
        </span>
      ) : null}
    </li>
  );
  return (
    <>
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
    </>
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
