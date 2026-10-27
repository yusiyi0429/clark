"use client";

import { useEffect, useRef, useState } from "react";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import c from "./task-quality.module.css";

type Review = components["schemas"]["TaskQualityReviewView"];
type Proposal = components["schemas"]["TaskRepairView"];
type Handoff = components["schemas"]["TaskRepairHandoff"];
type Analysis = components["schemas"]["TaskMeetingAnalysis"];
type Catalog = components["schemas"]["TaskQualityCatalog"];
type Input = components["schemas"]["TaskRepairInput"];
const STATES: Record<Proposal["state"], string> = { needs_input: "待补信息", pending_decision: "待定案", needs_source: "待确认依据",
  ready: "待确认字段", handed_off: "已交个人端，待核对回执", blocked: "需复核", verified: "字段已核对", superseded: "已被新版本接替" };
const RESULTS: Record<string, string> = { written_verified: "已写入并读回", written_awaiting_governance: "已写入，待治理确认",
  written_unconfirmed_state: "已记录未确认状态", already_present: "当前已包含，无重复写入", committed_unverified: "已提交，读回尚未核实",
  written_source_superseded: "已写入，但来源已更正或撤回", written_but_superseded: "曾写入，当前内容已有更新" };

function dataOf<T>(result: { data?: T; error?: { message: string }; response: Response }): T {
  if (!result.response.ok || result.data === undefined) throw new Error(result.error?.message ?? "请求未完成，请重试。");
  return result.data;
}
const display = (value: Proposal["before"]): string => value === null ? "未填写" : Array.isArray(value) ? value.join("\n") || "未填写" : value || "未填写";
const localInput = (value: string | null): string => {
  if (value === null) return "";
  const time = new Date(value);
  return new Date(time.getTime() - time.getTimezoneOffset() * 60000).toISOString().slice(0, -1);
};

export function TaskQualityWorkbench({ viewerRole, meetingId }: { viewerRole: "ceo" | "member"; meetingId?: string }) {
  const [catalog, setCatalog] = useState<Catalog>({ items: [], nextCursor: null });
  const [reviews, setReviews] = useState<Review[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [handoffs, setHandoffs] = useState<Record<string, Handoff>>({});
  const [taskId, setTaskId] = useState("");
  const [cadence, setCadence] = useState("saved");
  const [fieldKey, setFieldKey] = useState("");
  const [value, setValue] = useState("");
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [quote, setQuote] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [classification, setClassification] = useState<Input["classification"]>("fact");
  const [sectionId, setSectionId] = useState("");
  const [revising, setRevising] = useState<Proposal | null>(null);
  const [receipts, setReceipts] = useState<Record<string, string>>({});
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const submission = useRef<{ intent: string; id: string } | null>(null);
  const review = reviews.find(item => item.taskId === taskId);
  const field = review?.report.quality.fields.find(item => item.key === fieldKey);
  const visible = proposals.filter(item => (!meetingId || item.source.meetingId === meetingId) && (showHistory || item.state !== "superseded"));
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null); setNotice(null);
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "请求未完成，请重试。"); }
    finally { setBusy(false); }
  };
  const reload = async () => {
    const [saved, drafts] = await Promise.all([browserApi.GET("/api/task-quality"), browserApi.GET("/api/task-quality/proposals")]);
    setReviews(dataOf(saved).reviews); setProposals(dataOf(drafts).proposals);
  };
  useEffect(() => { void run(async () => {
    const [options] = await Promise.all([browserApi.GET("/api/task-quality/catalog"), reload()]);
    setCatalog(dataOf(options));
  }); }, []);
  const check = () => run(async () => {
    const updated = dataOf(await browserApi.POST("/api/task-quality/tasks/{taskId}/check", { params: { path: { taskId } },
      body: cadence === "saved" ? {} : { maxAgeHours: cadence === "unset" ? null : Number(cadence) } }));
    setReviews(current => [updated, ...current.filter(item => item.taskId !== taskId)]);
    setFieldKey(current => updated.report.quality.fields.some(item => item.key === current) ? current : updated.report.quality.fields[0]?.key ?? "");
  });
  const handoff = async (proposalId: string): Promise<Handoff> => {
    const result = dataOf(await browserApi.GET("/api/task-quality/proposals/{proposalId}/handoff", { params: { path: { proposalId } } }));
    setHandoffs(current => ({ ...current, [proposalId]: result }));
    await reload();
    return result;
  };
  const save = () => run(async () => {
    if (!field) throw new Error("请先核对任务并选择字段。");
    const content = { fieldKey, classification, quote,
      occurredAt: occurredAt ? new Date(occurredAt).toISOString() : null,
      value: field.kind === "dependencies" ? dependencies : field.kind === "links" ? value.split("\n").map(item => item.trim()).filter(Boolean)
        : field.kind === "date" && !value ? null : value };
    const intent = JSON.stringify({ taskId, meetingId, sectionId, revising: revising?.id, content });
    if (submission.current?.intent !== intent) submission.current = { intent, id: crypto.randomUUID() };
    const input: Input = { ...content, clientRequestId: submission.current.id };
    if (revising) dataOf(await browserApi.POST("/api/task-quality/proposals/{proposalId}/revise", {
      params: { path: { proposalId: revising.id } }, body: { taskId, input } }));
    else if (meetingId) dataOf(await browserApi.POST("/api/task-quality/meetings/{meetingId}/proposals", {
      params: { path: { meetingId } }, body: { taskId, sectionId, input } }));
    else dataOf(await browserApi.POST("/api/task-quality/tasks/{taskId}/proposals", { params: { path: { taskId } }, body: input }));
    await reload(); setRevising(null); setFieldKey(""); setValue(""); setQuote(""); setNotice("已保存本人补齐草稿，尚未写入 world。");
  });
  return <section className={c.workbench} aria-label="任务数据质量">
    <header><h2>任务数据质量</h2><p>以 world 当前内容核对缺口，逐项保留依据、差异与回执。检查结果只供核对，正式完成仍按治理流程确认。</p></header>
    {error && <p role="alert" className={c.error}>{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className={c.controls}>
      <label>核对的任务<select value={taskId} disabled={busy} onChange={e => { setTaskId(e.target.value); setFieldKey(""); }}>
        <option value="">请选择已有任务</option>{catalog.items.map(item => <option key={item.taskId} value={item.taskId}>{item.title} · {item.status}</option>)}
      </select></label>
      {catalog.nextCursor && <button disabled={busy} onClick={() => void run(async () => {
        const next = dataOf(await browserApi.GET("/api/task-quality/catalog", { params: { query: { cursor: catalog.nextCursor! } } }));
        setCatalog(current => ({ items: [...current.items, ...next.items.filter(item => !current.items.some(prior => prior.taskId === item.taskId))], nextCursor: next.nextCursor }));
      })}>更多任务</button>}
      <label>执行状态核对周期<select value={cadence} disabled={busy} onChange={e => setCadence(e.target.value)}>
        <option value="saved">沿用本人上次设置</option><option value="unset">暂不设周期</option><option value="24">一天</option><option value="72">三天</option><option value="168">七天</option>
      </select></label><button disabled={busy || !taskId} onClick={() => void check()}>现在核对</button>
    </div>
    {review && <section className={c.card}><h3>{review.title}</h3>
      <p>上次核对：{new Date(review.checkedAt).toLocaleString()} · 周期：{review.report.quality.policy.max_age_hours === null ? "未设置" : `${review.report.quality.policy.max_age_hours} 小时`}</p>
      <p>{review.report.quality.meaning}</p>
      {review.report.quality.findings.length ? <ul>{review.report.quality.findings.map(item => <li key={item.id}>
        <strong>{item.message}</strong><span> · 处理职责：{item.handler.role}{item.handler.principal_id ? `（${item.handler.principal_id}）` : "，人员待核对"}</span>
        <details><summary>查看依据与位置</summary><p>{item.path}</p><p>{item.evidence_refs.join("、") || "尚无来源依据"}</p></details>
      </li>)}</ul> : <p>本轮规则未发现待核对项；这不代表业务验收已经完成。</p>}
    </section>}
    {meetingId && <section className={c.card}><h3>会议结论归位</h3><p>本次分析选定任务；没有对应任务或字段的结论会保留待核对。会议确认版和全文来源需一致。</p>
      <button disabled={busy} onClick={() => void run(async () => {
        setAnalysis(dataOf(await browserApi.POST("/api/task-quality/meetings/{meetingId}/analyze", { params: { path: { meetingId } }, body: { taskIds: taskId ? [taskId] : [] } })));
        await reload();
      })}>分析当前确认版</button>
      {analysis && <><p>确认版 {analysis.revision} · 已逐段登记 {analysis.coverage.length} 段</p>
        {analysis.coverage.map(item => <details key={item.sectionId}><summary>{item.heading} · {item.disposition === "no_task_change" ? "未识别到任务改动" : item.disposition === "needs_clarification" ? "待人工核对" : "已生成候选"}</summary>
          <p>{item.reason}</p><blockquote>{item.body}</blockquote><button disabled={busy || !taskId} onClick={() => { setSectionId(item.sectionId); setQuote(item.body); setRevising(null); }}>以这段为依据手动补齐</button>
        </details>)}</>}
    </section>}
    {review && <form className={c.card} onSubmit={e => { e.preventDefault(); void save(); }}>
      <h3>{revising ? "补充这项草稿" : "新增一项补齐草稿"}</h3>
      <label>具体字段<select required value={fieldKey} disabled={busy} onChange={e => { setFieldKey(e.target.value); setValue(""); }}>
        <option value="">请选择</option>{review.report.quality.fields.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
      </select></label>
      {field && <p>当前值：{display(field.value)}</p>}
      {field?.kind === "dependencies" ? <label>新增依赖任务<select multiple value={dependencies} disabled={busy} onChange={e => setDependencies([...e.target.selectedOptions].map(item => item.value))}>
        {catalog.items.filter(item => item.taskId !== taskId).map(item => <option key={item.taskId} value={item.taskId}>{item.title}</option>)}
      </select></label> : <label>拟值{field?.kind === "date" ? <input type="date" value={value} disabled={busy} onChange={e => setValue(e.target.value)} />
        : <textarea required={field?.kind === "text"} placeholder={field?.kind === "links" ? "每行一个资料链接" : "填写拟补充的内容"} value={value} disabled={busy} onChange={e => setValue(e.target.value)} />}</label>}
      <label>性质<select value={classification} disabled={busy} onChange={e => setClassification(e.target.value as Input["classification"])}>
        <option value="fact">事实</option><option value="decision">已作决定</option><option value="suggestion">建议</option><option value="question">待决问题</option>
      </select></label>
      {meetingId && !revising && <label>确认段落<select required value={sectionId} onChange={e => setSectionId(e.target.value)}><option value="">先分析并选择依据段落</option>
        {analysis?.coverage.map(item => <option key={item.sectionId} value={item.sectionId}>{item.heading}</option>)}
      </select></label>}
      <label>原文依据<textarea required value={quote} disabled={busy || !!revising} onChange={e => setQuote(e.target.value)} /></label>
      {(revising ? revising.source.kind !== "meeting" : !meetingId) && <label>事实发生或明确重新核对的时间（未知可留空）<input type="datetime-local" step="any" value={occurredAt} disabled={busy} onChange={e => setOccurredAt(e.target.value)} /></label>}
      <button disabled={busy || !field}>保存本人草稿</button>{revising && <button type="button" disabled={busy} onClick={() => setRevising(null)}>取消补充</button>}
    </form>}
    <section><div className={c.controls}><h3>本人补齐记录</h3><button disabled={busy} onClick={() => void run(reload)}>刷新记录</button>
      <label><input type="checkbox" checked={showHistory} onChange={e => setShowHistory(e.target.checked)} />显示被接替的历史</label></div>
      {!visible.length && <p>尚无补齐记录。</p>}
      {visible.map(item => <article className={c.card} key={item.id} aria-label={item.fieldLabel ?? "未定位补齐项"}>
        <h4>{item.taskTitle ?? "任务待定位"} · {item.fieldLabel ?? "字段待定位"}</h4><p><strong>{STATES[item.state]}</strong> · {item.classification === "fact" ? "事实" : item.classification === "decision" ? "决定" : item.classification === "suggestion" ? "建议" : "待决问题"}</p>
        <p>{item.message}</p>{item.writebackStatus && <p>world 回读：{RESULTS[item.writebackStatus] ?? item.writebackStatus}</p>}
        <div className={c.diff}><div><strong>改前</strong><pre>{display(item.before)}</pre></div><div><strong>拟改后</strong><pre>{display(item.after)}</pre></div></div>
        <blockquote>{item.source.quote}</blockquote><p>依据：{item.source.title} · {item.source.meetingRevision ? `确认版 ${item.source.meetingRevision}` : item.source.kind === "conversation" ? "本人对话原文" : "本人补充"}
          {item.source.occurredAt ? ` · ${new Date(item.source.occurredAt).toLocaleString()}` : " · 事实时间未知"}</p>
        <p>上次核对：{new Date(item.updatedAt).toLocaleString()}</p>
        <div className={c.controls}>
          {["needs_input", "pending_decision"].includes(item.state) && <button disabled={busy} onClick={() => {
            setRevising(item); if (item.taskId) setTaskId(item.taskId); setFieldKey(item.fieldKey ?? ""); setValue(display(item.after) === "未填写" ? "" : display(item.after));
            setDependencies(item.fieldKey === "depends_on" && Array.isArray(item.after) ? item.after : []);
            setQuote(item.source.quote); setClassification(item.classification); setOccurredAt(localInput(item.source.occurredAt)); setNotice("请在上方选择任务、核对字段并补充信息；时间未知时保留空白。");
          }}>补充定位或待决信息</button>}
          <button disabled={busy} onClick={() => void run(async () => { await handoff(item.id); })}>核对最新执行条件与回执</button>
          {!["verified", "superseded", "needs_input", "pending_decision"].includes(item.state) && <button disabled={busy} onClick={() => void run(async () => {
            const current = await handoff(item.id); if (current.stage === "blocked") throw new Error(current.instruction);
            await navigator.clipboard.writeText(`请用天枢个人 MCP get_task_repair_handoff 读取 proposalId=${item.id}、viewerRole=${viewerRole}。逐项展示来源、当前差异与指纹，取得我的具体确认后再用我已配置的 world 个人客户端执行。不要批量过门。把真实回执用 report_task_repair_receipt 交回并读回核对。`);
            setNotice("已复制给个人 Agent 的指令；尚未执行 world 操作。");
          })}>复制给个人 Agent</button>}
        </div>
        {handoffs[item.id] && <div className={c.handoff}><p>{handoffs[item.id].instruction}</p>
          {handoffs[item.id].stage !== "blocked" && <><button disabled={busy} onClick={() => {
            const content = handoffs[item.id].stage === "change" ? handoffs[item.id].package : handoffs[item.id];
            const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: "application/json" }));
            const link = document.createElement("a"); link.href = url; link.download = `task-repair-${item.id}.json`; link.click(); URL.revokeObjectURL(url);
            setNotice("已下载个人端请求。下载不代表确认或执行。");
          }}>下载个人端请求</button><details><summary>查看本项完整请求</summary><pre>{JSON.stringify(handoffs[item.id], null, 2)}</pre></details></>}
          <label>已执行的回执编号<input value={receipts[item.id] ?? ""} onChange={e => setReceipts(current => ({ ...current, [item.id]: e.target.value }))} /></label>
          <button disabled={busy || !receipts[item.id]?.trim()} onClick={() => void run(async () => {
            dataOf(await browserApi.POST("/api/task-quality/proposals/{proposalId}/receipts", { params: { path: { proposalId: item.id } },
              body: { stage: item.sourceReceiptId ? "change" : "source", receiptId: receipts[item.id].trim() } }));
            await reload(); setNotice("已核对该回执，请查看当前字段及治理状态。");
          })}>核对真实回执</button>
        </div>}
        {(item.sourceReceiptId || item.receiptId) && <details><summary>回执依据</summary><p>来源回执：{item.sourceReceiptId ?? "尚无"}</p><p>字段回执：{item.receiptId ?? "尚无"}</p></details>}
      </article>)}
    </section>
  </section>;
}
