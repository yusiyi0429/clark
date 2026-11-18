"use client";

/**
 * 二级页共用的几样（设计 5.4.6、5.4.7）：区块（标题 13/20 600 淡色 + 一列行）、一行（名字 + 小字、状态词、一个动作）、连接的四个状态词、
 * 本人是谁（session）、订阅的额度块（和右栏的额度行同一套数：quotaRows）。
 */
import { useEffect, useState, type ReactNode, type Ref } from "react";
import { Check, ChevronDown, LoaderCircle, Plus } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { Switch } from "@/components/ui/Switch";
import { browserApi } from "@/lib/api/client";
import type { UsageCell } from "@/lib/home/quota";
import p from "@/styles/home-pages.module.css";
import { FadeText } from "@/lib/home/overflowFade";

export const ICON = { size: 16, strokeWidth: 1.8 } as const;

export function Section({ title, aside, children, testId }: { title: string; aside?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className={p.section} aria-label={title} data-testid={testId}>
      {aside ? <div className={p.sectionHead}><h2 className={p.sectionTitle}>{title}</h2>{aside}</div> : <h2 className={p.sectionTitle}>{title}</h2>}
      {children}
    </section>
  );
}

/**
 * 连接的状态词（5.6）：已连接 --ink-muted、未连接 --ink-faint、已过期 --warning、用完 --danger；
 * 本人加的工具另有三个（本机查连没连上的结果）：未授权、连不上 --warning，未知 --ink-faint；这套天枢没配公司飞书应用时个人飞书是「未开通」--ink-faint。
 */
export type ConnState = "connected" | "disconnected" | "expired" | "exhausted" | "unauthorized" | "unreachable" | "unknown" | "not_enabled";
export const STATE_WORD: Record<ConnState, string> = {
  connected: "已连接", disconnected: "未连接", expired: "已过期", exhausted: "用完", unauthorized: "未授权", unreachable: "连不上", unknown: "未知", not_enabled: "未开通",
};

/**
 * 一行：名字（14/20）+ 小字（12/16，可以没有）、状态词、一个动作；高 48。children 是跟在行下面的（额度、文件夹、展开的面板）。
 * fold 给了，名字和小字是一个能展开收起的按钮（后面一个 ChevronDown，展开时转过来）；动作在按钮外面，点它不展开收起。
 */
export function Row({ name, tag, sub, state, action, fold, children, testId }: {
  name: ReactNode;
  /** 名字后面的中性 chip（「这台」）。 */
  tag?: ReactNode;
  sub?: ReactNode;
  state?: ConnState | null;
  action?: ReactNode;
  fold?: { open: boolean; onToggle: () => void };
  children?: ReactNode;
  testId?: string;
}) {
  const text = (
    <span className={p.rowText}>
      <span className={p.rowName}><span>{name}</span>{tag ? <span className={p.chip}>{tag}</span> : null}</span>
      {sub ? <span className={p.rowSub}>{sub}</span> : null}
    </span>
  );
  return (
    <li data-testid={testId}>
      <div className={p.row}>
        {fold ? (
          <button type="button" className={`${p.rowButton} ${p.fold}`} aria-expanded={fold.open} onClick={fold.onToggle}>
            {text}<ChevronDown {...ICON} aria-hidden className={p.rowChevron} data-open={fold.open ? "" : undefined} />
          </button>
        ) : text}
        {state ? <span className={p.state} data-state={state}>{STATE_WORD[state]}</span> : null}
        {action ? <span className={p.action}>{action}</span> : null}
      </div>
      {children ? <div className={p.under}>{children}</div> : null}
    </li>
  );
}

/** 开关行（带上个人配置、验收后自动合并、飞书推送）：整行是一个开关按钮（components/ui/Switch），名字在左、开关在右。 */
export function SwitchRow({ name, sub, checked, disabled, onChange, testId }: {
  name: string;
  sub?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  testId?: string;
}) {
  return (
    <li data-testid={testId}>
      <Switch className={`${p.row} ${p.switchRow}`} checked={checked} disabled={disabled} onChange={onChange}>
        <span className={p.rowText}>
          <span className={p.rowName}><span>{name}</span></span>
          {sub ? <span className={p.rowSub}>{sub}</span> : null}
        </span>
      </Switch>
    </li>
  );
}

/** 卡片网格（「连接和技能」，照 Claude 设置的 Customize）：两列，959 及以下一列。 */
export function CardGrid({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return <ul className={p.grid} aria-label={label} data-testid={testId}>{children}</ul>;
}

/**
 * 一张卡：图标、名字、一行内容、来源一行；右上角是 ✓（已加）或一个动作（+、重试、连接）。
 * onOpen 有的整卡可点（技能进详情、工具开编辑）；main 给了就用它当可点的那块（比如飞书点开是菜单）。
 */
export function Card({ icon, name, line, source, corner, onOpen, openRef, main, label, testId, children }: {
  icon: ReactNode;
  name: ReactNode;
  line?: ReactNode;
  source?: ReactNode;
  corner?: ReactNode;
  onOpen?: () => void;
  openRef?: Ref<HTMLButtonElement>;
  main?: (body: ReactNode) => ReactNode;
  label?: string;
  testId?: string;
  /** 卡下面整宽的一块（本机离线时的安装命令）。 */
  children?: ReactNode;
}) {
  const body = (
    <>
      <span className={p.cardIcon} aria-hidden>{icon}</span>
      <span className={p.cardText}>
        <span className={p.cardName}>{name}</span>
        {line ? <FadeText className={p.cardLine}>{line}</FadeText> : null}
        {source ? <span className={p.cardSource}>{source}</span> : null}
      </span>
    </>
  );
  return (
    <li className={p.card} data-testid={testId} data-openable={onOpen || main ? "" : undefined}>
      {main ? main(body) : onOpen ? <button type="button" ref={openRef} className={p.cardMain} aria-label={label} onClick={onOpen}>{body}</button> : <div className={p.cardMain}>{body}</div>}
      {corner ? <span className={p.cardCorner}>{corner}</span> : null}
      {children ? <div className={p.cardExtra}>{children}</div> : null}
    </li>
  );
}

/** 卡右上角的 ✓：已加（连接是已连接）。 */
export function Added({ label = "已添加" }: { label?: string }) {
  return <span className={p.added} role="img" aria-label={label} title={label}><Check {...ICON} /></span>;
}

/** 卡右上角的 +：点了就地添加。 */
export function AddButton({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress: () => void }) {
  return <HeroButton variant="secondary" size="sm" isIconOnly aria-label={label} title="添加" isDisabled={disabled} onPress={onPress}><Plus {...ICON} /></HeroButton>;
}

/** 卡上那一行写状态时：状态词（带颜色）+ 一段内容。 */
export function StateLine({ state, detail }: { state: ConnState | null; detail?: string | null }) {
  return <>{state ? <span className={p.cardState} data-state={state}>{STATE_WORD[state]}</span> : null}{state && detail ? " · " : null}{detail}</>;
}

/** 加载：一颗转圈（--ink-faint），不写字、不画骨架（5.2「交互状态」）。 */
export function Loading() {
  return <div className={p.loading} role="status" aria-label="加载中"><LoaderCircle {...ICON} /></div>;
}

export type Me = { personId: string | null; displayName: string; loginId: string | null; role: "ceo" | "member" };

/** 本人是谁（GET /api/auth/session）：二级页只拿到 go，名字、头像、角色自己读。读不到为 null。 */
export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    let live = true;
    void browserApi.GET("/api/auth/session").then(({ data }) => {
      if (!live || !data?.authenticated) return;
      setMe({ personId: data.personId ?? null, displayName: data.displayName ?? "", loginId: data.loginId ?? null, role: data.role ?? "member" });
    }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  return me;
}

/** 额度块（订阅、TokenHub 那几行下面，11.2「连接页：订阅那几行带同样的明细」）：一行「名字 剩多少」+ 2px 额度条（钱的不画条），下面每个窗口一行明细；和右栏「用量」同一套数（usageCells）。 */
export function QuotaBlock({ cell }: { cell: UsageCell }) {
  return (
    <div className={p.quota} data-tone={cell.tone} data-stale={cell.stale ? "" : undefined} data-testid="quota-block">
      <span className={p.quotaLine}>
        <span className={p.quotaName}>{cell.name}</span>
        {cell.value ? <span className={p.quotaAmount}>{cell.value}</span> : null}
        {cell.unreadable ? <span className={p.quotaTime}>暂时读不到</span> : null}
      </span>
      {cell.percent !== null ? <span className={p.quotaBar} aria-hidden><i style={{ width: `${cell.percent}%` }} /></span> : null}
      {cell.tip ? cell.tip.split("\n").map((line) => <p key={line} className={p.quotaDetail}>{line}</p>) : null}
    </div>
  );
}

/** 相对时间（5.6）：刚刚、3 分钟前、今天 18:20、昨天 18:20、11/05。 */
export function relative(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  const minutes = Math.floor((now - at.getTime()) / 60_000);
  if (Number.isNaN(minutes)) return null;
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  if (at.toDateString() === today.toDateString()) return `今天 ${time}`;
  const yesterday = new Date(now - 86_400_000);
  if (at.toDateString() === yesterday.toDateString()) return `昨天 ${time}`;
  return `${String(at.getMonth() + 1).padStart(2, "0")}/${String(at.getDate()).padStart(2, "0")}`;
}
