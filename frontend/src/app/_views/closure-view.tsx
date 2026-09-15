"use client";

import { Check, MessageSquareQuote } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ActionButton } from "@/components/action-button";
import { AsyncBoundary } from "@/components/async-boundary";
import { CodeText } from "@/components/provenance/code-ref";
import { useRating } from "@/components/rating/rating-provider";
import { StateBadge } from "@/components/state-badge";
import { Textarea } from "@/components/ui/textarea";
import { Panel } from "@/components/panel";
import {
  ApiError,
  ROUTE_LABEL,
  api,
  evidenceActionLabel,
  evidenceActionsFor,
} from "@/lib/data/client";
import type {
  Closure,
  ClosureDraft,
  ClosureField,
  DecisionRoute,
  Issue,
  IssueState,
  WriteBackResult,
} from "@/lib/data/types";
import { useInvalidate, useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 页面5 会后确认的一份。
 *
 * 会已经开完了。这一页干两件事，顺序不能换：先把会上定的那七句话核对准，再选这件事
 * 往哪条路走。**分流不是走完流程的最后一格，它是这一页的实质** —— 同样一句「我们做」，
 * 走 A 是公司的正式判断翻了一版，走 C 只是派人去取一个证据，两者半年后的样子完全不同。
 *
 * 七要素整份核对，不是七次确认。治理要的是一号位确认过这个决定，不是他点了七下 ——
 * 逐条确认会把「正确」直接换成「麻烦」，而麻烦就是第二周没人再用的原因。
 *
 * 字段，不是富文本框（H1）。Closure 要写回假设、Evidence Action 和重开条件；它一旦
 * 变成一段自由散文，就不再可解析，Decision 也就悄悄退化成了会议纪要。
 *
 * 没有「再研究研究」。M1-A 明文反对 —— 那是决策疲劳的藏身处：一件事被推三次，第四次
 * 上会时所有人都已经忘了当初为什么要讨论它。
 */

const ELEMENTS: { key: ClosureField; label: string; gloss: string }[] = [
  { key: "choose", label: "Choose", gloss: "定了做什么" },
  { key: "notChoose", label: "Not Choose", gloss: "明确不做什么" },
  { key: "why", label: "Why", gloss: "为什么" },
  { key: "keyHypothesis", label: "Key Hypothesis", gloss: "赌的是哪一条" },
  { key: "riskAccepted", label: "Risk Accepted", gloss: "认了哪个风险" },
  { key: "commitment", label: "Commitment", gloss: "谁、什么时候、交什么" },
  { key: "reopenTrigger", label: "Re-open Trigger", gloss: "什么条件下重开" },
];

/**
 * 四条路，以及各自的后果。
 *
 * `ROUTE_LABEL` 是它们在回执和时间线上的正式名字（数据层导出，前端不另起一套）；
 * 这里补的是**选下去会发生什么**。四条路里只有 A 会动到公司的正式判断，这件事必须
 * 在他点之前就写在屏幕上，而不是写在回执里等他事后发现。
 */
const ROUTES: { route: DecisionRoute; consequence: string; becomes: IssueState }[] = [
  {
    route: "strategy",
    consequence: "公司的正式判断翻一版，新陈述与修订说明进版本历史，重开条件同时布控。",
    becomes: "Monitoring",
  },
  {
    route: "mission",
    consequence: "判断不动。这件事变成一条独立执行项交给 DRI，重开条件布控在它咬住的判断上。",
    becomes: "Monitoring",
  },
  {
    route: "evidence",
    consequence: "判断不动，先去取证据。结果返回后这个议题自动重开，重新排到您面前。",
    becomes: "WaitingEvidence",
  },
  {
    route: "close",
    consequence: "这件事就此关闭，但重开条件留着布控 —— 条件命中，它自己会回到潜在议题。",
    becomes: "Closed",
  },
];

type Loaded = { draft: ClosureDraft; issue: Issue };

export function ClosureView({ id }: { id: string }) {
  const key = `closure:${id}`;
  const resource = useResource<Loaded>(key, async () => {
    const [draft, issue] = await Promise.all([
      api.getClosureDraft(id),
      api.getIssue(id),
    ]);
    return { draft, issue };
  });
  const invalidate = useInvalidate();

  return (
    <Panel>
      <AsyncBoundary resource={resource} skeleton={<ClosureSkeleton />}>
        {({ draft, issue }) => (
          <ClosureForm
            issueId={id}
            issue={issue}
            draft={draft}
            onWritten={(result) => {
              /*
               * 写回真的移动了判断，所以别的屏幕上的数字全部不再成立：待定事项的监测
               * 靶点、那条判断的版本历史、议题列表的分组。清掉缓存，下次打开重新问。
               *
               * 这个 key 自己不清、而是把服务端返回的回执装回草案里 —— 清掉它会让
               * 一号位刚刚拿到的那张回执在眼前变成骨架屏。装回去不是乐观更新：
               * `ClosureDraft.writeBack` 的类型就是 `WriteBackResult | null`，
               * 装进去的正是服务端刚刚答的那个对象。
               */
              void resource.mutate(
                (current) =>
                  current
                    ? {
                        issue: { ...current.issue, state: result.newState },
                        draft: { ...current.draft, writeBack: result },
                      }
                    : current,
                { revalidate: false }
              );
              invalidate(key);
            }}
          />
        )}
      </AsyncBoundary>
    </Panel>
  );
}

function ClosureForm({
  issueId,
  issue,
  draft,
  onWritten,
}: {
  issueId: string;
  issue: Issue;
  draft: ClosureDraft;
  onWritten: (result: WriteBackResult) => void;
}) {
  const { requestRating } = useRating();
  const [fields, setFields] = useState<Closure>(draft.fields);
  const [editing, setEditing] = useState<ClosureField | null>(null);
  const [route, setRoute] = useState<DecisionRoute | null>(null);
  const [written, setWritten] = useState<WriteBackResult | null>(draft.writeBack);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const confirm = async (chosen: DecisionRoute) => {
    setPending(true);
    setFailure(null);
    try {
      const result = await api.confirmClosure(issueId, fields, chosen);
      setWritten(result);
      onWritten(result);
      requestRating(`closure:${issueId}`);
    } catch (e) {
      /*
       * 就地显示，不弹窗、不跳走。这里最常见的一种失败是「这份 Closure 已经固化过
       * 了」—— 两个标签页都开着、或者他退回来又点了一次。那句话本身就是答案，他要
       * 的不是重试按钮，是知道刚才那一下没有把同一件事固化两遍。
       *
       * 走完 `api.` 那一层的失败全是 ApiError（client.ts 把每种都翻译成了一句中文），
       * 所以 else 那一档只剩「这个 catch 块自己的代码崩了」。那时候原因确实不在手上：
       * 只说没成，不猜原因 —— 原来这里写死了一句「可能是网络中断了」，而 500 崩掉的
       * 那一次网络好得很。
       */
      setFailure(e instanceof ApiError ? e.message : "这一次写回没有成功。");
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      {/*
       * 这一行说的是「这份草案是哪来的」。
       *
       * 没上会的那一档不许写「会后 0 分钟」：那个 0 会被读成「刚散会、赶紧确认」，
       * 而这件事根本没上会 —— 它走的是读完研究就定那一条（见 `/decisions` 那一页
       * 开头的说明）。会后几分钟只有真有一场散了的会才算得出来。
       */}
      <p className="meta text-ink-faint">
        {draft.sourceMeetingId ? `会后确认 · ${draft.sourceMeetingId}` : "没上会就定"}
        {draft.minutesSinceMeeting !== null ? ` · 会后 ${draft.minutesSinceMeeting} 分钟` : ""}
        {` · ${issueId}`}
      </p>

      {/* 页面标题一律 `text-lg`（17px），见 `PanelHead`。 */}
      <h1 className="report mt-2 text-lg leading-relaxed text-ink">{issue.title}</h1>

      <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
        <StateBadge state={issue.state} />
        {written ? (
          <span className="meta text-ink-faint">
            Decision {written.decisionId} · 已确认
          </span>
        ) : null}
      </div>

      {written ? <Receipt written={written} /> : null}

      <div className="mt-7 space-y-6">
        {ELEMENTS.map(({ key, label, gloss }) => (
          <section key={key}>
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="meta text-ink-faint">
                {label} · {gloss}
              </h2>
              {!written && (
                <div className="flex shrink-0 items-baseline gap-3">
                  {/*
                   * 就这一条再聊 —— 回议题研究，把这句话原样带过去。
                   *
                   * 只在还没固化的时候出现，而且只在这一页出现。已经固化的决定不该靠
                   * 「再聊一次」推翻：它有重开条件，条件命中它自己会回来。这条按钮存在
                   * 的位置，正好是「还没写回本体、所以还能改主意」的那一格。
                   *
                   * 带过去的是预填，不是自动发送。议题研究那一栏里替他按下回车，等于替他
                   * 问了一句他没说过的话。
                   */}
                  <Link
                    href={`/issues/${issueId}?quote=${encodeURIComponent(
                      `${label}（${gloss}）：「${fields[key]}」\n就这一条，我还想问：`
                    )}`}
                    className="meta inline-flex items-center gap-1 rounded-[3px] px-1 text-ink-faint underline-offset-4 transition-colors duration-fast hover:text-judgment hover:underline"
                  >
                    <MessageSquareQuote className="size-3" />
                    就这一条再聊
                  </Link>
                  {editing !== key && (
                    <button
                      type="button"
                      onClick={() => setEditing(key)}
                      className="meta rounded-[3px] px-1 text-ink-faint underline-offset-4 transition-colors duration-fast hover:text-ink hover:underline"
                    >
                      改
                    </button>
                  )}
                </div>
              )}
            </div>

            {editing === key ? (
              <Textarea
                autoFocus
                value={fields[key]}
                onChange={(e) =>
                  setFields((f) => ({ ...f, [key]: e.target.value }))
                }
                onBlur={() => setEditing(null)}
                rows={3}
                className="report mt-1.5 border-judgment text-md"
              />
            ) : (
              <p className="report mt-1.5 whitespace-pre-line text-md text-ink">
                <CodeText text={fields[key]} />
              </p>
            )}
          </section>
        ))}
      </div>

      {!written && (
        <>
          <Routing
            chosen={route}
            onChoose={setRoute}
            draft={draft}
            issue={issue}
            reopenTrigger={fields.reopenTrigger}
          />

          {failure && (
            <p className="mt-5 rounded-lg border border-counter/25 bg-counter-wash px-4 py-3 text-sm leading-relaxed text-ink">
              {failure}
            </p>
          )}

          <div className="mt-7">
            <ActionButton
              className="h-10 px-4 text-md"
              pending={pending}
              pendingLabel="正在写回…"
              disabled={route === null}
              onAction={() => route && void confirm(route)}
            >
              ✓ 确认并写回
            </ActionButton>
          </div>
        </>
      )}
    </>
  );
}

/**
 * 四选一分流。
 *
 * 四个块并列，同样的大小，没有一个预选中的「推荐」—— 这里做推荐等于替一号位拍板，
 * 而这一格恰恰是整个产品里唯一只有他能做的动作。
 *
 * 选中之后立刻在下面写出「确认后会发生什么」，用的是这份草案里的真对象：哪条判断翻到
 * 第几版、布控几条重开条件、议题变成什么状态。他按下按钮之前就该看见这些，而不是在
 * 回执里第一次读到。
 */
function Routing({
  chosen,
  onChoose,
  draft,
  issue,
  reopenTrigger,
}: {
  chosen: DecisionRoute | null;
  onChoose: (route: DecisionRoute) => void;
  draft: ClosureDraft;
  issue: Issue;
  reopenTrigger: string;
}) {
  return (
    <section className="mt-9 border-t border-hairline pt-5">
      <h2 className="text-lg text-ink">这件事往哪走 · 四选一</h2>

      <div className="mt-3.5 space-y-1.5">
        {ROUTES.map(({ route, consequence }) => {
          const on = chosen === route;
          return (
            <button
              key={route}
              type="button"
              aria-pressed={on}
              onClick={() => onChoose(route)}
              className={cn(
                "block w-full rounded-lg border px-4 py-3 text-left transition-colors duration-fast ease-swift",
                on
                  ? "border-judgment bg-judgment-wash"
                  : "border-hairline hover:bg-neutral-wash"
              )}
            >
              <p
                className={cn(
                  "text-md",
                  on ? "font-medium text-judgment" : "text-ink"
                )}
              >
                {ROUTE_LABEL[route]}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-ink-muted">
                {consequence}
              </p>
            </button>
          );
        })}
      </div>

      {chosen && (
        <Preview
          route={chosen}
          draft={draft}
          issue={issue}
          reopenTrigger={reopenTrigger}
        />
      )}
    </section>
  );
}

/** 确认之前的那一眼：这一下会动到哪几个对象。 */
function Preview({
  route,
  draft,
  issue,
  reopenTrigger,
}: {
  route: DecisionRoute;
  draft: ClosureDraft;
  issue: Issue;
  reopenTrigger: string;
}) {
  const becomes = ROUTES.find((r) => r.route === route)!.becomes;
  const lines: string[] = [];

  if (route === "strategy") {
    for (const r of draft.revises) {
      lines.push(`${r.judgmentId}「${r.nextStatement}」翻到下一版 · ${r.note}`);
      for (const arm of r.arms) lines.push(`${r.judgmentId} 布控重开条件「${arm}」`);
    }
    if (draft.revises.length === 0) {
      lines.push("这份草案没有指定要翻版的判断。");
    }
  } else if (issue.judgmentRefs[0] && reopenTrigger.trim()) {
    lines.push(
      `${issue.judgmentRefs[0]} 布控重开条件「${reopenTrigger.trim()}」· 判断本身不动`
    );
  }

  /*
   * 派几条 Evidence Action 由 `evidenceActionsFor` 说 —— 写回那一下用的是同一个函数。
   * 这里曾经只预告 C 那一条，于是走 A 的时候回执上凭空多出一条 Evidence Action：
   * 预告漏说的东西，看起来就是它自己偷偷加的。
   */
  const evidence = evidenceActionsFor(route);
  if (evidence > 0) {
    // 标签本身就以「Evidence Action」开头，所以不再前缀一遍；条数只有多于一条才写。
    lines.push(evidence > 1 ? `${evidenceActionLabel} ×${evidence}` : evidenceActionLabel);
  }
  lines.push(`${issue.id} → ${becomes}`);

  return (
    <div className="animate-fade mt-4 border-l-2 border-judgment pl-3.5">
      <p className="meta text-judgment">确认后会发生</p>
      <ul className="mt-1.5 space-y-1">
        {lines.map((line, i) => (
          <li key={i} className="text-sm leading-relaxed text-ink-muted">
            <CodeText text={line} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 写回回执。
 *
 * 这块是整件事的收口：拍了板，本体真的动了，而且每一处都点得开。写回如果只是一行
 * 「已完成」，那前面七个要素就只是一份格式漂亮的会议纪要。
 *
 * 尾部那条链接回潜在议题 —— 布控下去的重开条件从这一刻起就是那一页上的监测靶点。这个
 * 回环不是文档里的一句话，是他点一下就能看见的东西。
 */
function Receipt({ written }: { written: WriteBackResult }) {
  return (
    <>
      {/* 左沿那道 4px 是语义（已确认），留着；外面那圈中性 1px 是装饰，去掉 ——
          这块面的身份由它自己的色底说，不由一圈灰边说。 */}
      <section className="mt-4 rounded-xl border-l-4 border-l-confirmed bg-confirmed-wash px-4 py-3.5">
        <p className="inline-flex items-center gap-1.5 text-md font-medium text-confirmed">
          <Check className="size-4" />
          已确认并写回 · {ROUTE_LABEL[written.route]}
        </p>

        <ul className="mt-2.5 space-y-1">
          {written.updatedObjects.map((target, i) => (
            <li key={i} className="meta text-ink-muted">
              {target.href ? (
                <Link
                  href={target.href}
                  className="rounded-[3px] underline decoration-hairline underline-offset-[3px] transition-colors duration-fast hover:text-ink hover:decoration-ink-faint"
                >
                  {target.label}
                </Link>
              ) : (
                target.label
              )}
            </li>
          ))}
        </ul>

        <p className="meta mt-2.5 border-t border-hairline pt-2.5 text-ink-muted">
          重开条件 ×{written.triggersArmed} · Evidence Action ×
          {written.evidenceActions} · 议题 → {written.newState}
        </p>

        {/*
          这两个数字只在这里出现一次，不做成每张卡上的徽章。说第二遍就变成了自夸。

          同类里一件都还没定过的时候（`pastMedianLabel` 为 null），后半句整句不出现 ——
          没有可比的东西，就别在屏幕上摆一个「中位」的位置再往里填一句解释。
        */}
        <p className="meta mt-1.5 text-ink-faint">
          从提出到定下来 {written.elapsedLabel}
          {written.pastMedianLabel ? ` · 这类问题过去中位 ${written.pastMedianLabel}` : ""}
        </p>
      </section>

      <div className="mt-4">
        <Link
          href="/signals"
          className="inline-flex h-10 items-center rounded-lg bg-solid px-4 text-md font-medium text-solid-fg transition-opacity duration-fast ease-swift hover:opacity-90"
        >
          回潜在议题 →
        </Link>
      </div>

      {written.impactHints.length > 0 && (
        <section className="mt-6">
          <h2 className="meta text-ink-faint">影响建议</h2>
          {/* 影响建议是一份清单，不是几张卡。行与行之间一条内缩发丝线就够，
              每条各自围一圈边只会读成三个框。 */}
          <ul className="card mt-2 overflow-hidden">
            {written.impactHints.map((hint) => (
              <li key={hint.targetLabel} className="row concentric px-3.5 py-2.5">
                <p className="meta text-ink-muted">{hint.targetLabel}</p>
                <p className="mt-1 text-base text-ink">
                  <CodeText text={hint.text} />
                </p>
                <p className="meta mt-1.5 text-ink-faint">
                  建议告知 {hint.suggestTo}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function ClosureSkeleton() {
  return (
    <div aria-live="polite">
      <span className="skeleton block h-2.5 w-56" />
      <span className="skeleton mt-2.5 block h-5 w-[62%]" />
      <div className="mt-7 space-y-6">
        {[0, 1, 2, 3, 4].map((n) => (
          <div key={n}>
            <span className="skeleton block h-2.5 w-24" />
            <span className="skeleton mt-2 block h-4 w-full" />
            <span className="skeleton mt-1.5 block h-4 w-[66%]" />
          </div>
        ))}
      </div>
    </div>
  );
}
