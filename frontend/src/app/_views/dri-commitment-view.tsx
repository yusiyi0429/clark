"use client";

import { useState } from "react";
import { ActionButton } from "@/components/action-button";
import { AsyncBoundary } from "@/components/async-boundary";
import { Panel, PanelHead } from "@/components/panel";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  api,
  ApiError,
  COMMITMENT_RULING_LABEL,
  COMMITMENT_VERDICT_LABEL,
} from "@/lib/data/client";
import { formatDay } from "@/lib/format";
import type { CommitmentScreen } from "@/lib/data/types";
import { useInvalidate, useResource, type Resource } from "@/lib/use-resource";

/**
 * OM 逐条回传页。DRI 标注纲领，一条 Mission 一张卡，卡内不折叠。
 *
 * 两轮收敛的根源是条目级回传（G2）：IM 卡片承载不了这个结构，这是这一侧要有网页的原因。
 *
 * 布局：一个域一块（一个人可能负责两个域），域之间用分隔线分开，不做页签。
 * 状态：drafted → submitted → adjudicated → effective。submitted 和 effective 都只读。
 *
 * H2 约束：提交后拿服务端返回的对象 mutate，不做乐观更新。
 */
export function DriCommitmentView({ periodId }: { periodId: string }) {
  const commitments = useResource<CommitmentScreen[]>(
    `commitments:${periodId}`,
    () => api.listMyCommitments(periodId)
  );

  return (
    <Panel>
      <PanelHead eyebrow="本期承诺" title="OM 纲领回传" />

      <div className="mt-8">
        <AsyncBoundary resource={commitments} skeleton={<div className="h-16" />}>
          {(data) => {
            if (data.length === 0) {
              return <p className="text-base text-ink-muted">这一期的纲领还没有下发。</p>;
            }
            return (
              <div>
                {data.map((c, idx) => (
                  <div key={c.id} className={idx > 0 ? "border-t border-hairline pt-8 mt-8" : ""}>
                    <CommitmentBlock
                      key={`${c.id}-v${c.version}-${c.status}`}
                      commitment={c}
                      commitments={commitments}
                    />
                  </div>
                ))}
              </div>
            );
          }}
        </AsyncBoundary>
      </div>
    </Panel>
  );
}

/**
 * 一个域的承诺块。状态行、北极星、逐条 Mission、假设、前提、问题、提交按钮。
 */
function CommitmentBlock({
  commitment,
  commitments,
}: {
  commitment: CommitmentScreen;
  commitments: Resource<CommitmentScreen[]>;
}) {
  const c = commitment;
  const isReadOnly = c.status === "effective" || c.status === "submitted";
  const invalidate = useInvalidate();

  /**
   * 表单 state 深拷贝：不许持有服务端对象，否则每敲一个字都在改缓存。
   *
   * 提交后重新播种：服务端会规范化（trim / 去空行），屏幕要显示服务端确认过的形状。
   */
  const [northStar, setNorthStar] = useState(c.northStar);
  const [items, setItems] = useState(
    c.items.map((item) => ({
      id: item.id,
      verdict: item.verdict,
      reason: item.reason ?? "",
      evidence: item.evidence.join("\n"),
      milestone: { companyGate: item.milestone.companyGate ?? "", own: item.milestone.own ?? "" },
      tier: item.tier,
    }))
  );
  const [assumptions, setAssumptions] = useState(
    c.assumptions.map((a) => ({ text: a.text, defaultPath: a.defaultPath, dueOn: a.dueOn ?? "" }))
  );
  const [preconditions, setPreconditions] = useState(c.preconditions.slice());
  const [questions, setQuestions] = useState(
    c.questions.map((q) => ({ text: q.text, toWhom: q.toWhom, needBy: q.needBy, closed: q.closed }))
  );

  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async () => {
    setPending(true);
    setFailure(null);
    try {
      /**
       * 提交前去掉全空行：空行原样写进本体会让 CEO 侧看到 `{text:"",defaultPath:""}`。
       */
      const filteredAssumptions = assumptions.filter((a) => a.text.trim() || a.defaultPath.trim());
      const filteredPreconditions = preconditions.filter((p) => p.trim());
      const filteredQuestions = questions.filter((q) => q.text.trim() || q.toWhom.trim());

      const result = await api.submitCommitment(c.id, {
        northStar,
        items: items.map((item) => ({
          id: item.id,
          verdict: item.verdict,
          reason: item.reason,
          evidence: item.evidence.split("\n").filter((s) => s.trim()),
          milestone: item.milestone,
          tier: item.tier,
        })),
        assumptions: filteredAssumptions.map((a) => ({
          text: a.text,
          defaultPath: a.defaultPath,
          ...(a.dueOn ? { dueOn: a.dueOn } : {}),
        })),
        preconditions: filteredPreconditions,
        questions: filteredQuestions,
        note: `第 ${c.rounds + 1} 轮回传`,
      });

      /**
       * H2 约束：写完拿服务端返回的对象 mutate，不做乐观更新。
       *
       * invalidate 的参数是**此刻屏幕上的 key**（列进去的原地重问、保留旧数据；
       * 没列进去的全部清空）。这一页的 key 是 `commitments:${c.periodId}`，列它保留本页；
       * 首页用的 `dri-commitments` 落进「其余」被清，他回到 `/dri` 时一定是新的。
       */
      commitments.mutate(
        (prev) => (prev ?? []).map((cm) => (cm.id === c.id ? result : cm)),
        { revalidate: false }
      );
      invalidate(`commitments:${c.periodId}`);
    } catch (err) {
      setFailure(err instanceof ApiError ? err.message : "这一下没有走完。");
    } finally {
      setPending(false);
    }
  };

  // 校验：北极星必填，每条非接受的要有理由
  const canSubmit =
    !isReadOnly &&
    northStar.trim() &&
    items.every((item) => item.verdict === "accept" || item.reason.trim());

  /**
   * 状态文案。submitted 是「已回传、等一号位逐条裁决」，不是「可以改」。
   */
  const statusLabel = {
    drafted: "纲领已下发，等你标注",
    submitted: `你在 ${formatDay(c.revisions[c.revisions.length - 1].at)} 交出去了，等他裁决`,
    adjudicated: `他裁完了，有 ${c.items.filter((orig) => orig.ruling && (orig.ruling.verdict === "revise" || orig.ruling.verdict === "reject")).length} 条要你改`,
    effective: `已生效，第 ${c.rounds} 轮收敛`,
  }[c.status];

  return (
    <div className="space-y-6">
      {/* 域头 */}
      <div>
        <div className="flex items-baseline gap-3">
          <h2 className="text-xl font-medium text-ink">
            {c.domainCode} · {c.domainName}
          </h2>
          <span className="text-sm text-ink-muted">{statusLabel}</span>
        </div>
        {c.rounds > 0 && (
          <p className="meta mt-1 text-ink-faint">这是第 {c.rounds} 轮</p>
        )}
      </div>

      {/* 北极星 */}
      <Field label="北极星" hint="一句话">
        <Textarea
          value={northStar}
          onChange={(e) => setNorthStar(e.target.value)}
          rows={2}
          disabled={isReadOnly}
        />
      </Field>

      {/* 逐条 Mission */}
      <div className="space-y-6">
        {c.items.map((orig) => {
          // 按 id 配对，不按下标：条目数一变就错位
          const item = items.find((i) => i.id === orig.id);
          if (!item) return null;

          const needReason = item.verdict !== "accept";
          return (
            <div
              key={orig.id}
              className="rounded-xl border border-hairline bg-surface px-5 py-4 space-y-4"
            >
              {/* proposed 原文，只读，视觉上像引文 */}
              <div className="border-l-2 border-ink-faint pl-3">
                <p className="meta text-ink-muted">公司提案，原文照录</p>
                <p className="mt-1 text-base text-ink-muted">{orig.proposed}</p>
              </div>

              {/* verdict 四档 */}
              <Field label="你的表态" hint="接受 / 修改 / 重写 / 拒绝">
                <NativeSelect
                  value={item.verdict}
                  onChange={(e) => {
                    setItems((prev) =>
                      prev.map((i) =>
                        i.id === item.id
                          ? { ...i, verdict: e.target.value as typeof item.verdict }
                          : i
                      )
                    );
                  }}
                  disabled={isReadOnly}
                >
                  <option value="accept">{COMMITMENT_VERDICT_LABEL.accept}</option>
                  <option value="modify">{COMMITMENT_VERDICT_LABEL.modify}</option>
                  <option value="rewrite">{COMMITMENT_VERDICT_LABEL.rewrite}</option>
                  <option value="reject">{COMMITMENT_VERDICT_LABEL.reject}</option>
                </NativeSelect>
              </Field>

              {/* 理由（非接受时展开并标必填） */}
              {needReason && (
                <Field label="理由" hint="非「接受」必填。">
                  <Textarea
                    value={item.reason}
                    onChange={(e) => {
                      setItems((prev) =>
                        prev.map((i) =>
                          i.id === item.id
                            ? { ...i, reason: e.target.value }
                            : i
                        )
                      );
                    }}
                    rows={2}
                    disabled={isReadOnly}
                    aria-invalid={needReason && !item.reason.trim()}
                  />
                </Field>
              )}

              {/* 成功证据 */}
              <Field label="成功证据" hint="3–5 项">
                <Textarea
                  value={item.evidence}
                  onChange={(e) => {
                    setItems((prev) =>
                      prev.map((i) =>
                        i.id === item.id
                          ? { ...i, evidence: e.target.value }
                          : i
                      )
                    );
                  }}
                  rows={4}
                  disabled={isReadOnly}
                />
              </Field>

              {/* 里程碑两栏 */}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="公司节点">
                  <Textarea
                    aria-label="公司节点"
                    value={item.milestone.companyGate}
                    onChange={(e) => {
                      setItems((prev) =>
                        prev.map((i) =>
                          i.id === item.id
                            ? { ...i, milestone: { ...i.milestone, companyGate: e.target.value } }
                            : i
                        )
                      );
                    }}
                    rows={2}
                    disabled={isReadOnly}
                  />
                </Field>
                <Field label="自己的节点">
                  <Textarea
                    aria-label="自己的节点"
                    value={item.milestone.own}
                    onChange={(e) => {
                      setItems((prev) =>
                        prev.map((i) =>
                          i.id === item.id
                            ? { ...i, milestone: { ...i.milestone, own: e.target.value } }
                            : i
                        )
                      );
                    }}
                    rows={2}
                    disabled={isReadOnly}
                  />
                </Field>
              </div>

              {/* 分层两档 */}
              <Field label="分层" hint="验收项 / 实现必需项">
                <NativeSelect
                  value={item.tier}
                  onChange={(e) => {
                    setItems((prev) =>
                      prev.map((i) =>
                        i.id === item.id
                          ? { ...i, tier: e.target.value as typeof item.tier }
                          : i
                      )
                    );
                  }}
                  disabled={isReadOnly}
                >
                  <option value="acceptance">验收项</option>
                  <option value="required">实现必需项</option>
                </NativeSelect>
              </Field>

              {/* 已裁决过的：在卡底部出一块裁决条 */}
              {orig.ruling && (
                <div className="rounded-lg bg-neutral-wash px-4 py-3">
                  <p className="text-sm text-ink">
                    他的裁决：{COMMITMENT_RULING_LABEL[orig.ruling.verdict]}
                    {orig.ruling.note && ` · ${orig.ruling.note}`}
                    {` · ${formatDay(orig.ruling.at)}`}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 假设区 */}
      <div>
        <p className="text-base text-ink">假设</p>
        <p className="meta mt-0.5 text-ink-muted">
          一行一条，三栏：假设 / 逾期默认路径 / 到期日。
        </p>
        <div className="mt-2 space-y-2">
          {assumptions.map((a, idx) => (
            <div key={idx} className="flex items-start gap-2">
              <div className="grid flex-1 gap-3 sm:grid-cols-3">
                <Textarea
                  placeholder="假设"
                  value={a.text}
                  onChange={(e) => {
                    setAssumptions((prev) =>
                      prev.map((item, i) =>
                        i === idx ? { ...item, text: e.target.value } : item
                      )
                    );
                  }}
                  rows={2}
                  disabled={isReadOnly}
                />
                <Textarea
                  placeholder="逾期默认路径"
                  value={a.defaultPath}
                  onChange={(e) => {
                    setAssumptions((prev) =>
                      prev.map((item, i) =>
                        i === idx ? { ...item, defaultPath: e.target.value } : item
                      )
                    );
                  }}
                  rows={2}
                  disabled={isReadOnly}
                />
                <Textarea
                  placeholder="到期日 YYYY-MM-DD"
                  value={a.dueOn}
                  onChange={(e) => {
                    setAssumptions((prev) =>
                      prev.map((item, i) =>
                        i === idx ? { ...item, dueOn: e.target.value } : item
                      )
                    );
                  }}
                  rows={2}
                  disabled={isReadOnly}
                />
              </div>
              {!isReadOnly && (
                <button
                  type="button"
                  onClick={() => setAssumptions((prev) => prev.filter((_, i) => i !== idx))}
                  className="mt-1.5 text-sm text-counter underline decoration-hairline underline-offset-2 hover:decoration-counter"
                >
                  删
                </button>
              )}
            </div>
          ))}
          {!isReadOnly && (
            <button
              type="button"
              onClick={() =>
                setAssumptions([...assumptions, { text: "", defaultPath: "", dueOn: "" }])
              }
              className="text-sm text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink-faint"
            >
              加一条假设
            </button>
          )}
        </div>
      </div>

      {/* 生效前提（最多两条） */}
      <div>
        <p className="text-base text-ink">生效前提</p>
        <p className="meta mt-0.5 text-ink-muted">硬上限 2 条</p>
        <div className="mt-2 space-y-2">
          {preconditions.map((p, idx) => (
            <div key={idx} className="flex items-start gap-2">
              <Textarea
                value={p}
                onChange={(e) => {
                  setPreconditions((prev) =>
                    prev.map((item, i) =>
                      i === idx ? e.target.value : item
                    )
                  );
                }}
                rows={2}
                disabled={isReadOnly}
                className="flex-1"
              />
              {!isReadOnly && (
                <button
                  type="button"
                  onClick={() => setPreconditions((prev) => prev.filter((_, i) => i !== idx))}
                  className="mt-1.5 text-sm text-counter underline decoration-hairline underline-offset-2 hover:decoration-counter"
                >
                  删
                </button>
              )}
            </div>
          ))}
          {!isReadOnly && preconditions.length < 2 && (
            <button
              type="button"
              onClick={() => setPreconditions([...preconditions, ""])}
              className="text-sm text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink-faint"
            >
              加一条前提
            </button>
          )}
        </div>
      </div>

      {/* 问题区 */}
      <div>
        <p className="text-base text-ink">问题</p>
        <p className="meta mt-0.5 text-ink-muted">
          一行一条，四栏：问题 / 问谁 / 什么时候要 / 已关闭。
        </p>
        <div className="mt-2 space-y-2">
          {questions.map((q, idx) => (
            <div key={idx} className="flex items-start gap-2">
              <div className="grid flex-1 gap-3 md:grid-cols-[2fr_1fr_1fr_auto]">
                <Textarea
                  placeholder="问题"
                  value={q.text}
                  onChange={(e) => {
                    setQuestions((prev) =>
                      prev.map((item, i) =>
                        i === idx ? { ...item, text: e.target.value } : item
                      )
                    );
                  }}
                  rows={2}
                  disabled={isReadOnly}
                />
                <Textarea
                  placeholder="问谁"
                  value={q.toWhom}
                  onChange={(e) => {
                    setQuestions((prev) =>
                      prev.map((item, i) =>
                        i === idx ? { ...item, toWhom: e.target.value } : item
                      )
                    );
                  }}
                  rows={2}
                  disabled={isReadOnly}
                />
                <Textarea
                  placeholder="什么时候要"
                  value={q.needBy}
                  onChange={(e) => {
                    setQuestions((prev) =>
                      prev.map((item, i) =>
                        i === idx ? { ...item, needBy: e.target.value } : item
                      )
                    );
                  }}
                  rows={2}
                  disabled={isReadOnly}
                />
                <label className="flex items-center gap-1.5 pt-2">
                  <Checkbox
                    checked={q.closed}
                    onCheckedChange={(checked) => {
                      setQuestions((prev) =>
                        prev.map((item, i) =>
                          i === idx ? { ...item, closed: checked === true } : item
                        )
                      );
                    }}
                    disabled={isReadOnly}
                  />
                  <span className="text-sm text-ink">已关闭</span>
                </label>
              </div>
              {!isReadOnly && (
                <button
                  type="button"
                  onClick={() => setQuestions((prev) => prev.filter((_, i) => i !== idx))}
                  className="mt-1.5 text-sm text-counter underline decoration-hairline underline-offset-2 hover:decoration-counter"
                >
                  删
                </button>
              )}
            </div>
          ))}
          {!isReadOnly && (
            <button
              type="button"
              onClick={() =>
                setQuestions([...questions, { text: "", toWhom: "", needBy: "", closed: false }])
              }
              className="text-sm text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink-faint"
            >
              加一个问题
            </button>
          )}
        </div>
      </div>

      {/* disagreementNote 在提交按钮上方，按钮不 disabled */}
      {c.note && (
        <p className="text-sm text-ink-muted">{c.note}</p>
      )}

      {failure && <p className="text-sm text-counter">{failure}</p>}

      {/* 提交按钮 */}
      {!isReadOnly && (
        <div className="flex items-center gap-3">
          <ActionButton pending={pending} pendingLabel="正在回传…" onAction={submit} disabled={!canSubmit}>
            回传
          </ActionButton>
          {!canSubmit && (
            <span className="text-sm text-ink-muted">
              {!northStar.trim()
                ? "北极星必填"
                : "每条非「接受」的要有理由"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-base text-ink">{label}</p>
      {hint ? <p className="meta mt-0.5 text-ink-muted">{hint}</p> : null}
      <div className="mt-2">{children}</div>
    </div>
  );
}
