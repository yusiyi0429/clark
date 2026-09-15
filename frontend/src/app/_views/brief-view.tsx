"use client";

import { AlertTriangle } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AsyncBoundary } from "@/components/async-boundary";
import { DivergenceBlock } from "@/components/divergence-block";
import { Panel } from "@/components/panel";
import { CodeText } from "@/components/provenance/code-ref";
import { StatementLine } from "@/components/statement-line";
import { api } from "@/lib/data/client";
import type { Brief } from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 页面4 会前准备 —— 五个环节的第四格。
 *
 * 这一页是**压缩**，不是汇总。它站在 DRI 方案回传之后、一号位拍板之前：调研文档、
 * 回传的推荐、各方分歧，全部压成他在会前十分钟能读完的一页。所以它不是材料堆 ——
 * 材料堆意味着一号位还得自己读、自己比、自己找出分歧在哪，那道工序就等于没做。
 *
 * 版面顺序是固定的，而且 **最强反证的视觉权重不低于 DRI 推荐**。把最强的反面意见降级
 * 成脚注，跟没有反谄媚机制是一回事：读者一路读到推荐，点头同意，从没遇见反对的那一面。
 *
 * 全页只读，只有一个动作：建议追问那几条，点开看「他答不上来说明什么」。会前准备的
 * 实质就是这个 —— 不是把材料再读一遍，是想清楚要问哪几句、以及答案意味着什么。
 */
export function BriefView({ id, bare = false }: { id: string; bare?: boolean }) {
  const resource = useResource<Brief>(`brief:${id}`, () => api.getBrief(id));
  /* 会议页把它嵌在两挡滑块下面，那一层已经有页容器了 —— 不要套两层。 */
  const Shell = bare ? BareShell : Panel;

  return (
    <Shell>
      <AsyncBoundary resource={resource} skeleton={<BriefSkeleton />}>
        {(brief) => (
          <>
            {bare ? null : <p className="meta text-ink-faint">会前准备 · {id}</p>}

            {/*
             * 压缩后的那一句。整页最上面的一行字，而且是这一页存在的证明：如果这
             * 一句写不出来，说明前面几环没有收敛，那就不该开会。
             */}
            <p className={cn("report text-xl leading-relaxed text-ink", bare || "mt-2")}>
              {brief.coreJudgment}
            </p>

            <Section label="要决定的问题">
              <p className="report text-lg text-ink">{brief.problem}</p>
            </Section>

            <Section label="DRI 推荐">
              <div className="rounded-xl border border-hairline bg-surface px-4 py-3.5">
                <StatementLine statement={brief.driRecommendation} />
              </div>
            </Section>

            <Section label="关键 Evidence">
              <div className="space-y-2.5">
                {brief.keyEvidence.map((e, i) => (
                  <StatementLine key={i} statement={e} />
                ))}
              </div>
            </Section>

            {/* No outer section label: the card carries its own title so the
                block reads as a first-class exhibit rather than one more
                labelled row in a list. Its weight must not fall below the DRI
                recommendation above it. */}
            <section className="mt-8">
              <div className="rounded-xl border-2 border-counter bg-counter-wash px-4 py-3.5">
                <h2 className="meta inline-flex items-center gap-1.5 text-counter">
                  <AlertTriangle className="size-3.5" />
                  风险
                </h2>
                <StatementLine
                  className="mt-2"
                  statement={brief.strongestCounter}
                />
              </div>
            </section>

            <Section label="开放分歧">
              <div className="space-y-2">
                {brief.divergences.map((d, i) => (
                  <DivergenceBlock key={i} divergence={d} />
                ))}
              </div>
            </Section>

            <Section label="建议追问">
              <ul className="space-y-1.5">
                {brief.suggestedQuestions.map((q, i) => (
                  <Question key={i} q={q.q} implication={q.implication} />
                ))}
              </ul>
            </Section>

            {/*
             * 页尾一行：这场会赌的是哪几句话。进会议室之前赌注就得在桌上 —— 会开
             * 到一半才发现「原来动的是那条红线」，一页纸就白准备了。写回之后再打
             * 开，这里的版本号已经是新的（EXT-10 取的是活对象）。
             */}
            {brief.judgments?.length ? (
              <section className="mt-9 border-t border-hairline pt-3.5">
                <h2 className="meta text-ink-faint">此议题会造成的内部影响</h2>
                <ul className="mt-1.5 space-y-1">
                  {brief.judgments.map((j) => {
                    const armed = j.reopenTriggers.filter((t) => t.armed).length;
                    return (
                      <li key={j.id} className="text-sm leading-relaxed text-ink-muted">
                        <CodeText
                          text={`${j.id}「${j.statement}」v${j.version} 将翻版或被放弃${
                            armed > 0 ? ` · 已布控的 ${armed} 条重开条件将重估` : ""
                          }`}
                        />
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </AsyncBoundary>
    </Shell>
  );
}

/**
 * 一条建议追问。
 *
 * 追问本身一行就够，但它的含义要藏在一次点击后面：一号位读一页纸的时候，脑子里在选
 * 「我要问哪几句」，不是在读三段解释。选中的那一句他才想知道「答不上来说明什么」——
 * 那句话才是这条追问真正的价值，也是他在会上听到答案时唯一要判断的东西。
 */
function Question({ q, implication }: { q: string; implication: string }) {
  const [open, setOpen] = useState(false);

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "w-full rounded-md border px-3 py-2 text-left text-md text-ink transition-colors duration-fast ease-swift",
          open ? "border-hairline-strong bg-neutral-wash" : "border-hairline hover:bg-neutral-wash",
        )}
      >
        <CodeText text={q} />
      </button>
      {open ? (
        <p className="animate-fade mt-1.5 border-l-2 border-judgment pl-3 text-base leading-relaxed text-ink-muted">
          {implication}
        </p>
      ) : null}
    </li>
  );
}

/** 嵌进别的页面时的空壳：只保留一条阅读宽度，不再加第二层页边距。 */
function BareShell({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-[780px]">{children}</div>;
}

function BriefSkeleton() {
  return (
    <div aria-live="polite">
      <div className="border-b border-hairline pb-4">
        <span className="skeleton block h-2.5 w-40" />
        <span className="skeleton mt-2.5 block h-3 w-full" />
        <span className="skeleton mt-1.5 block h-3 w-[64%]" />
      </div>
      {[0, 1, 2, 3].map((n) => (
        <div key={n} className="mt-8">
          <span className="skeleton block h-2.5 w-20" />
          <span className="skeleton mt-2.5 block h-4 w-[92%]" />
          <span className="skeleton mt-1.5 block h-4 w-[58%]" />
        </div>
      ))}
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="mt-8 first:mt-0">
      <h2 className="meta mb-2 text-ink-faint">{label}</h2>
      {children}
    </section>
  );
}
