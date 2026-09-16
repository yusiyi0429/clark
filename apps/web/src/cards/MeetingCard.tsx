"use client";

import { useRef, useState } from "react";
import { Check, ChevronLeft, FileUp, X } from "lucide-react";
import type { CardRenderProps } from "./registry";
import { payloadOf, type IssuePayload, type MeetingPayload } from "./payloads";
import { ActionFeedback, useCardAction } from "@/lib/useCardAction";
import s from "@/styles/meeting-workspace.module.css";

const ITEM_LABEL: Record<string, string> = {
  decision: "决定",
  todo: "普通待办",
  ceoJudgment: "CEO 判断",
  reopenWhen: "复议条件",
  open: "未收敛事项",
};

const EXPORT_LABEL: Record<string, string> = {
  pending_export: "待外发",
  delivered: "已送达",
  failed: "外发失败",
};

/** Meeting 页面：会前预审、Transcript 导入/替换与 MeetingOutcome 逐项确认都在这里。 */
export function MeetingCard({ card, collection, onCard, onNavigate }: CardRenderProps) {
  const payload = payloadOf<MeetingPayload>(card);
  const { state, run, retry, pending } = useCardAction(onCard);
  const [note, setNote] = useState(payload.draft.note);
  const [supplementText, setSupplementText] = useState("");
  const [supplementEntry, setSupplementEntry] = useState("");
  const [supplementTarget, setSupplementTarget] = useState(payload.leadDriId);
  const [cancelArmed, setCancelArmed] = useState(false);
  const [replaceArmed, setReplaceArmed] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);

  const actions = card.actions;
  const actionOf = (type: string) => actions.find((action) => action.actionType === type);
  const itemAction = (type: string, itemId: string) =>
    actions.find((action) => action.actionType === type && action.itemId === itemId);

  const issues = collection.filter((item) => item.kind === "issue");
  const issueById = new Map(issues.map((item) => [item.objectRef.id, item]));
  const people = new Map(payload.participants.map((person) => [person.personId, person.displayName]));
  const dri = payload.participants.filter((person) => person.roles.includes("dri"));

  function toggle(field: "readIssueIds" | "checkedEntryIds" | "carriedIssueIds", id: string) {
    const current = payload.draft[field];
    const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
    const action = actionOf("meeting.update_draft");
    if (action) void run(action, { [field]: next });
  }

  /** 首次导入：multipart 单文件；与 DRI service API 共用同一校验边界。 */
  async function uploadTranscript() {
    const file = uploadRef.current?.files?.[0];
    if (!file) {
      setUploadError("请先选择 warmap-transcript.v1 JSON 文件。");
      return;
    }
    setUploading(true);
    setUploadError(null);
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(`/api/meetings/${card.objectRef.id}/transcript`, { method: "POST", body: form });
    setUploading(false);
    if (response.status === 401) {
      onNavigate("/access");
      return;
    }
    const body = (await response.json().catch(() => ({}))) as { message?: string; cards?: typeof collection };
    if (response.ok && body.cards?.[0]) {
      onCard(body.cards[0]);
      return;
    }
    setUploadError(body.message ?? "Transcript 整份被拒绝");
  }

  /** 危险替换：必须先确认，再以 confirmReplace:true 提交整份 Transcript。 */
  async function replaceTranscript() {
    const file = replaceRef.current?.files?.[0];
    const action = actionOf("meeting.replace_transcript");
    if (!file || !action) {
      setUploadError("请选择要替换成的 Transcript 文件。");
      return;
    }
    let transcript: unknown;
    try {
      transcript = JSON.parse(await file.text());
    } catch {
      setUploadError("Transcript 不是合法 JSON");
      return;
    }
    setUploadError(null);
    void run(action, { transcript, confirmReplace: true });
  }

  return (
    <section className={s.workspace} data-testid="meeting-workspace" aria-labelledby="meeting-title">
      <header className={s.header}>
        <span>
          {payload.status === "scheduled" ? "会前预审" : payload.status === "cancelled" ? "已取消" : "会议材料"} ·{" "}
          {payload.scheduledAt.slice(0, 16).replace("T", " ")}
        </span>
        <h1 id="meeting-title">{card.title}</h1>
        <button type="button" className={s.close} onClick={() => onNavigate("/")} aria-label="返回首页">
          <X size={20} aria-hidden="true" />
        </button>
      </header>

      <div className={s.materials}>
        {payload.status === "scheduled" ? (
          <section className={s.brief}>
            <div className={s.briefLead}>
              <div>
                <small>会议定位</small>
                <p>{payload.preflight.brief || "预审尚未产出会议简报。"}</p>
              </div>
              <div>
                <small>预审依据</small>
                <p>{payload.preflight.basis || "等待预审完成。"}</p>
              </div>
            </div>
            {payload.preflight.error ? (
              <p className={s.error} role="alert">
                {payload.preflight.error.code}：{payload.preflight.error.message}
                {actionOf("meeting.retry_preflight") ? (
                  <button type="button" disabled={pending} onClick={() => void run(actionOf("meeting.retry_preflight")!, {})}>
                    重试预审
                  </button>
                ) : null}
              </p>
            ) : null}

            <div className={s.issueList}>
              {payload.issueIds.map((issueId) => {
                const issue = issueById.get(issueId);
                const read = payload.draft.readIssueIds.includes(issueId);
                const carried = payload.draft.carriedIssueIds.includes(issueId);
                return (
                  <article key={issueId} className={s.issueCard} data-read={read}>
                    <div className={s.issueTop}>
                      <div>
                        <small>{issue ? (issue.payload as IssuePayload).location.level : "Issue"}</small>
                        <h2>{issue?.title ?? issueId}</h2>
                      </div>
                    </div>
                    <div className={s.briefActions}>
                      <button type="button" aria-pressed={read} disabled={pending} onClick={() => toggle("readIssueIds", issueId)}>
                        <Check size={12} aria-hidden="true" />
                        已阅
                      </button>
                      <button type="button" aria-pressed={carried} disabled={pending} onClick={() => toggle("carriedIssueIds", issueId)}>
                        带到会议
                      </button>
                      <button type="button" onClick={() => onNavigate(`/issues/${issueId}`)}>
                        打开 Issue
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>

            <div className={s.reviewSection}>
              <header>
                <h3>预审条目</h3>
                <span>{payload.preflight.entries.length} 条</span>
              </header>
              {payload.preflight.entries.map((entry) => {
                const checked = payload.draft.checkedEntryIds.includes(entry.id);
                return (
                  <div key={entry.id} className={s.quoteItem}>
                    <p>
                      <strong>{entry.title}</strong>
                    </p>
                    <blockquote>
                      <p>{entry.body}</p>
                    </blockquote>
                    <div className={s.briefActions}>
                      <button type="button" aria-pressed={checked} disabled={pending} onClick={() => toggle("checkedEntryIds", entry.id)}>
                        {checked ? "已核对" : "标记已核对"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSupplementEntry(entry.id);
                          setSupplementText(`请补充「${entry.title}」的证据`);
                        }}
                      >
                        请求补充材料
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className={s.reviewSection}>
              <header>
                <h3>请求补充材料</h3>
                <span>{payload.draft.supplementRequests.length} 条已记录</span>
              </header>
              <label className={s.summaryEdit}>
                <span>目标 DRI</span>
                <select value={supplementTarget} onChange={(event) => setSupplementTarget(event.target.value)} aria-label="目标 DRI">
                  {dri.map((person) => (
                    <option key={person.personId} value={person.personId}>
                      {person.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className={s.summaryEdit}>
                <span>补充内容</span>
                <textarea value={supplementText} onChange={(event) => setSupplementText(event.target.value)} rows={2} />
              </label>
              <div className={s.stageActions}>
                <button
                  type="button"
                  disabled={pending || !supplementText.trim()}
                  onClick={() =>
                    void run(actionOf("meeting.request_supplement")!, {
                      targetDriId: supplementTarget,
                      text: supplementText.trim(),
                      ...(supplementEntry ? { entryId: supplementEntry } : {}),
                    })
                  }
                >
                  记录请求
                </button>
              </div>
              {payload.draft.supplementRequests.length ? (
                <ul className={s.warnings}>
                  {payload.draft.supplementRequests.map((request) => (
                    <li key={request.id}>
                      {EXPORT_LABEL[request.exportStatus] ?? request.exportStatus} · {request.text}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className={s.publishReceipt}>没有真实渠道回执时只记录为待外发，不显示已送达。</p>
            </div>

            <div className={s.reviewSection}>
              <header>
                <h3>备注</h3>
              </header>
              <label className={s.summaryEdit}>
                <span>会前备注</span>
                <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} />
              </label>
              <div className={s.stageActions}>
                <button type="button" disabled={pending} onClick={() => void run(actionOf("meeting.update_draft")!, { note })}>
                  保存准备状态
                </button>
                <label className={s.summaryEdit}>
                  <input type="checkbox" checked={cancelArmed} onChange={(event) => setCancelArmed(event.target.checked)} /> 我确认取消这场尚未召开的会议
                </label>
                <button type="button" disabled={pending || !cancelArmed} onClick={() => void run(actionOf("meeting.cancel")!, {})}>
                  取消会议
                </button>
              </div>
            </div>

            <div className={s.reviewSection}>
              <header>
                <h3>导入 Transcript</h3>
                <span>warmap-transcript.v1</span>
              </header>
              <input ref={uploadRef} type="file" accept="application/json,.json" aria-label="选择 Transcript 文件" />
              <div className={s.stageActions}>
                <button type="button" disabled={uploading} onClick={() => void uploadTranscript()}>
                  <FileUp size={14} aria-hidden="true" />
                  {uploading ? "上传中…" : "导入 Transcript"}
                </button>
              </div>
              <p className={s.publishReceipt}>任一条不合规则整份拒绝，不保存部分 turns。</p>
            </div>
            <ActionFeedback state={state} onRetry={retry} />
          </section>
        ) : (
          <section className={s.review}>
            <div className={s.summaryEdit}>
              <span>Transcript</span>
              <p>
                {payload.transcript ? `${payload.transcript.turns.length} 条发言已保存` : "尚未导入 Transcript"}
              </p>
            </div>
            {payload.outcome ? (
              <>
                <div className={s.summaryEdit}>
                  <span>会后抽取摘要</span>
                  <p>{payload.outcome.summary || "抽取尚未产出摘要。"}</p>
                </div>
                {payload.outcome.error ? (
                  <p className={s.error} role="alert">
                    {payload.outcome.error.code}：{payload.outcome.error.message}
                    {actionOf("meeting.retry_outcome") ? (
                      <button type="button" disabled={pending} onClick={() => void run(actionOf("meeting.retry_outcome")!, {})}>
                        重试会后抽取
                      </button>
                    ) : null}
                  </p>
                ) : null}
                <div className={s.reviewSection}>
                  <header>
                    <h3>逐项处理</h3>
                    <span>{payload.outcome.items.length} 条</span>
                  </header>
                  {payload.outcome.items.map((item) => (
                    <div key={item.id} className={s.decisionRecord}>
                      <p>
                        <strong>{ITEM_LABEL[item.kind] ?? item.kind}</strong> · {item.text}
                      </p>
                      <blockquote>
                        <p>{item.quote}</p>
                      </blockquote>
                      <div className={s.decisionFields}>
                        <div>
                          <small>发言人</small>
                          <p>{people.get(item.speakerId) ?? item.speakerId}</p>
                        </div>
                        <div>
                          <small>处理状态</small>
                          <p>
                            {item.review?.status === "confirmed"
                              ? `已确认${item.review.handoff ? ` · ${EXPORT_LABEL[item.review.handoff.exportStatus] ?? item.review.handoff.exportStatus}` : ""}`
                              : item.review?.status === "dismissed"
                                ? "已忽略"
                                : item.kind === "open"
                                  ? "仅展示，不产生效果"
                                  : "待处理"}
                          </p>
                        </div>
                      </div>
                      <div className={s.briefActions}>
                        {itemAction("meeting.confirm_item", item.id) ? (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => void run(itemAction("meeting.confirm_item", item.id)!, {})}
                          >
                            确认
                          </button>
                        ) : null}
                        {itemAction("meeting.dismiss_item", item.id) ? (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => void run(itemAction("meeting.dismiss_item", item.id)!, {})}
                          >
                            忽略
                          </button>
                        ) : null}
                        {itemAction("meeting.revoke_effect", item.id) ? (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => void run(itemAction("meeting.revoke_effect", item.id)!, {})}
                          >
                            撤回
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className={s.empty}>Transcript 已保存，会后抽取尚未开始。</p>
            )}

            {actionOf("meeting.replace_transcript") ? (
              <div className={s.reviewSection}>
                <header>
                  <h3>替换 Transcript</h3>
                  <span>危险操作</span>
                </header>
                <p className={s.warnings}>
                  替换会整体使旧 Outcome candidate 与 actionId 失效并重跑抽取；只有没有任何 confirmed effect 时才允许。
                </p>
                <input ref={replaceRef} type="file" accept="application/json,.json" aria-label="选择替换用的 Transcript 文件" />
                <label className={s.summaryEdit}>
                  <input type="checkbox" checked={replaceArmed} onChange={(event) => setReplaceArmed(event.target.checked)} />
                  我确认整份替换当前 Transcript
                </label>
                <div className={s.stageActions}>
                  <button type="button" disabled={pending || !replaceArmed} onClick={() => void replaceTranscript()}>
                    替换 Transcript
                  </button>
                </div>
              </div>
            ) : null}
            <ActionFeedback state={state} onRetry={retry} />
          </section>
        )}

        {uploadError ? (
          <p className={s.error} role="alert">
            {uploadError}
          </p>
        ) : null}
        <p className={s.publishReceipt}>
          参与人：{payload.participants.map((person) => person.displayName).join("、")} · 关联 Issue {payload.issueIds.length} 个
        </p>
      </div>
    </section>
  );
}
