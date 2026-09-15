"use client";

import { useState } from "react";
import { ActionButton } from "@/components/action-button";
import { AsyncBoundary } from "@/components/async-boundary";
import { Panel, PanelHead } from "@/components/panel";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/data/client";
import { formatDay } from "@/lib/format";
import type { DriHandoff } from "@/lib/data/types";
import { useResource, type Resource } from "@/lib/use-resource";

/**
 * 承接研究页。DRI 读交接包、写回一份原件加四节。
 *
 * 交接包是从深研四节装配出来的，可能为 null（还没有深研报告时装配不出来）。null 时
 * 照实说「这件事还没有交接包正文，只有问题本身」，不摆一个空框。
 *
 * 回传的四节每句盖 `traces: [{ kind:"human", source:"<姓名>（<域> DRI）" }]` ——
 * 那一层由 `submitDriReport` 在服务端盖，页面不要自己拼 traces。
 *
 * H2 约束：提交后拿服务端返回的对象 `mutate(..., { revalidate: false })`，不做
 * 乐观更新。等待态用 `ActionButton` 的 `pendingLabel` 换词不转圈。
 *
 * 这一页的纸在 boundary 外面（取不到的时候红框也该摆在纸上），纸里的一切都在
 * boundary 里面 —— 包括标题，因为标题来自数据，取不到的时候没有一个诚实的标题可写。
 */
export function DriHandoffView({ issueId }: { issueId: string }) {
  const handoffs = useResource<DriHandoff[]>("dri-handoffs", () => api.listMyHandoffs());

  return (
    <Panel>
      <AsyncBoundary resource={handoffs} skeleton={<div className="h-96" />}>
        {(list) => <HandoffContent issueId={issueId} handoffs={handoffs} list={list} />}
      </AsyncBoundary>
    </Panel>
  );
}

function HandoffContent({
  issueId,
  handoffs,
  list,
}: {
  issueId: string;
  handoffs: Resource<DriHandoff[]>;
  list: DriHandoff[];
}) {
  const handoff = list.find((h) => h.issueId === issueId);

  const [sourceText, setSourceText] = useState("");
  const [judgment, setJudgment] = useState("");
  const [keyEvidence, setKeyEvidence] = useState("");
  const [counters, setCounters] = useState("");
  const [unknowns, setUnknowns] = useState("");
  const [routeSuggestion, setRouteSuggestion] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async () => {
    setPending(true);
    setFailure(null);
    try {
      const result = await api.submitDriReport(issueId, {
        sourceText,
        judgment: judgment.split("\n").filter((s) => s.trim()),
        keyEvidence: keyEvidence.split("\n").filter((s) => s.trim()),
        counters: counters.split("\n").filter((s) => s.trim()),
        unknowns: unknowns.split("\n").filter((s) => s.trim()),
        routeSuggestion,
      });
      // H2 约束：写完拿服务端返回的对象 mutate，不做乐观更新。
      handoffs.mutate(
        (prev) => (prev ?? []).map((h) => (h.issueId === issueId ? result : h)),
        { revalidate: false },
      );
      // 清空表单
      setSourceText("");
      setJudgment("");
      setKeyEvidence("");
      setCounters("");
      setUnknowns("");
      setRouteSuggestion("");
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : "这一下没有走完。");
    } finally {
      setPending(false);
    }
  };

  // 四节里总得有一句
  const hasFourSections =
    judgment.trim() || keyEvidence.trim() || counters.trim() || unknowns.trim();

  if (!handoff) {
    return (
      <>
        <PanelHead eyebrow="承接研究" title="这件事不在你手上" />
        <p className="mt-6 text-base text-ink-muted">这件事没有派给你，或者 ID 不存在。</p>
      </>
    );
  }

  return (
    <>
      <PanelHead eyebrow="承接研究" title={handoff.title} />

      {handoff.submitted ? (
        <p className="mt-6 text-sm text-ink-muted">
          {handoff.submittedAt
            ? `你在 ${formatDay(handoff.submittedAt)} 回传过一次，再提交会覆盖。`
            : "你回传过一次，再提交会覆盖。"}
        </p>
      ) : null}

      <div className="mt-8 grid gap-8 lg:grid-cols-2">
        {/* 左：交接包 */}
        <section>
          <h2 className="text-lg font-medium text-ink">交接包</h2>
          {handoff.brief ? (
            <div className="mt-4 space-y-4 rounded-xl border border-hairline bg-surface px-5 py-4">
              {handoff.brief.split("\n\n").map((para, i) =>
                para.startsWith("## ") ? (
                  <h3 key={i} className="report pt-2 text-lg font-medium text-ink">
                    {para.slice(3)}
                  </h3>
                ) : (
                  <p key={i} className="report text-read leading-relaxed text-ink">
                    {para}
                  </p>
                ),
              )}
            </div>
          ) : (
            <p className="mt-4 text-base text-ink-muted">
              这件事还没有交接包正文，只有问题本身。
            </p>
          )}
          {handoff.question ? (
            <div className="mt-4 rounded-xl border border-hairline bg-neutral-wash px-4 py-3">
              <p className="meta text-ink-muted">要回答的问题</p>
              <p className="mt-1 text-base text-ink">{handoff.question}</p>
              {handoff.deadline ? (
                <p className="meta mt-1 text-ink-faint">截止 {handoff.deadline}</p>
              ) : null}
            </div>
          ) : null}
        </section>

        {/* 右：输入区域 */}
        <section>
          <h2 className="text-lg font-medium text-ink">你的研究</h2>
          <div className="mt-4 space-y-5">
            <Field
              label="原件"
              hint="空行分段，`## ` 起小标题"
              rows={8}
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
            />
            <Field
              label="一、当前判断"
              hint="一行一句"
              rows={3}
              value={judgment}
              onChange={(e) => setJudgment(e.target.value)}
            />
            <Field
              label="二、关键 Evidence"
              hint="一行一句"
              rows={3}
              value={keyEvidence}
              onChange={(e) => setKeyEvidence(e.target.value)}
            />
            <Field
              label="三、反证与风险"
              hint="一行一句"
              rows={3}
              value={counters}
              onChange={(e) => setCounters(e.target.value)}
            />
            <Field
              label="四、不确定性"
              hint="一行一句"
              rows={3}
              value={unknowns}
              onChange={(e) => setUnknowns(e.target.value)}
            />
            <Field
              label="五、建议分流"
              hint="一句话"
              rows={2}
              value={routeSuggestion}
              onChange={(e) => setRouteSuggestion(e.target.value)}
            />

            {failure ? <p className="text-sm text-counter">{failure}</p> : null}

            <div className="flex items-center gap-3">
              <ActionButton
                pending={pending}
                pendingLabel="正在回传…"
                onAction={submit}
                disabled={!hasFourSections}
              >
                回传
              </ActionButton>
              {!hasFourSections ? (
                <span className="text-sm text-ink-muted">四节里总得有一句</span>
              ) : null}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function Field({
  label,
  hint,
  rows,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  rows: number;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
}) {
  return (
    <label className="block">
      <span className="text-base text-ink">{label}</span>
      <span className="meta mt-0.5 block text-ink-muted">{hint}</span>
      <span className="mt-2 block">
        <Textarea value={value} onChange={onChange} rows={rows} />
      </span>
    </label>
  );
}
