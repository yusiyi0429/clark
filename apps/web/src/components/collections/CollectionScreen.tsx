"use client";

/**
 * ③ 信息收集的一轮（送达通道里 kind = collection 的请求）。同一个二级页两种样子：
 * - 接收人：待办卡。参照 Linear 子任务进度 + Notion 数据库行：顶部「已填 3/4」和「确认完成」，下面就是自己那一行的各栏，
 *   改完离开输入框就保存（同时推到飞书表格）；填齐才能确认，确认后只读。
 * - 发起人：汇总。参照飞书多维表格的表格视图：每人一行、状态一列（未填 / 已填未确认 / 已确认），顶部三段计数；手机上每人一张卡。
 * 卡上问答沿用传话的那一套。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ExternalLink, Repeat } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { TActionDescriptor, TCollectionEntryView, TCollectionField, TCollectionView, TRequestView } from "@warmap/contracts";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { monthDayTime } from "@/lib/companyTime";
import type { Card } from "@/lib/api/client";
import { AskBox, QuestionThread } from "@/components/requests/RequestScreen";
import { readRequest, requestError, runRequestAction } from "@/components/requests/requestApi";
import r from "@/components/requests/requests.module.css";
import { deadlineText, readCollectionRound, runCollectionAction } from "./collectionApi";
import c from "./collections.module.css";

const NO_CARDS: Card[] = [];
const STATUS: Record<TCollectionEntryView["status"], { label: string; tone: "empty" | "filled" | "confirmed" }> = {
  empty: { label: "未填", tone: "empty" }, filled: { label: "已填未确认", tone: "filled" }, confirmed: { label: "已确认", tone: "confirmed" },
};
const initial = (name: string) => name.trim().slice(-1);
const actionOf = (view: TCollectionView | null, type: string) => view?.actions.find((action) => action.actionType === type);

export function CollectionScreen({ request: initialRequest }: { request: TRequestView }) {
  const workspace = useWorkspace();
  const [request, setRequest] = useState(initialRequest);
  const [view, setView] = useState<TCollectionView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useRegisterDetail(useMemo(() => ({ scope: "global", label: request.title, mark: null, cards: NO_CARDS }), [request.title]));

  const load = useCallback(async () => {
    try { setView(await readCollectionRound(request.id)); }
    catch (cause) { setError(requestError(cause, "没有读到这次收集")); }
  }, [request.id]);
  useEffect(() => { void load(); }, [load]);
  // 发起人那边别人在陆续填：回到页面或每 20 秒重读一次。接收人自己在填，不重读免得冲掉输入。
  const isInitiator = view?.viewer.isInitiator ?? false;
  useEffect(() => {
    if (!isInitiator) return;
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, 20_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [isInitiator, load]);

  const perform = async (action: TActionDescriptor | undefined, input?: unknown) => {
    if (!action || busy) return false;
    setBusy(true); setError("");
    try { setRequest(await runRequestAction(action, input)); return true; }
    catch (cause) {
      setError(requestError(cause, "没有成功，请重试"));
      try { setRequest(await readRequest(request.id)); } catch { /* 保留当前 */ }
      return false;
    } finally { setBusy(false); }
  };

  const mine = view && !view.viewer.isInitiator ? view.entries[0] : undefined;
  const chip = mine ? STATUS[mine.status] : view ? (view.counts.confirmed === view.counts.total ? STATUS.confirmed : null) : null;
  return (
    <div className={r.screen}>
      <DetailFrame title={request.title} subtitle={view ? `信息收集 · 截止 ${deadlineText(view.deadlineAt)}` : "信息收集"} onBack={() => workspace.close()}
        actions={view ? (
          <span className={c.headActions}>
            {view.weekly ? <span className={`${r.tag} ${r.headerChip}`} data-tone={view.status === "active" ? "wait" : undefined}><Repeat size={12} aria-hidden="true" />&nbsp;{view.status === "active" ? "每周固定" : "已停用"}</span> : null}
            {chip ? <span className={`${c.status} ${r.headerChip}`} data-tone={chip.tone}>{chip.label}</span> : null}
            {view.table ? <a className={c.feishu} href={view.table.url} target="_blank" rel="noreferrer"><ExternalLink size={15} aria-hidden="true" />飞书表格</a> : null}
          </span>
        ) : undefined}>
        <div className={r.content}>
          <div className={r.stack}>
            {error ? <p className={r.error} role="alert">{error}</p> : null}
            {!view ? <div className={c.placeholder} aria-busy="true" /> : view.viewer.isInitiator
              ? <Summary view={view} />
              : mine ? <MyRow key={mine.personId} view={view} entry={mine} onError={setError} onChange={(next) => {
                setView(next);
                // 确认后这一行就完成了：重读请求，卡上的提问随之收起。
                if (next.entries[0]?.status === "confirmed") void readRequest(request.id).then(setRequest, () => undefined);
              }} /> : null}
            <QuestionThread request={request} busy={busy} perform={perform} />
            {request.actions.some((action) => action.actionType === "request.ask") ? <AskBox request={request} perform={perform} /> : null}
          </div>
        </div>
      </DetailFrame>
    </div>
  );
}

/* ---------- 接收人：自己那一行 ---------- */

function MyRow({ view, entry, onChange, onError }: { view: TCollectionView; entry: TCollectionEntryView; onChange: (next: TCollectionView) => void; onError: (text: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>(entry.values);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const [confirming, setConfirming] = useState(false);
  const saved = useRef(entry.values);
  const save = actionOf(view, "collection.save");
  const confirm = actionOf(view, "collection.confirm");
  const confirmed = entry.status === "confirmed";
  const required = view.fields.filter((field) => field.required);
  const filled = required.filter((field) => values[field.key]?.trim()).length;
  const dirty = view.fields.some((field) => (values[field.key] ?? "").trim() !== (saved.current[field.key] ?? ""));

  const flush = async (): Promise<TCollectionView | null> => {
    if (!save || !dirty) return null;
    setSaving("saving");
    try {
      const next = await runCollectionAction(save, { values });
      saved.current = next.entries[0]?.values ?? values;
      setSaving("saved");
      onChange(next);
      return next;
    } catch (cause) { setSaving("idle"); onError(requestError(cause, "没有保存上，请重试")); return null; }
  };
  const finish = async () => {
    if (filled < required.length || confirming) return;
    setConfirming(true); onError("");
    try {
      const latest = (await flush()) ?? view;
      const action = actionOf(latest, "collection.confirm");
      if (action) onChange(await runCollectionAction(action));
    } catch (cause) { onError(requestError(cause, "没有确认上，请重试")); }
    finally { setConfirming(false); }
  };

  return (
    <>
      <section className={c.progress} data-done={confirmed ? "" : undefined} aria-label="我的进度">
        <div className={c.progressText}>
          {confirmed
            ? <><span className={c.bigCheck} aria-hidden="true"><Check size={16} strokeWidth={3} /></span><strong>已确认</strong><time>{monthDayTime(entry.confirmedAt)}</time></>
            : <><strong className={c.fraction}>已填 {filled}/{required.length}</strong>{saving === "saving" ? <small>保存中</small> : saving === "saved" && !dirty ? <small>已保存</small> : null}</>}
        </div>
        <ol className={c.meter} aria-hidden="true">
          {required.map((field) => <li key={field.key} data-on={values[field.key]?.trim() ? "" : undefined} />)}
        </ol>
        {confirm ? (
          <Button variant="primary" className={`${r.primary} ${c.confirm}`} isDisabled={filled < required.length || confirming} onPress={() => void finish()}>
            <Check size={16} aria-hidden="true" />{confirming ? "确认中" : "确认完成"}
          </Button>
        ) : null}
      </section>
      {entry.draftFrom === "weekly_review" && !confirmed ? <span className={`${r.tag} ${c.source}`} data-tone="done">周复盘起草</span> : null}
      <section className={c.form} aria-label="我这一行">
        {view.fields.map((field) => (
          <FieldInput key={field.key} field={field} value={values[field.key] ?? ""} readOnly={confirmed || !save}
            onChange={(value) => setValues((current) => ({ ...current, [field.key]: value }))} onBlur={() => void flush()} />
        ))}
      </section>
    </>
  );
}

function FieldInput({ field, value, readOnly, onChange, onBlur }: { field: TCollectionField; value: string; readOnly: boolean; onChange: (value: string) => void; onBlur: () => void }) {
  const id = `field-${field.key}`;
  const label = <label htmlFor={id} className={c.fieldLabel}>{field.label}{field.required ? null : <span className={c.optional}>选填</span>}</label>;
  if (readOnly) return <div className={c.field}>{label}<p id={id} className={c.readValue}>{value ? <CellValue field={field} value={value} /> : "—"}</p></div>;
  return (
    <div className={c.field} data-filled={value.trim() ? "" : undefined}>
      {label}
      {field.kind === "text"
        ? <textarea id={id} rows={2} maxLength={4000} value={value} onChange={(event) => onChange(event.target.value)} onBlur={onBlur} />
        : <input id={id} type={field.kind === "number" ? "number" : "url"} inputMode={field.kind === "number" ? "decimal" : "url"} value={value}
          onChange={(event) => onChange(event.target.value)} onBlur={onBlur} />}
    </div>
  );
}

/* ---------- 发起人：汇总 ---------- */

function Summary({ view }: { view: TCollectionView }) {
  const counts = { confirmed: view.counts.confirmed, filled: view.counts.filled - view.counts.confirmed, empty: view.counts.total - view.counts.filled };
  const order: TCollectionEntryView["status"][] = ["confirmed", "filled", "empty"];
  return (
    <>
      <section className={c.tally} aria-label="每人状态">
        {order.map((status) => (
          <div key={status} className={c.tallyItem} data-tone={STATUS[status].tone}>
            <strong>{counts[status]}</strong><span>{STATUS[status].label}</span>
          </div>
        ))}
        <div className={c.bar} aria-hidden="true">
          {order.map((status) => counts[status] ? <i key={status} data-tone={STATUS[status].tone} style={{ flexGrow: counts[status] }} /> : null)}
        </div>
      </section>
      <div className={c.tableWrap}>
        <table className={c.table}>
          <thead>
            <tr><th scope="col">填写人</th><th scope="col">状态</th>{view.fields.map((field) => <th scope="col" key={field.key}>{field.label}</th>)}</tr>
          </thead>
          <tbody>
            {view.entries.map((entry) => (
              <tr key={entry.personId} data-status={entry.status}>
                <th scope="row"><span className={c.person}><span className={r.avatar} aria-hidden="true">{initial(entry.displayName)}</span>{entry.displayName}</span></th>
                <td><span className={c.status} data-tone={STATUS[entry.status].tone}>{STATUS[entry.status].label}</span>
                  {entry.status === "confirmed" ? <small className={c.when}>{monthDayTime(entry.confirmedAt)}</small> : entry.filled ? <small className={c.when}>{entry.filled}/{entry.required}</small> : null}</td>
                {view.fields.map((field) => <td key={field.key} className={field.kind === "number" ? c.num : undefined}>{entry.values[field.key] ? <CellValue field={field} value={entry.values[field.key]} /> : <span className={c.blank}>—</span>}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className={c.cards} aria-label="每人一张">
        {view.entries.map((entry) => (
          <li key={entry.personId} className={c.personCard}>
            <header><span className={c.person}><span className={r.avatar} aria-hidden="true">{initial(entry.displayName)}</span>{entry.displayName}</span>
              <span className={c.status} data-tone={STATUS[entry.status].tone}>{STATUS[entry.status].label}</span></header>
            <dl>
              {view.fields.filter((field) => entry.values[field.key]).map((field) => (
                <div key={field.key}><dt>{field.label}</dt><dd><CellValue field={field} value={entry.values[field.key]} /></dd></div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

function CellValue({ field, value }: { field: TCollectionField; value: string }) {
  if (field.kind === "link" && /^https?:\/\//.test(value)) {
    const name = value.split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop() || value;
    return <a href={value} target="_blank" rel="noreferrer" title={value}>{name.slice(0, 32)}</a>;
  }
  return <>{value}</>;
}
