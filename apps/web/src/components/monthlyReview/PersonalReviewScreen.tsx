"use client";

/**
 * 个人复盘页（spec personal-review §2–§3）：左边是本人这个月的 Mission（对照基准）和四部分复盘，右边是本人和自己 Agent 的对话（上传材料用）。
 * Co-Agent 按 Mission 卡、每周复盘、采集记录和上传的材料生成，每句话带出处标记；本人逐段修改（编辑框里出处显示成〔名称〕），
 * 重新生成时保留本人改过的段落。本人也可以让自己的 AI 工具经天枢 MCP 补充改写。提交只能本人在这里点。
 * CEO 只读，对没交的人可以「不等了，继续」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { TMonthlyReviewField, TPersonalReviewPayload } from "@warmap/contracts";
import { browserApi, type Card } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useConfirm } from "@/components/ConfirmDialog";
import { FIELD_HINTS, FIELD_LABELS, FIELDS, OPTIONAL_FIELDS, monthOf, requestError, ReviewActionError, type ReviewAction } from "./reviewApi";
import { REVIEW_INSTRUCTION, openConnectionDialog, personalStatusText, runPersonalReviewAction } from "./personalReviewApi";
import { FeedbackLink } from "./FeedbackLink";
import { Sources } from "./Sources";
import { fromEditable, inlineSources, toEditable } from "./citationText";
import { CITATION_MARKDOWN } from "@/conversation/citations";
import { remarkCitationMarks } from "@/conversation/citationMarks";
import s from "@/components/missionCards/mission-card.module.css";
import r from "./monthly-review.module.css";

type Drafts = Partial<Record<TMonthlyReviewField, string>>;
const NO_CARDS: Card[] = [];
const REMARK_PLUGINS = [remarkCitationMarks];

/** 一栏正文：每行一段，句末出处显示成小标记。 */
function ReviewText({ text }: { text: string }) {
  return <div className={r.reviewText}><ReactMarkdown remarkPlugins={REMARK_PLUGINS} {...CITATION_MARKDOWN}>{text.replace(/\n+/g, "\n\n")}</ReactMarkdown></div>;
}

/** 生成的步骤：读 Mission 卡 → 读每周复盘 → 读采集记录 → 起草。 */
function GenerationSteps({ steps }: { steps: TPersonalReviewPayload["generationSteps"] }) {
  return <ol className={r.steps}>
    {steps.map((step) => <li key={step.id} data-state={step.status}>
      <span className={r.stepMark} aria-hidden>{step.status === "running" ? <Loader2 size={12} /> : step.status === "done" ? <Check size={12} /> : step.status === "failed" ? <X size={12} /> : null}</span>
      <span>{step.label}{step.result ? <small>{step.result}</small> : null}</span>
    </li>)}
  </ol>;
}
const SOURCE_TEXT = { agent_tool: "你的 AI 工具", co_agent: "Co-Agent", manual: "手写" } as const;

function tone(status: TPersonalReviewPayload["status"]): "wait" | "warn" | "done" | undefined {
  if (status === "submitted") return "done";
  if (status === "draft_failed") return "warn";
  if (status === "drafting" || status === "waiting") return "wait";
  return undefined;
}

export function PersonalReviewScreen({ initialReview }: { initialReview: TPersonalReviewPayload }) {
  const workspace = useWorkspace();
  const router = useRouter();
  const [review, setReview] = useState(initialReview);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState(false);
  const inFlight = useRef(false);
  const { ask, dialog } = useConfirm();

  const month = monthOf(review.period);
  const { isSelf, isCeo } = review.viewer;
  const title = isSelf ? `我的 ${month} 月复盘` : `${review.personName} · ${month} 月复盘`;
  const action = useCallback((type: string): ReviewAction | undefined => review.actions.find((candidate) => candidate.actionType === type), [review.actions]);
  const editable = Boolean(action("personal-review.update"));
  const savedText = (field: TMonthlyReviewField) => review.selfReview?.[field].text ?? "";
  const draftText = (field: TMonthlyReviewField) => drafts[field] === undefined ? undefined : fromEditable(drafts[field], savedText(field));
  const dirtyFields = FIELDS.filter((field) => drafts[field] !== undefined && draftText(field) !== savedText(field));

  // 对话只给本人（上传材料、和自己的 Agent 聊）；CEO 看别人的复盘时右边是自己的全局对话。
  useRegisterDetail(useMemo(() => ({ scope: isSelf ? review.conversationScope : "global", label: title, mark: "monthly" as const, cards: NO_CARDS }), [isSelf, review.conversationScope, title]));

  const accept = useCallback((next: TPersonalReviewPayload) => setReview((current) => next.version < current.version ? current : next), []);
  const refresh = useCallback(async () => {
    try {
      const { data, response } = await browserApi.GET("/api/personal-reviews/{personalReviewId}", { params: { path: { personalReviewId: review.personalReviewId } } });
      if (response.status === 401) { router.push("/access"); return; }
      if (data?.review) accept(data.review);
    } catch { /* 下一次轮询或操作时再取 */ }
  }, [review.personalReviewId, router, accept]);

  // Co-Agent 起草时每 3 秒读一次；等 AI 工具写草稿时每 15 秒读一次；上传了材料、回到前台时立刻读。
  useEffect(() => {
    if (review.status === "submitted" || review.status === "skipped") return;
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, review.status === "drafting" || review.status === "waiting" ? 3_000 : 15_000);
    return () => window.clearInterval(timer);
  }, [review.status, refresh]);
  useEffect(() => {
    const uploaded = (event: Event) => { if ((event as CustomEvent<{ scope: string }>).detail?.scope === review.conversationScope) void refresh(); };
    window.addEventListener("conversation-attachments-changed", uploaded);
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("conversation-attachments-changed", uploaded); window.removeEventListener("focus", refresh); };
  }, [review.conversationScope, refresh]);

  const perform = async (descriptor: ReviewAction | undefined, input?: unknown, done?: string) => {
    if (!descriptor || inFlight.current) return false;
    inFlight.current = true;
    setPending(true); setError(""); setFieldErrors({}); setNotice("");
    try {
      const result = await runPersonalReviewAction(descriptor, input);
      accept(result.review);
      if (done) setNotice(done);
      router.refresh();
      return true;
    } catch (cause) {
      setError(requestError(cause, "暂时无法连接服务器，请稍后重试；输入已保留。"));
      if (cause instanceof ReviewActionError) {
        if (cause.fieldErrors) setFieldErrors(cause.fieldErrors);
        if (cause.status === 409) await refresh();
      }
      return false;
    } finally { inFlight.current = false; setPending(false); }
  };

  const save = async (then?: string) => {
    if (!dirtyFields.length) return true;
    const ok = await perform(action("personal-review.update"), { fields: dirtyFields.map((field) => ({ field, text: draftText(field) ?? "" })) }, then);
    if (ok) setDrafts({});
    return ok;
  };
  const submit = async () => {
    if (dirtyFields.length && !(await save())) return;
    // 保存后 actions 换了新版本：从最新的视图里取提交动作。
    const latest = await browserApi.GET("/api/personal-reviews/{personalReviewId}", { params: { path: { personalReviewId: review.personalReviewId } } }).then(({ data }) => data?.review).catch(() => undefined);
    if (latest) accept(latest);
    await perform((latest ?? review).actions.find((candidate) => candidate.actionType === "personal-review.submit"), undefined, "已提交。名单上你的名字会变成已提交。");
  };
  // 先存下没保存的修改（存过的段落重新生成时保留），再从最新视图里取生成动作。
  const generate = async () => {
    const unsaved = dirtyFields.length > 0;
    if (unsaved && !(await save())) return;
    const latest = unsaved ? await browserApi.GET("/api/personal-reviews/{personalReviewId}", { params: { path: { personalReviewId: review.personalReviewId } } }).then(({ data }) => data?.review).catch(() => undefined) : review;
    if (unsaved && latest) accept(latest);
    if (await perform((latest ?? review).actions.find((candidate) => candidate.actionType === "personal-review.draft_with_co_agent"))) setDrafts({});
  };
  const skip = async () => {
    if (!(await ask(`不等 ${review.personName} 了，继续？跳过会记在名单上，大家都看得到。`, "不等了，继续"))) return;
    await perform(action("personal-review.skip"), undefined, "已跳过。");
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(REVIEW_INSTRUCTION); setCopied(true); }
    catch { setError("复制失败，请手动选中下面的文字复制。"); }
  };

  const generateAction = action("personal-review.draft_with_co_agent");
  const submitAction = action("personal-review.submit");
  const skipAction = action("personal-review.skip");
  const open = review.status !== "submitted" && review.status !== "skipped";

  return <div className={s.screen}>
    <DetailFrame title={title} subtitle={`个人月度复盘 · 对照自己的 ${month} 月 Mission Card${review.draftSource === "import" ? " · 从飞书导入" : review.draftSource ? ` · 草稿：${SOURCE_TEXT[review.draftSource]}` : ""}`} onBack={() => workspace.close()}
      actions={<div className={r.headerActions}>
        {generateAction ? <Button variant="ghost" className={r.generate} aria-label={generateAction.label} isDisabled={pending} onPress={() => void generate()}><Sparkles size={15} aria-hidden /><span className={r.generateLabel}>{generateAction.label}</span></Button> : null}
        <span className={r.chip} data-tone={tone(review.status)}>{personalStatusText(review.status, isSelf)}</span>
      </div>}>
      <div className={s.content}>
        <div className={s.document}>
          {error || notice ? <div className={r.messages}>
            {error ? <p className={s.error} role="alert">{error}</p> : null}
            {notice ? <p className={s.notice} role="status">{notice}</p> : null}
          </div> : null}

          <section className={r.goal} aria-label={`${month} 月 Mission`}>
            <h2>{month} 月 Mission</h2>
            {review.missions.length ? <ol className={r.missions}>
              {review.missions.map((mission) => <li key={mission.id}><strong>{mission.code} {mission.title}</strong><p>{mission.outcome}</p></li>)}
            </ol> : <p className={r.muted}>这个月没有登记 Mission，按实际推进情况复盘。</p>}
          </section>

          {isSelf && open && review.status !== "drafting" && review.status !== "waiting" ? <section className={r.section} aria-label="想改得更好">
            <h2>{review.selfReview ? "想改得更好" : "起草没有成功，换一种方式"}</h2>
            <div className={r.paths}>
              <div className={r.path}>
                <h3>让你的 AI 工具补充改写</h3>
                {review.toolConnected ? <>
                  <p>你已把 AI 工具连上天枢。把这句话发给它，它会读你的 Mission、进展、现在的草稿和你手边的周复盘，改写后存回这里：</p>
                  <blockquote className={r.instruction}>{REVIEW_INSTRUCTION}</blockquote>
                  <div className={s.inlineActions}><Button variant="primary" className={s.primary} onPress={() => void copy()}>{copied ? "已复制" : "复制指令"}</Button></div>
                </> : <>
                  <p>还没连。授权后，你的 Codex、Claude Code 等就能读你手边的材料帮你补充改写。</p>
                  <div className={s.inlineActions}><Button variant="primary" className={s.primary} onPress={openConnectionDialog}>授权开始</Button></div>
                </>}
              </div>
            </div>
          </section> : null}

          {review.status === "drafting" || review.status === "waiting" ? <div className={`${r.working} ${r.generating}`} role="status">
            {review.generationSteps.length ? <GenerationSteps steps={review.generationSteps} /> : <><span className={r.pulse} aria-hidden />Co-Agent 正在生成…</>}
          </div> : null}
          {review.status === "draft_failed" ? <p className={s.error} role="alert">生成没有成功{review.draftError ? `：${review.draftError.message}` : ""}。</p> : null}
          {isSelf && review.generationSteps.length > 0 && review.status !== "drafting" && review.status !== "waiting" ? <details className={r.process}>
            <summary>生成过程 · {review.generationSteps.length} 步</summary>
            <GenerationSteps steps={review.generationSteps} />
          </details> : null}
          {review.status === "skipped" && review.skipped ? <p className={r.muted} role="note">{review.skipped.byName} 在 {monthDayTime(review.skipped.at)} 选择不再等这份复盘。</p> : null}

          {editable || review.selfReview ? <dl className={s.fields} aria-label="复盘">
            {FIELDS.map((field) => {
              const saved = review.selfReview?.[field] ?? { text: "", sources: [] };
              // 有正文时先看带出处标记的正文，点「修改」才变成编辑框；空栏直接编辑。
              const editing = editable && (drafts[field] !== undefined || !saved.text);
              const value = drafts[field] ?? toEditable(saved.text);
              const dirty = drafts[field] !== undefined && draftText(field) !== saved.text;
              const shown = inlineSources(saved.text);
              return <div key={field} className={s.field} data-changed={dirty ? "" : undefined}>
                <dt>
                  <label htmlFor={`personal-${field}`}>{FIELD_LABELS[field]}</label>
                  {isSelf && review.editedFields.includes(field) ? <span className={r.edited}>你改过</span> : null}
                </dt>
                {editable && saved.text ? <div className={s.fieldActions}>
                  {drafts[field] === undefined
                    ? <Button variant="ghost" className={s.textAction} aria-label={`修改：${FIELD_LABELS[field]}`} isDisabled={pending} onPress={() => setDrafts((current) => ({ ...current, [field]: toEditable(saved.text) }))}>修改</Button>
                    : <Button variant="ghost" className={s.textAction} aria-label={`不改了：${FIELD_LABELS[field]}`} isDisabled={pending} onPress={() => setDrafts(({ [field]: _discarded, ...rest }) => rest)}>不改了</Button>}
                </div> : null}
                <dd>
                  {editing
                    ? <textarea id={`personal-${field}`} className={r.editor} value={value} rows={Math.min(14, Math.max(3, value.split("\n").length + Math.ceil(value.length / 48)))} maxLength={4000} disabled={pending}
                        data-dirty={dirty ? "" : undefined}
                        aria-invalid={fieldErrors[field] ? true : undefined} aria-describedby={fieldErrors[field] ? `personal-${field}-error` : undefined}
                        placeholder={FIELD_HINTS[field]} onChange={(event) => setDrafts((current) => ({ ...current, [field]: event.target.value }))} />
                    : <div id={`personal-${field}`}>{saved.text ? <ReviewText text={saved.text} /> : <p className={s.missing}>{OPTIONAL_FIELDS.includes(field) ? "无" : "未填写"}</p>}</div>}
                  {fieldErrors[field] ? <p id={`personal-${field}-error`} className={s.proposalError}>这一栏还没写，提交前要写上</p> : null}
                  <Sources sources={saved.sources.filter((source) => !shown.has(source))} />
                </dd>
              </div>;
            })}
          </dl> : null}

          {editable ? <div className={r.bar}>
            <p className={`${s.hint} ${r.hint}`}>提交后大家会在名单上看到你已提交，看不到你写的内容；CEO 和你所在战场的负责人会在战场复盘里用到它。</p>
            {dirtyFields.length ? <Button variant="ghost" className={s.secondary} isDisabled={pending} onPress={() => void save("已保存。")}>保存</Button> : null}
            {submitAction || dirtyFields.length ? <Button variant="primary" className={s.primary} isDisabled={pending || (!submitAction && !dirtyFields.length)} onPress={() => void submit()}>{pending ? "正在提交…" : "提交复盘"}</Button> : null}
          </div> : null}

          {isCeo && skipAction ? <div className={r.bar}>
            <p className={`${s.hint} ${r.hint}`}>{review.personName} 还没提交。不想再等，可以跳过这份，流程继续往下走。</p>
            <Button variant="ghost" className={s.secondary} isDisabled={pending} onPress={() => void skip()}>不等了，继续</Button>
          </div> : null}
          <FeedbackLink />
        </div>
      </div>
    </DetailFrame>
    {dialog}
  </div>;
}
