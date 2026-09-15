"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AsyncBoundary } from "@/components/async-boundary";
import { CodeText } from "@/components/provenance/code-ref";
import { StandingTag } from "@/components/standing-tag";
import { StatementLine } from "@/components/statement-line";
import { StateBadge } from "@/components/state-badge";
import { Panel } from "@/components/panel";
import { api } from "@/lib/data/client";
import { formatDay } from "@/lib/format";
import type {
  IssueSummary,
  JudgmentDetail,
  MissionCard,
} from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";

/**
 * FE-3 · 一条判断 (`/judgments/04-J1`).
 *
 * 这一页是「把公司的判断变成持久对象」这句话的落点。首屏证明判断存在，这里证明它
 * 是一个**对象**：它有版本、有依据、有布控、有历史，点得开、发得出去、半年后还查
 * 得到。一号位口头引用的那个编号 `04-J1` 就是这个地址。
 *
 * 页面顺序按一个人真的会问的顺序排：现在赌的是什么 → 什么在晃它 → 我要定什么 →
 * 它怎么走到这一版 → 什么条件会把它重新打开 → 谁依据它做过决定。Mission 折在最
 * 后，因为它只读 —— 改 Mission 是 03 Method 的边界，不是这块屏幕的权限。
 */
export function JudgmentView({ id }: { id: string }) {
  const resource = useResource<JudgmentDetail>(`judgment:${id}`, () =>
    api.getJudgment(id)
  );

  return (
    <Panel>
      <AsyncBoundary resource={resource} skeleton={<JudgmentSkeleton />}>
        {(detail) => <JudgmentScreen detail={detail} />}
      </AsyncBoundary>
    </Panel>
  );
}

function JudgmentScreen({ detail }: { detail: JudgmentDetail }) {
  const { judgment, domain, dri, driAgent, freshDaysLeft } = detail;

  return (
    <>
      <p className="meta text-ink-faint">
        {/*
          * 不属于任何业务域的那几条**照实写**（见 `Judgment.domainId`）。留空的话这一行
          * 会以「· 战略判断 · 01-J5」开头，看着像掉了个字；拿一个还在的域顶上去更坏 ——
          * 那是把一句话的归属编给了别人。
          */}
        {domain ? `${domain.code} ${domain.name}` : "不属于任何业务域"}
        {" · "}
        {judgment.kind === "strategy" ? "战略判断" : "关键假设"}
        {" · "}
        {judgment.id}
      </p>

      {/*
       * 当前这一版的原话。这一行就是这个对象。
       *
       * 字号跟全站的页面标题同一档（`text-lg`，见 `PanelHead`）—— 它比别页的标题重要，
       * 但「重要」由 `font-medium` 和它在页面最上面的位置说，不由再大一号说。
       */}
      <h1 className="report mt-2.5 text-lg font-medium tracking-[-0.01em] text-ink">
        {judgment.statement}
      </h1>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <StandingTag judgment={judgment} />
        <span className="meta text-ink-faint">
          {judgment.confirmedBy} 于 {formatDay(judgment.confirmedAt)} 确认
        </span>
        {/*
          保鲜期。过了这天还没人复核，它就该被当成过期判断而不是现行判断 ——
          一个公司最危险的状态不是判断错了，是没人记得它是什么时候定的。
        */}
        <span
          className={freshDaysLeft < 0 ? "meta text-counter" : "meta text-ink-faint"}
        >
          {freshDaysLeft < 0
            ? `保鲜期已过 ${-freshDaysLeft} 天 · ${formatDay(judgment.freshUntil)}`
            : `保鲜期至 ${formatDay(judgment.freshUntil)} · 还剩 ${freshDaysLeft} 天`}
        </span>
        {/*
          * 这个域现在有没有人负责。**没有的时候照实写「未指派」** —— 上一版这里永远
          * 有个名字，因为空缺被一个占位的岗位实体顶着（「数据负责人 · 在位人待确认」），
          * 而屏幕上那句和一个真名字长得一模一样。一条判断没有人守着，是要被看见的事。
          */}
        <span className="meta text-ink-faint">
          {dri ? `DRI ${dri.name}${driAgent ? ` · ${driAgent.label}` : ""}` : "DRI 未指派"}
        </span>
      </div>

      <Section title="依据">
        <div className="space-y-2.5">
          {judgment.basis.map((s, i) => (
            <StatementLine key={i} statement={s} />
          ))}
        </div>
      </Section>

      {detail.shakingIssues.length > 0 && (
        <Section title={`正在动摇它的议题 · ${detail.shakingIssues.length}`}>
          <IssueLines issues={detail.shakingIssues} />
        </Section>
      )}

      {/*
        版本历史。每一版都能点回造成它的那个 Decision —— 判断变了却查不到是谁、
        依据什么变的，那它就不是一个对象，只是一段会被改写的文案。
      */}
      <Section title={`版本历史 · ${judgment.revisions.length} 版`}>
        <ol className="space-y-3">
          {[...judgment.revisions]
            .sort((a, b) => b.version - a.version)
            .map((r) => (
              <li key={r.version} className="flex gap-3.5">
                <span className="meta w-6 shrink-0 pt-[0.2rem] text-ink-faint">
                  v{r.version}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-base text-ink">
                    <CodeText text={r.note} />
                  </p>
                  <p className="meta mt-0.5 text-ink-faint">
                    {formatDay(r.at)} · {r.actor}
                    {r.decisionId && (
                      <>
                        {" · "}
                        <CodeText text={r.decisionId} className="text-ink-muted" />
                      </>
                    )}
                  </p>
                </div>
              </li>
            ))}
        </ol>
      </Section>

      {judgment.reopenTriggers.length > 0 && (
        <Section title={`重开条件 · 已布控 ${armed(detail)} 条`}>
          <ul className="space-y-2">
            {judgment.reopenTriggers.map((t) => (
              <li key={t.id} className="flex items-baseline gap-3">
                <span
                  className={
                    t.hitAt
                      ? "mt-[0.42rem] size-1.5 shrink-0 rounded-full bg-counter"
                      : t.armed
                        ? "mt-[0.42rem] size-1.5 shrink-0 rounded-full bg-confirmed"
                        : "mt-[0.42rem] size-1.5 shrink-0 rounded-full bg-ink-faint/30"
                  }
                />
                <span className="min-w-0 flex-1 text-base text-ink-muted">
                  <CodeText text={t.text} />
                </span>
                <span
                  className={
                    t.hitAt ? "meta shrink-0 text-counter" : "meta shrink-0 text-ink-faint"
                  }
                >
                  {t.hitAt
                    ? `${formatDay(t.hitAt)} 命中`
                    : t.armed
                      ? "已布控"
                      : "未布控"}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {detail.decidedIssues.length > 0 && (
        <Section title={`曾经依据它做出的决定 · ${detail.decidedIssues.length}`}>
          <IssueLines issues={detail.decidedIssues} />
        </Section>
      )}

      {/* 没有域就没有这个域的 Mission —— 那一栏的清单本来就是空的。 */}
      {domain ? <Missions missions={detail.missions} domainCode={domain.code} /> : null}
    </>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8 border-t border-hairline pt-4">
      <h2 className="meta text-ink-faint">{title}</h2>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

function IssueLines({ issues }: { issues: IssueSummary[] }) {
  return (
    <ul className="space-y-2">
      {issues.map((i) => (
        <li key={i.id}>
          <Link
            href={`/issues/${i.id}`}
            className="group flex items-baseline gap-3 rounded-[3px]"
          >
            <span className="meta w-16 shrink-0 text-ink-faint">{i.id}</span>
            <span className="min-w-0 flex-1 text-base text-ink-muted underline decoration-transparent underline-offset-[3px] transition-colors group-hover:text-ink group-hover:decoration-hairline">
              {i.title}
            </span>
            <StateBadge state={i.state} className="shrink-0" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * 这个域下的 Mission，只读，默认折叠。
 *
 * TKOS 只写一层 —— 判断。往上是 Mission，那是执行侧的边界：在这里放一个编辑按钮，
 * 就是把 Mission 负责人的活抢了，而且抢得一号位并不知情。
 */
function Missions({
  missions,
  domainCode,
}: {
  missions: MissionCard[];
  domainCode: string;
}) {
  const [open, setOpen] = useState(false);
  if (missions.length === 0) return null;

  const STATUS: Record<MissionCard["status"], string> = {
    running: "推进中",
    confirmed: "已确认",
    pending: "待确认",
  };

  return (
    <section className="mt-8 border-t border-hairline pt-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="meta flex items-center gap-1.5 rounded-[3px] text-ink-faint transition-colors hover:text-ink"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        {domainCode} 域的 Mission · {missions.length} 个 · 只读
      </button>

      {open && (
        <ul className="mt-3 space-y-2 border-l border-hairline pl-3.5">
          {missions.map((m) => (
            <li key={m.id} className="flex items-baseline gap-3">
              <span className="meta w-10 shrink-0 text-ink-faint">{m.code}</span>
              <span className="min-w-0 flex-1 text-base text-ink-muted">
                {m.name}
              </span>
              <span className="meta shrink-0 text-ink-faint">
                {STATUS[m.status]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function JudgmentSkeleton() {
  return (
    <div aria-live="polite">
      <span className="skeleton block h-2.5 w-40" />
      <span className="skeleton mt-3 block h-5 w-[88%]" />
      <span className="skeleton mt-2 block h-5 w-[46%]" />
      <div className="mt-4 flex gap-3">
        {[52, 96, 120, 88].map((w, i) => (
          <span key={i} className="skeleton h-2.5" style={{ width: w }} />
        ))}
      </div>
      {[0, 1, 2].map((n) => (
        <div key={n} className="mt-8 border-t border-hairline pt-4">
          <span className="skeleton block h-2.5 w-24" />
          <span className="skeleton mt-3 block h-3.5 w-full" />
          <span className="skeleton mt-1.5 block h-3.5 w-[74%]" />
        </div>
      ))}
    </div>
  );
}

const armed = (detail: JudgmentDetail) =>
  detail.judgment.reopenTriggers.filter((t) => t.armed).length;
