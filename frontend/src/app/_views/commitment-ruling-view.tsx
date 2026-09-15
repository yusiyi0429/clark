"use client";

import { useState } from "react";
import { ActionButton } from "@/components/action-button";
import { AsyncBoundary, LoadingLine } from "@/components/async-boundary";
import { Panel, PanelHead } from "@/components/panel";
import { Button } from "@/components/ui/button";
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
import { useInvalidate, useResource } from "@/lib/use-resource";

/**
 * 一号位逐条裁决页。公司提案、DRI 标注、裁决三样并置在同一张卡上。
 *
 * 状态机：只有 submitted 时能裁决，只有 adjudicated 之后能签发。
 *
 * 裁决是三档：endorse（认可）/ revise（修订）/ reject（拒绝）。revise 和 reject
 * 时「理由」在前端标必填，但服务端不校验 —— 这是有意的：一号位有可能就是要口头说，
 * 而不把那句话写进系统。前端标必填是为了提醒他「一个没有理由的修订会让 DRI 猜」，
 * 服务端不拒空 note 是因为他可以选择承担这个代价。
 *
 * H2 约束：提交后拿服务端返回的对象 mutate，不做乐观更新。
 */
export function CommitmentRulingView({ id }: { id: string }) {
  const commitment = useResource<CommitmentScreen>(
    `commitment:${id}`,
    () => api.getCommitment(id)
  );

  return (
    <Panel>
      <PanelHead
        eyebrow={
          commitment.data
            ? commitment.data.rounds > 0
              ? `${commitment.data.domainCode} · ${commitment.data.domainName} · 第 ${commitment.data.rounds} 轮`
              : `${commitment.data.domainCode} · ${commitment.data.domainName}`
            : "本期承诺"
        }
        title="逐条裁决"
        sub="修订和拒绝时理由必填。"
      />

      <AsyncBoundary resource={commitment} skeleton={<LoadingLine label="正在加载裁决页" />}>
        {(data) => (
          <RulingBlock
            key={`${data.id}-v${data.version}-${data.status}`}
            commitment={data}
            resource={commitment}
            id={id}
          />
        )}
      </AsyncBoundary>
    </Panel>
  );
}

function RulingBlock({
  commitment: c,
  resource,
  id,
}: {
  commitment: CommitmentScreen;
  resource: ReturnType<typeof useResource<CommitmentScreen>>;
  id: string;
}) {
  const canAdjudicate = c.status === "submitted";
  const canSign = c.status === "adjudicated";
  const invalidate = useInvalidate();

  /**
   * 表单 state 深拷贝：不许持有服务端对象，否则每敲一个字都在改缓存。
   *
   * 裁决的初始值：已有 ruling 就回显，没有就默认 endorse + 空 note。
   */
  const [rulings, setRulings] = useState(
    Object.fromEntries(
      c.items.map((item) => [
        item.id,
        {
          verdict: item.ruling?.verdict ?? "endorse",
          note: item.ruling?.note ?? "",
        },
      ])
    ) as Record<string, { verdict: "endorse" | "revise" | "reject"; note: string }>
  );

  const [adjudicatePending, setAdjudicatePending] = useState(false);
  const [adjudicateFailure, setAdjudicateFailure] = useState<string | null>(null);

  const [signPending, setSignPending] = useState(false);
  const [signFailure, setSignFailure] = useState<string | null>(null);
  const [signConfirmOpen, setSignConfirmOpen] = useState(false);

  const submitAdjudication = async () => {
    setAdjudicatePending(true);
    setAdjudicateFailure(null);
    try {
      const result = await api.adjudicateCommitment(id, rulings);
      /**
       * H2 约束：写完拿服务端返回的对象 mutate，不做乐观更新。
       *
       * invalidate 的参数是**此刻屏幕上的 key**（列进去的原地重问、保留旧数据；
       * 没列进去的全部清空）。这一页的 key 是 `commitment:${id}`，列它保留本页；
       * `/outcomes` 用的 `outcomes` 落进「其余」被清，他回去时一定是新的。
       */
      resource.mutate(result, { revalidate: false });
      invalidate(`commitment:${id}`);
    } catch (err) {
      setAdjudicateFailure(err instanceof ApiError ? err.message : "这一下没有走完。");
    } finally {
      setAdjudicatePending(false);
    }
  };

  const signEffective = async () => {
    setSignPending(true);
    setSignFailure(null);
    try {
      const result = await api.signCommitment(id);
      resource.mutate(result, { revalidate: false });
      invalidate(`commitment:${id}`);
      setSignConfirmOpen(false);
    } catch (err) {
      setSignFailure(err instanceof ApiError ? err.message : "这一下没有走完。");
    } finally {
      setSignPending(false);
    }
  };

  /**
   * 校验：revise 和 reject 时前端标必填（理由不能空）。
   * 服务端不校验 —— 一号位可以选择承担「没理由会让 DRI 猜」的代价。
   */
  const canSubmitAdjudication =
    canAdjudicate &&
    Object.values(rulings).every(
      (r) => r.verdict === "endorse" || r.note.trim()
    );

  return (
    <>
      {/* 顶部四区：北极星、假设、前提、问题，只读 */}
      <div className="space-y-5 border-b border-hairline pb-6">
        <ReadOnlyField label="北极星">
          <p className="text-sm text-ink">{c.northStar}</p>
        </ReadOnlyField>

        {c.assumptions.length > 0 && (
          <ReadOnlyField label="假设">
            <div className="space-y-2">
              {c.assumptions.map((a, idx) => (
                <div
                  key={idx}
                  className={
                    a.defaultPath.trim()
                      ? "text-sm text-ink-muted"
                      : "rounded-md bg-counter-wash px-2 py-1.5 text-sm text-ink"
                  }
                >
                  <p>
                    <span className="font-medium">假设：</span>
                    {a.text}
                  </p>
                  {a.defaultPath.trim() ? (
                    <p className="mt-0.5">
                      <span className="font-medium">逾期默认路径：</span>
                      {a.defaultPath}
                    </p>
                  ) : (
                    <p className="mt-0.5 text-counter">未写逾期默认路径</p>
                  )}
                  {a.dueOn && (
                    <p className="meta mt-0.5">到期日：{a.dueOn}</p>
                  )}
                </div>
              ))}
            </div>
          </ReadOnlyField>
        )}

        {c.preconditions.length > 0 && (
          <ReadOnlyField label="生效前提">
            <ul className="list-inside list-disc space-y-1 text-sm text-ink-muted">
              {c.preconditions.map((p, idx) => (
                <li key={idx}>{p}</li>
              ))}
            </ul>
          </ReadOnlyField>
        )}

        {c.questions.length > 0 && (
          <ReadOnlyField label="问题">
            <div className="space-y-2">
              {c.questions.map((q, idx) => (
                <div key={idx} className="text-sm text-ink-muted">
                  <p>
                    <span className="font-medium">问题：</span>
                    {q.text}
                  </p>
                  <p className="meta mt-0.5">
                    问谁：{q.toWhom} · 什么时候要：{q.needBy}
                    {q.closed && " · 已关闭"}
                  </p>
                </div>
              ))}
            </div>
          </ReadOnlyField>
        )}
      </div>

      {/* 逐条裁决：一条 Mission 一张卡 */}
      <div className="mt-6 space-y-6">
        {c.items.map((item) => {
          /**
           * 回落而不是 early return：commitmentsIntake 允许覆盖 drafted 状态的纲领
           * （幂等设计），重灌之后 items[].id 换了，而重播种的 key 恰好不变 ——
           * rulings 里全是旧 id。early return 会把整张卡（含公司提案原文）凭空丢掉，
           * 一句解释都没有。回落让展示不依赖表单 state，屏幕上始终有内容。
           */
          const ruling = rulings[item.id] ?? {
            verdict: item.ruling?.verdict ?? "endorse",
            note: item.ruling?.note ?? "",
          };

          const needReason = ruling.verdict !== "endorse";

          return (
            <div
              key={item.id}
              className="rounded-xl border border-hairline bg-surface px-5 py-4 space-y-4"
            >
              {/* 公司提案原文，四个状态都显示，只读 */}
              <div className="border-l-2 border-ink-faint pl-3">
                <p className="meta text-ink-muted">公司提案，原文照录</p>
                <p className="mt-1 text-base text-ink-muted">{item.proposed}</p>
              </div>

              {/* DRI 标注，drafted 时藏起来，显示等待提示 */}
              {c.status === "drafted" ? (
                <p className="text-sm text-ink-muted">
                  等这个域的 DRI 逐条标注
                </p>
              ) : (
                <div className="space-y-3">
                  <div>
                    <p className="meta text-ink-faint">DRI 表态</p>
                    <p className="mt-1 text-sm text-ink">
                      {COMMITMENT_VERDICT_LABEL[item.verdict]}
                      {item.reason && ` · ${item.reason}`}
                    </p>
                  </div>

                  {item.evidence.length > 0 && (
                    <div>
                      <p className="meta text-ink-faint">成功证据</p>
                      <ul className="mt-1 list-inside list-disc space-y-0.5 text-sm text-ink-muted">
                        {item.evidence.map((e, idx) => (
                          <li key={idx}>{e}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="grid gap-3 sm:grid-cols-2">
                    {item.milestone.companyGate && (
                      <div>
                        <p className="meta text-ink-faint">公司节点</p>
                        <p className="mt-1 text-sm text-ink-muted">
                          {item.milestone.companyGate}
                        </p>
                      </div>
                    )}
                    {item.milestone.own && (
                      <div>
                        <p className="meta text-ink-faint">自己的节点</p>
                        <p className="mt-1 text-sm text-ink-muted">
                          {item.milestone.own}
                        </p>
                      </div>
                    )}
                  </div>

                  <div>
                    <p className="meta text-ink-faint">分层</p>
                    <p className="mt-1 text-sm text-ink-muted">
                      {item.tier === "acceptance" ? "验收项" : "实现必需项"}
                    </p>
                  </div>
                </div>
              )}

              {/* 裁决区：三档 + 理由 */}
              <div className="space-y-3 border-t border-hairline pt-4">
                <Field label="你的裁决">
                  <NativeSelect
                    value={ruling.verdict}
                    onChange={(e) => {
                      setRulings((prev) => ({
                        ...prev,
                        [item.id]: {
                          ...prev[item.id],
                          verdict: e.target.value as typeof ruling.verdict,
                        },
                      }));
                    }}
                    disabled={!canAdjudicate}
                  >
                    <option value="endorse">{COMMITMENT_RULING_LABEL.endorse}</option>
                    <option value="revise">{COMMITMENT_RULING_LABEL.revise}</option>
                    <option value="reject">{COMMITMENT_RULING_LABEL.reject}</option>
                  </NativeSelect>
                </Field>

                {needReason && (
                  <Field label="理由" hint="修订和拒绝时必填">
                    <Textarea
                      value={ruling.note}
                      onChange={(e) => {
                        setRulings((prev) => ({
                          ...prev,
                          [item.id]: {
                            ...prev[item.id],
                            note: e.target.value,
                          },
                        }));
                      }}
                      rows={2}
                      disabled={!canAdjudicate}
                      aria-invalid={needReason && !ruling.note.trim()}
                    />
                  </Field>
                )}
              </div>

              {/* 已裁决过的：回显 */}
              {item.ruling && (
                <div className="rounded-lg bg-neutral-wash px-4 py-3">
                  <p className="text-sm text-ink">
                    已裁决：{COMMITMENT_RULING_LABEL[item.ruling.verdict]}
                    {item.ruling.note && ` · ${item.ruling.note}`}
                    {` · ${formatDay(item.ruling.at)}`}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* 底部动作区 */}
      {(canAdjudicate || canSign || c.status === "effective") && (
        <div className="mt-8 space-y-4 border-t border-hairline pt-6">
          {/* 提交裁决 */}
          {canAdjudicate && (
            <div>
              <div className="flex items-center gap-3">
                <ActionButton
                  pending={adjudicatePending}
                  pendingLabel="正在提交裁决…"
                  onAction={submitAdjudication}
                  disabled={!canSubmitAdjudication}
                >
                  提交这一轮裁决
                </ActionButton>
                {!canSubmitAdjudication && (
                  <span className="text-sm text-ink-muted">
                    修订和拒绝时理由必填
                  </span>
                )}
              </div>
              {adjudicateFailure && (
                <p className="mt-2 text-sm text-counter">{adjudicateFailure}</p>
              )}
            </div>
          )}

          {/* 签发生效 */}
          {canSign && (
            <div>
              {!signConfirmOpen ? (
                <Button onClick={() => setSignConfirmOpen(true)}>
                  签发生效
                </Button>
              ) : (
                <div className="rounded-lg border border-judgment/25 bg-judgment-wash px-4 py-3">
                  <p className="text-sm text-ink">
                    签发之后这一份就只读了。确认签发？
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <ActionButton
                      pending={signPending}
                      pendingLabel="正在签发…"
                      onAction={signEffective}
                    >
                      确认签发
                    </ActionButton>
                    <button
                      type="button"
                      onClick={() => setSignConfirmOpen(false)}
                      disabled={signPending}
                      className="text-sm text-ink-muted underline decoration-hairline underline-offset-2 hover:decoration-ink-faint"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
              {signFailure && (
                <p className="mt-2 text-sm text-counter">{signFailure}</p>
              )}
            </div>
          )}

          {/* 已生效 */}
          {c.status === "effective" && (
            <p className="text-sm text-ink-muted">
              已生效，第 {c.rounds} 轮收敛 · {formatDay(c.revisions[c.revisions.length - 1].at)}
            </p>
          )}
        </div>
      )}
    </>
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
      <p className="text-sm text-ink">{label}</p>
      {hint && <p className="meta mt-0.5 text-ink-muted">{hint}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

function ReadOnlyField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-sm font-medium text-ink">{label}</p>
      <div className="mt-2">{children}</div>
    </div>
  );
}
