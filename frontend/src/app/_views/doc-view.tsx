"use client";

import Link from "next/link";
import { useRef } from "react";

import { AsyncBoundary } from "@/components/async-boundary";
import { SelectionCue } from "@/components/provenance/selection-cue";
import { StandingTag } from "@/components/standing-tag";
import { Panel, PanelHead, PanelSection } from "@/components/panel";
import { api } from "@/lib/data/client";
import { formatDay } from "@/lib/format";
import type { Doc, Judgment, Person } from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";

/**
 * 一份文档 (`/docs/[id]`)。
 *
 * 它是**只读**的，而且屏幕上写着原件在哪儿。Clark 不是在这里编辑公司文档 —— 那是飞书
 * 的活儿，也是田田的活儿。这里只做两件事：让正文能被读，让正文能被框选着问「这句哪来
 * 的」。
 *
 * 文档在这个产品里的身份是**依据**，所以正文下面那一段「哪些判断压在它身上」不是附加
 * 信息，它才是这一页存在的理由：一号位读到纲领里那句「灯塔是本阶段唯一入口」，紧接着
 * 要能看见公司有八条判断正压在这句话上 —— 那一刻他才明白改这句话意味着什么。
 */
export function DocView({ id }: { id: string }) {
  const resource = useResource(`doc:${id}`, () => api.getDoc(id));

  return (
    <Panel>
      <AsyncBoundary resource={resource} skeleton={<DocSkeleton />}>
        {(data) => (
          <DocScreen doc={data.doc} citedBy={data.citedBy} owner={data.owner} />
        )}
      </AsyncBoundary>
    </Panel>
  );
}

function DocScreen({
  doc,
  citedBy,
  owner,
}: {
  doc: Doc;
  citedBy: Judgment[];
  owner?: Person;
}) {
  const body = useRef<HTMLDivElement>(null);

  return (
    <>
      {/* eyebrow 只有 `mirrorOf`：它自己就写着来源（「飞书云文档 · 战略/2026Q3」）。 */}
      <PanelHead
        eyebrow={doc.mirrorOf}
        title={doc.title}
        sub={
          <>
            {owner ? `${owner.name}维护 · ` : null}
            {formatDay(doc.updatedAt)} 更新 ·{" "}
            {/*
              「改动请回原件」只对飞书和云盘那些说得通。TKOS 内生成的和别人 Agent 回传
              的没有原件，对着一份不存在的原件让他「回去改」，是屏幕在说假话。
            */}
            {doc.source === "clark" ? "这一页只读" : "这里是镜像，改动请回原件"}
          </>
        }
      />

      {/*
        正文。框选任意一段可以问出处 —— 文档是链条的一端，所以从这里往回查，查到的是
        「有哪几条判断因为这一段才成立」。
      */}
      <div ref={body} className="relative">
        <SelectionCue scope={body} />
        <article className="report space-y-3.5 text-md text-ink">
          {doc.body.split(/\n{2,}/).map((para, i) =>
            para.startsWith("## ") ? (
              <h2
                key={i}
                className="pt-3 text-base font-medium tracking-[-0.01em] text-ink first:pt-0"
                style={{ fontFamily: "var(--font-sans)" }}
              >
                {para.slice(3)}
              </h2>
            ) : (
              <p key={i}>{para}</p>
            ),
          )}
        </article>
      </div>

      <PanelSection
        title="哪些判断压在它身上"
        count={citedBy.length > 0 ? citedBy.length : undefined}
        className="mt-9"
      >
        {citedBy.length === 0 ? (
          <p className="text-sm text-ink-muted">还没有判断引用它。</p>
        ) : (
          <ul className="border-t border-hairline">
            {citedBy.map((j) => (
              <li key={j.id} className="border-b border-hairline py-2.5">
                <div className="flex items-baseline gap-2.5">
                  <Link
                    href={`/judgments/${j.id}`}
                    className="meta w-12 flex-none rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-ink"
                  >
                    {j.id}
                  </Link>
                  <Link
                    href={`/judgments/${j.id}`}
                    className="report min-w-0 flex-1 rounded-[3px] text-sm text-ink underline decoration-transparent underline-offset-[3px] transition-colors duration-fast hover:decoration-hairline"
                  >
                    {j.statement}
                  </Link>
                  <StandingTag judgment={j} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
    </>
  );
}

function DocSkeleton() {
  return (
    <div aria-live="polite">
      <span className="skeleton block h-2.5 w-32" />
      <span className="skeleton mt-3 block h-4 w-[70%]" />
      <span className="skeleton mt-2.5 block h-2.5 w-48" />
      <div className="mt-7 space-y-2">
        {[100, 97, 92, 100, 84, 100, 96, 61].map((w, i) => (
          <span key={i} className="skeleton block h-3.5" style={{ width: `${w}%` }} />
        ))}
      </div>
    </div>
  );
}
