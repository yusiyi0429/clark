"use client";

/**
 * 成员的「战场进展」（/me/progress，样稿 progress-rethink-v1 方案 1「卡点优先」）：先看谁需要搭把手，再看大家在推进什么。
 * - 最上面：我所在战场的 Agent 汇总（BattlefieldSummaries，与全局进展共用）。
 * - 页头：我所在的组（战场；本月没有战场时是业务域）多于一个时一排切换；下面这组本月的目标（有才写）和一行盘点数字。
 * - 需要搭把手：卡住、按截止做不完、过了截止、没有核实进展，一张卡一件事；按钮「约会议」（参会人先填好这个人）、
 *   「发请求」（新请求里先写好找谁、关于哪件事）、「看看」（我是推进人或协作者时才有）。是我自己的事只给「看看」。
 * - 大家在推进什么：每人一张卡，我排第一；每个 Mission 一行写已完成 a/b 或状态，最下一行最近一条进展。
 * 取数、分组、可见范围都在服务端（GET /api/me/battlefield-progress）；这里只画。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TBattlefieldHelpItem, TBattlefieldPersonCard, TBattlefieldProgressGroup, TBattlefieldProgressResponse } from "@warmap/contracts";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { SegmentedSwitch } from "@/components/SegmentedSwitch";
import { browserApi, type Card } from "@/lib/api/client";
import { BattlefieldSummaries } from "./BattlefieldSummaries";
import { relativeDayTime } from "@/lib/companyTime";
import p from "./progress.module.css";
import s from "./battlefield-progress.module.css";

const NO_CARDS: Card[] = [];
const FLAG_TEXT = { blocked: "卡住", deadline: "按截止做不完", slow: "慢了" } as const;
const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

export function BattlefieldProgressScreen() {
  const workspace = useWorkspace();
  const [data, setData] = useState<TBattlefieldProgressResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  useRegisterDetail(useMemo(() => ({ scope: "global", label: "战场进展", mark: null, cards: NO_CARDS }), []));

  const load = useCallback(async () => {
    try {
      const { data: next, response } = await browserApi.GET("/api/me/battlefield-progress");
      if (response.status === 401) { window.location.assign("/access?next=%2Fme%2Fprogress"); return; }
      setFailed(!next);
      if (next) setData(next);
    } catch { setFailed(true); }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [load]);

  const group = data?.groups.find((item) => item.id === picked) ?? data?.groups[0] ?? null;
  return (
    <div className={p.screen}>
      <DetailFrame title="战场进展" subtitle={group && data && data.groups.length === 1 ? group.name : ""} onBack={() => workspace.close()}>
        <div className={`${p.content} ${s.content}`}>
          <div className={s.stack}>
            <BattlefieldSummaries />
            {failed && !data ? <p className={p.error} role="alert">没有读到战场进展</p> : null}
            {!data ? (failed ? null : <p className={p.loading} role="status">正在读取</p>)
              : !group ? <p className={p.empty}>这个月还没有你的 Mission</p>
              : <>
                {data.groups.length > 1 ? (
                  <SegmentedSwitch label="战场" selected={group.id} onSelect={setPicked}
                    segments={data.groups.map((item) => ({ id: item.id, label: `${item.name} · ${item.people.length} 人` }))} />
                ) : null}
                <GroupView group={group} onNavigate={workspace.navigate} onBook={workspace.bookMeetingWith} />
              </>}
          </div>
        </div>
      </DetailFrame>
    </div>
  );
}

export function GroupView({ group, onNavigate, onBook }: { group: TBattlefieldProgressGroup; onNavigate: (href: string, origin?: Element | null) => void; onBook?: (participants: string[]) => void }) {
  const me = group.people.find((card) => card.me)?.person.personId;
  return <>
    <header className={s.summary} data-group={group.id}>
      {group.goal ? <p className={s.goal}>{group.goal}</p> : null}
      <p className={s.counts}>
        <span><b>{group.counts.missions}</b> 个 Mission</span>
        <span><b>{group.counts.onTrack}</b> 在轨道上</span>
        <span><b>{group.counts.slow}</b> 慢了</span>
        <span><b>{group.counts.blocked}</b> 卡住</span>
      </p>
    </header>
    {group.help.length ? (
      <section className={p.section} aria-label="需要搭把手">
        <h2 className={p.sectionHead}>需要搭把手<span className={p.count}>{group.help.length}</span></h2>
        <ul className={s.grid}>
          {group.help.map((item, index) => <HelpCard key={`${item.kind}:${item.task?.taskId ?? item.mission.missionId}:${index}`} item={item} mine={item.person.personId === me} onNavigate={onNavigate} onBook={onBook} />)}
        </ul>
      </section>
    ) : null}
    <section className={p.section} aria-label="大家在推进什么">
      <h2 className={p.sectionHead}>大家在推进什么</h2>
      <ul className={s.grid}>
        {group.people.map((card) => <PersonCard key={card.person.personId} card={card} />)}
      </ul>
    </section>
  </>;
}

/** 一句话说清卡在哪 / 慢在哪；状态小标另写。 */
function helpText(item: TBattlefieldHelpItem): { line: string; flag: string } {
  const waiting = item.waitingOnMe ? " · 等你" : item.waitingOn ? ` · 在等 ${item.waitingOn.name}` : "";
  switch (item.kind) {
    case "blocked": return { line: item.reason ?? "", flag: `${item.days ? `卡住 ${item.days} 天` : "今天卡住"}${waiting}` };
    case "deadline": return { line: `还需 ${item.neededDays ?? 0} 个工作日，剩 ${item.leftDays ?? 0} 个`, flag: "按截止做不完" };
    case "overdue": return { line: `截止 ${item.dueDate ? shortDay(item.dueDate) : ""}，已过 ${item.days ?? 0} 个工作日`, flag: "慢了" };
    case "no_progress": return { line: "开始 3 个工作日了，还没有核实过的进展", flag: "慢了" };
  }
}

function HelpCard({ item, mine, onNavigate, onBook }: { item: TBattlefieldHelpItem; mine: boolean; onNavigate: (href: string, origin?: Element | null) => void; onBook?: (participants: string[]) => void }) {
  const { line, flag } = helpText(item);
  const title = item.task?.title ?? item.mission.title;
  const prompt = `关于「${title}」，找${item.person.name}：`;
  return (
    <li className={s.card} data-help={item.kind}>
      <span className={s.who}><Avatar name={item.person.name} />{mine ? "我" : item.person.name}<span className={s.sep}>·</span><span className={s.mission}>{item.mission.title}</span></span>
      <b className={s.title}>{title}</b>
      {line ? <p className={s.line}>{line}</p> : null}
      <span className={s.flag} data-kind={item.kind === "blocked" ? "blocked" : "slow"}>{flag}</span>
      <span className={s.actions}>
        {!mine && onBook ? <button type="button" className={s.action} onClick={() => onBook([item.person.personId])}>约会议</button> : null}
        {!mine ? <button type="button" className={s.action} onClick={(event) => onNavigate(`/me/requests/new?prompt=${encodeURIComponent(prompt)}`, event.currentTarget)}>发请求</button> : null}
        {item.canOpen && item.task ? <button type="button" className={s.action} onClick={(event) => onNavigate(`/me/tasks/${encodeURIComponent(item.task!.taskId)}`, event.currentTarget)}>看看</button> : null}
      </span>
    </li>
  );
}

function PersonCard({ card }: { card: TBattlefieldPersonCard }) {
  return (
    <li className={s.card} data-person={card.person.personId} data-me={card.me || undefined}>
      <span className={s.head}><Avatar name={card.person.name} /><b>{card.me ? "我" : card.person.name}</b><small>本周动了 {card.movedThisWeek} 件</small></span>
      {card.missions.length ? (
        <ul className={s.missions}>
          {card.missions.map((mission) => (
            <li key={mission.missionId}>
              <span>{mission.title}</span>
              {mission.flag ? <span className={s.flag} data-kind={mission.flag === "blocked" ? "blocked" : "slow"}>{FLAG_TEXT[mission.flag]}</span>
                : <small>{mission.done}/{mission.total}</small>}
            </li>
          ))}
        </ul>
      ) : null}
      {card.latest ? <p className={s.latest}>最近：{card.latest.text} · {relativeDayTime(card.latest.at)}</p> : null}
    </li>
  );
}

const Avatar = ({ name }: { name: string }) => <span className={s.avatar} aria-hidden="true">{Array.from(name)[0]}</span>;
