"use client";

import Link from "next/link";

import { formatStamp } from "@/lib/format";
import type { DeploymentDetail as Detail } from "@/lib/data/types";
import { cn } from "@/lib/utils";

/**
 * 已部署那一屏的右半边 —— **点中的那一件交出去之后是什么样。**
 *
 * ## 它回答三句话，不多
 *
 * 一件议题走到这一档，意思是方向定了、任务交出去了，压在 DRI 身上、不再压在一号位
 * 身上。他隔一段时间来一趟，来的时候要就地答出：
 *
 *   ① 当时定的是什么   `monitoringNote` 那一句，原样摆着
 *   ② 交给谁了         承接人 + 他所在的域
 *   ③ 对应哪条 Mission  编号、名称、本期里程碑
 *
 * 只有这三节，而且每节都短。这一屏的存在感要低于在办那两栏（理由写在 `DeployedPane`
 * 上：已部署是**可查的**，不是要处理的），右半边跟着同一条 —— 没有一颗动作键，唯一
 * 的出口是右上角那条「进议题研究」。
 *
 * ## 上面那条带
 *
 * 这一份里大半是示意数据（议题和 Mission 之间的关系本体里还不存在）。**那件事必须写在
 * 最上面，而且逐项点名。** 一屏看起来什么都有、却分不出哪几样是真的，比这一屏空着更坏：
 * 空着他知道要等，看起来齐全他会照着它做决定。
 *
 * 带子用的是 `--judgment`（待确认那一档的琥珀），不是报错的红：这不是故障，是这一块
 * 还没接上。
 */
export function DeploymentDetail({
  detail,
  issueId,
  title,
  domainName,
  monitoringNote,
  className,
}: {
  /** 拿不到就是 null（这一件不在库里）。 */
  detail: Detail | null;
  issueId: string;
  title: string;
  domainName?: string;
  /** 当时定的那一句。没有就没有这一节 —— 补一句「已部署」是把标题再说一遍。 */
  monitoringNote?: string;
  className?: string;
}) {
  return (
    <div className={cn("scroll-slim h-full min-h-0 overflow-y-auto px-6 py-5", className)}>
      <header className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="meta flex items-baseline gap-2 text-ink-faint">
            <span>{issueId}</span>
            {domainName ? <span className="truncate">{domainName}</span> : null}
          </p>
          <h3 className="report mt-1 text-lg leading-relaxed font-medium text-ink">{title}</h3>
        </div>
        <Link
          href={`/issues/${issueId}`}
          className="meta mt-0.5 flex-none rounded-[3px] text-ink-muted underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink"
        >
          进议题研究 →
        </Link>
      </header>

      {detail && detail.mocked.length > 0 ? (
        <div className="mt-4 rounded-lg bg-judgment/10 px-3 py-2.5 [box-shadow:inset_0_0_0_var(--hairline-w)_var(--hairline)]">
          <p className="meta font-medium text-ink">这一栏里有几样还是示意数据</p>
          <ul className="mt-1 space-y-0.5">
            {detail.mocked.map((m) => (
              <li key={m} className="meta text-ink-muted">
                · {m}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {monitoringNote ? (
        <Section title="当时定的是什么">
          <p className="report text-md leading-relaxed text-ink-muted">{monitoringNote}</p>
        </Section>
      ) : null}

      <Section title="交给谁了">
        {detail && detail.owners.length > 0 ? (
          <>
            <ul className="space-y-1.5">
              {detail.owners.map((o) => (
                <li key={o.name} className="flex items-baseline gap-2.5">
                  <span className="text-md font-medium text-ink">{o.name}</span>
                  <span className="meta text-ink-muted">{o.role}</span>
                  {o.domainName ? <span className="meta text-ink-faint">{o.domainName}</span> : null}
                </li>
              ))}
            </ul>
            <p className="meta mt-2 text-ink-faint">
              {formatStamp(detail.handedOverAt)} 交出去
            </p>
            {detail.lastWord ? (
              <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
                最近一次回话 · {detail.lastWord.text}
              </p>
            ) : null}
          </>
        ) : (
          /* 一个都没有就照实说。编一个负责人比没有负责人坏得多（同 A7 那条硬约束）。 */
          <p className="meta text-ink-faint">这一件还没有承接人 —— 它没有归到任何一个域。</p>
        )}
      </Section>

      <Section title="对应的 Mission">
        {detail?.mission ? (
          <div className="rounded-lg bg-neutral-wash px-3.5 py-3 [box-shadow:inset_0_0_0_var(--hairline-w)_var(--hairline)]">
            <p className="meta flex items-baseline gap-2 text-ink-faint">
              <span className="tabular-nums">{detail.mission.code}</span>
              <span>{detail.mission.periodLabel}</span>
              <span className="ml-auto">{MISSION_STATUS[detail.mission.status]}</span>
            </p>
            <p className="report mt-1 text-md leading-relaxed text-ink">{detail.mission.name}</p>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">
              里程碑 · {detail.mission.milestone}
            </p>
          </div>
        ) : (
          <p className="meta text-ink-faint">这一件还没有对上任何一条 Mission。</p>
        )}
      </Section>
    </div>
  );
}

/** 三档状态摊成人话。措辞跟着 `MissionCard.status` 那三个值走，不另起名字。 */
const MISSION_STATUS: Record<"running" | "confirmed" | "pending", string> = {
  running: "在跑",
  confirmed: "已确认",
  pending: "待确认",
};

/**
 * 一节。小标题一律 `.meta`、灰 —— 这一屏的层级靠留白和字色做，不靠字号
 * （同 `DeployedPane` 那条：扫一遍的东西不用挑一件的字号）。
 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h4 className="meta mb-1.5 text-ink-faint">{title}</h4>
      {children}
    </section>
  );
}

/** 一件都没选中时。**不出现在有货的时候** —— 调用方自己默认选第一件。 */
export function DeploymentEmpty({ note }: { note: string }) {
  return (
    <div className="flex h-full items-start justify-center px-6 pt-[22%]">
      <p className="meta text-ink-faint">{note}</p>
    </div>
  );
}
