"use client";

import { Check, Pencil } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/data/client";
import type {
  ClosureItem,
  ClosureItemKind,
  ClosureReceipt,
  IssueMeeting,
  MeetingRecord,
} from "@/lib/data/types";
import { useInvalidate } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 会后确认。
 *
 * 左边是这场会留下的记录原文（会议纪要、会后复盘），右边是这件议题要核的那几条。
 * 一号位在这一屏上做的事只有一件：**对着原文把右边逐条核过去**，核完落章。
 *
 * 所以右边不是第二份摘要 —— 它是一张勾选单，一行一条，勾一下就过。要看这一条的
 * 全文，眼睛往左移就是。
 */

/**
 * 三个区，没有「未决」。
 *
 * 战略会只定方向：答不了的那几条，答案不在屋里 —— 它们是**要派下去查的活**，不是
 * 悬着的事。留一个未决区，等于允许一条既没人接也没期限的东西留在单子上。
 */
const REGION: { key: ClosureItemKind; label: string }[] = [
  { key: "decision", label: "原则确认" },
  { key: "mission", label: "任务派发" },
  { key: "writeback", label: "沉淀" },
];

const REGION_TONE: Record<ClosureItemKind, string> = {
  decision: "bg-solid",
  mission: "bg-factual",
  open: "bg-factual",
  writeback: "bg-judgment",
};

/** 老快照里可能还留着 `open` —— 归到任务派发，不再单开一区。 */
const regionOf = (kind: ClosureItemKind): ClosureItemKind =>
  kind === "open" ? "mission" : kind;

export function ClosureCheck({
  meeting,
  onChange,
}: {
  meeting: IssueMeeting;
  onChange: () => void;
}) {
  const closure = meeting.closure;

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
      <div className="min-w-0 space-y-4">
        {meeting.records.length === 0 ? (
          <p className="meta rounded-xl border border-hairline bg-surface px-5 py-4 text-ink-muted">
            这件议题还没有会后记录。
          </p>
        ) : (
          meeting.records.map((r) => <RecordArticle key={r.docId} record={r} />)
        )}
      </div>

      <div className="lg:sticky lg:top-20">
        {closure ? (
          <CheckRail closure={closure} onChange={onChange} />
        ) : (
          <p className="meta rounded-xl border border-hairline bg-surface px-4 py-4 text-ink-muted">
            这件议题没有等着签发的条目。
          </p>
        )}
      </div>
    </div>
  );
}

/** 一份记录的全文。分段规则和文档库一致：空行断段，`## ` 是小标题。 */
function RecordArticle({ record }: { record: MeetingRecord }) {
  return (
    <article className="rounded-xl border border-hairline bg-surface px-6 py-5">
      <h2 className="text-md font-medium text-ink">{record.title}</h2>
      <div className="report mt-3 space-y-3 text-md text-ink">
        {record.body.split(/\n{2,}/).map((para, i) =>
          para.startsWith("## ") ? (
            <h3
              key={i}
              className="pt-3 text-base font-medium tracking-[-0.01em] text-ink first:pt-0"
              style={{ fontFamily: "var(--font-sans)" }}
            >
              {para.slice(3)}
            </h3>
          ) : (
            <p key={i}>{para}</p>
          ),
        )}
      </div>
      <p className="meta mt-4 border-t border-hairline pt-2.5 text-ink-faint">
        <Link
          href={`/docs/${record.docId}`}
          className="rounded-[3px] underline decoration-hairline underline-offset-[3px] hover:text-ink-muted"
        >
          {record.docId}
        </Link>
      </p>
    </article>
  );
}

/**
 * 右侧那张勾选单。
 *
 * 勾选是**取舍**，不是核对进度条。他勾上的那几条签发，没勾的不签 —— 会上过了不等于
 * 每一条都值得落到组织身上，「这条我看没必要」是一号位的正当选择，而不是一个待办没做完。
 * 所以签发按钮不等所有条目都勾上才亮，只要有一条被勾就能落章。
 *
 * 每条还可以**就地改字**。这张单子上的话是散会后装配出来的，措辞未必是他会上说的那句；
 * 为了一个词把整条圈除掉，代价太大。
 */
function CheckRail({
  closure,
  onChange,
}: {
  closure: NonNullable<IssueMeeting["closure"]>;
  onChange: () => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<ClosureReceipt | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const invalidate = useInvalidate();

  const items = closure.items;
  const signed = Boolean(closure.signedAt) || receipt !== null;
  const picked = items.filter((i) => checked.has(i.id)).length;

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async (
    itemId: string,
    patch: { title?: string; boundary?: string; fields?: { index: number; value: string }[] },
  ) => {
    setNote(null);
    try {
      await api.updateClosureItem(closure.meetingId, itemId, patch);
      setEditing(null);
      onChange();
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : "这一下没有走完。");
    }
  };

  const sign = async () => {
    if (busy || signed || picked === 0) return;
    setBusy(true);
    setNote(null);
    try {
      /*
       * 落章之前先把取舍写回去：勾上的签，没勾的标成不签。
       *
       * 勾选状态只活在这一屏的 state 里，服务端认的是 `excluded` —— 不先对齐，
       * 签发会把他没勾的那几条也一起下达。
       */
      for (const item of items) {
        const want = !checked.has(item.id);
        if (item.excluded !== want) {
          await api.updateClosureItem(closure.meetingId, item.id, { excluded: want });
        }
      }
      setReceipt(await api.signClosure(closure.meetingId));
      onChange();
      invalidate((k) => k.startsWith("issue-meeting:") || k.startsWith("closure:"));
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : "这一下没有走完。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-hairline bg-surface">
      <header className="flex items-baseline justify-between gap-2 border-b border-hairline px-4 py-3">
        <h2 className="text-md font-medium text-ink">待确认</h2>
        <span className="meta tabular-nums text-ink-faint">
          已选 {picked} / {items.length}
        </span>
      </header>

      <div className="scroll-slim max-h-[calc(100vh-19rem)] space-y-4 overflow-y-auto px-4 py-4">
        {REGION.map((r) => {
          const rows = items.filter((i) => regionOf(i.kind) === r.key);
          if (rows.length === 0) return null;
          return (
            <section key={r.key}>
              <h3 className="meta mb-1.5 flex items-baseline gap-2 text-ink-faint">
                <span className={cn("size-1.5 rounded-full", REGION_TONE[r.key])} aria-hidden />
                {r.label} · {rows.length}
              </h3>
              <ul className="space-y-1">
                {rows.map((item) => (
                  <CheckRow
                    key={item.id}
                    item={item}
                    checked={checked.has(item.id)}
                    disabled={signed}
                    editing={editing === item.id}
                    onToggle={() => toggle(item.id)}
                    onEdit={() => setEditing(item.id)}
                    onCancel={() => setEditing(null)}
                    onSave={(patch) => void save(item.id, patch)}
                  />
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <footer className="border-t border-hairline px-4 py-3.5">
        {signed ? (
          <Receipt receipt={receipt} signedNo={closure.signedNo} />
        ) : (
          <>
            {picked > 0 ? (
              <p className="meta mb-2 text-ink-muted">
                {`签发 ${picked} 条${items.length - picked > 0 ? ` · 不签 ${items.length - picked} 条` : ""}`}
              </p>
            ) : null}
            <HoldToSign busy={busy} ready={picked > 0} onSign={() => void sign()} />
          </>
        )}
        {note ? <p className="meta mt-2 text-counter">{note}</p> : null}
      </footer>
    </div>
  );
}

function CheckRow({
  item,
  checked,
  disabled,
  editing,
  onToggle,
  onEdit,
  onCancel,
  onSave,
}: {
  item: ClosureItem;
  checked: boolean;
  disabled: boolean;
  editing: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (patch: {
    title?: string;
    boundary?: string;
    fields?: { index: number; value: string }[];
  }) => void;
}) {
  if (editing) return <EditRow item={item} onCancel={onCancel} onSave={onSave} />;

  return (
    <li
      className={cn(
        "group/row relative rounded-lg border transition-colors duration-fast ease-swift",
        checked ? "border-confirmed/40 bg-confirmed-wash" : "border-hairline bg-surface",
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        disabled={disabled}
        onClick={onToggle}
        className="flex w-full items-start gap-2.5 rounded-lg px-3 py-2 pr-8 text-left disabled:opacity-60"
      >
        <span
          aria-hidden
          className={cn(
            "mt-[2px] flex size-4 flex-none items-center justify-center rounded-[4px] border transition-colors duration-fast",
            checked ? "border-confirmed bg-confirmed text-solid-fg" : "border-hairline-strong",
          )}
        >
          {checked && <Check className="size-3" />}
        </span>
        {/*
         * 一条不截。截两行看起来整齐，但他核对的正是那几个字 —— 截掉的那一半
         * 恰恰是「期限多久、谁承接、边界在哪」，而省略号让人以为已经读完了。
         */}
        <span className="min-w-0">
          <span className="block text-sm leading-relaxed text-ink">{item.title}</span>
          {item.fields.map((f, i) => (
            <span key={i} className="meta mt-1 block leading-relaxed text-ink-faint">
              <span className="text-ink-muted">{f.label}</span> {f.value}
            </span>
          ))}
          {item.boundary ? (
            <span className="meta mt-1 block leading-relaxed text-counter">
              <span>边界</span> {item.boundary}
            </span>
          ) : null}
        </span>
      </button>

      {/* 改字。悬停才出现 —— 这一栏的主动作是取舍，改字是偶尔为之。 */}
      {disabled ? null : (
        <button
          type="button"
          aria-label="改这一条"
          title="改这一条"
          onClick={onEdit}
          className="absolute top-1.5 right-1.5 rounded-md p-1 text-ink-faint opacity-0 transition-opacity duration-fast group-hover/row:opacity-100 hover:bg-surface hover:text-ink focus-visible:opacity-100"
        >
          <Pencil className="size-3" aria-hidden />
        </button>
      )}
    </li>
  );
}

/**
 * 改一条。
 *
 * 标题、每个字段、边界各一个输入框，标签留在旁边不给改 —— 标签是这条单子的结构
 * （「完成要求」「责任侧」「时间」），改结构和改内容是两件事，后者才是他此刻要做的。
 */
function EditRow({
  item,
  onCancel,
  onSave,
}: {
  item: ClosureItem;
  onCancel: () => void;
  onSave: (patch: {
    title?: string;
    boundary?: string;
    fields?: { index: number; value: string }[];
  }) => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [values, setValues] = useState<string[]>(item.fields.map((f) => f.value));
  const [boundary, setBoundary] = useState(item.boundary ?? "");
  const [busy, setBusy] = useState(false);

  const submit = () => {
    if (busy) return;
    setBusy(true);
    onSave({
      title,
      ...(item.boundary === undefined && boundary.trim().length === 0 ? {} : { boundary }),
      fields: values.map((value, index) => ({ index, value })),
    });
  };

  return (
    <li className="rounded-lg border border-hairline-strong bg-surface px-3 py-2.5">
      <Field label="这一条" value={title} onChange={setTitle} rows={2} />
      {item.fields.map((f, i) => (
        <Field
          key={i}
          label={f.label}
          value={values[i]}
          onChange={(v) => setValues((prev) => prev.map((x, n) => (n === i ? v : x)))}
        />
      ))}
      {item.boundary === undefined ? null : (
        <Field label="边界" value={boundary} onChange={setBoundary} />
      )}
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          disabled={busy || title.trim().length === 0}
          onClick={submit}
          className="meta inline-flex h-7 items-center rounded-md bg-solid px-2.5 font-medium text-solid-fg transition-opacity duration-fast hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "正在存…" : "存下"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="meta rounded-[3px] px-1 text-ink-faint transition-colors duration-fast hover:text-ink-muted"
        >
          算了
        </button>
      </div>
    </li>
  );
}

function Field({
  label,
  value,
  onChange,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <label className="mt-2 block first:mt-0">
      <span className="meta block text-ink-faint">{label}</span>
      <textarea
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="scroll-slim mt-1 w-full resize-y rounded-md border border-hairline bg-paper px-2 py-1.5 text-sm leading-relaxed text-ink outline-none transition-colors duration-fast focus:border-hairline-strong"
      />
    </label>
  );
}

/**
 * 按住 1 秒落章。
 *
 * 1 秒不构成摩擦，但它给这一下重量 —— 刻意的确认动作会提高承诺强度，而这一下要同时
 * 改判断、下达任务、布控督办。落章之后不跳转、不庆祝，就地展开回执。
 */
function HoldToSign({
  busy,
  ready,
  onSign,
}: {
  busy: boolean;
  ready: boolean;
  onSign: () => void;
}) {
  const [progress, setProgress] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setProgress(0);
  };

  useEffect(() => stop, []);

  const start = () => {
    if (busy || !ready || timer.current) return;
    const startedAt = Date.now();
    timer.current = setInterval(() => {
      const p = Math.min(1, (Date.now() - startedAt) / 1000);
      setProgress(p);
      if (p >= 1) {
        stop();
        onSign();
      }
    }, 40);
  };

  return (
    <button
      type="button"
      disabled={busy || !ready}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") start();
      }}
      onKeyUp={stop}
      className="relative flex h-10 w-full items-center justify-center overflow-hidden rounded-lg bg-solid text-sm font-medium text-solid-fg transition-opacity duration-fast ease-swift hover:opacity-90 disabled:opacity-40"
    >
      <span
        aria-hidden
        /* 用 solid-fg 而不是 white：`--solid` 在深色下反成浅面，白色 25% 盖上去
           合成 #efeff1 压在 #eaeaec 上 —— 进度条直接看不见了。solid-fg 跟着方案反。 */
        className="absolute inset-y-0 left-0 bg-solid-fg/18 transition-[width] duration-100 ease-linear"
        style={{ width: `${progress * 100}%` }}
      />
      <span className="relative">{busy ? "正在签发…" : "按住 1 秒签发"}</span>
    </button>
  );
}

function Receipt({
  receipt,
  signedNo,
}: {
  receipt: ClosureReceipt | null;
  signedNo?: string;
}) {
  const updated = receipt?.updated ?? [];
  return (
    <div className="animate-fade">
      <p className="flex items-center gap-2 text-md font-medium text-confirmed">
        <Check className="size-4" aria-hidden />
        已签发 · {receipt?.signedNo ?? signedNo}
      </p>
      {updated.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {updated.map((w, i) => (
            <li key={i} className="flex gap-2 text-sm leading-relaxed text-ink-muted">
              <span aria-hidden className="text-ink-faint">
                ·
              </span>
              {w.href ? (
                <Link
                  href={w.href}
                  className="rounded-[3px] underline decoration-hairline underline-offset-[3px] transition-colors duration-fast hover:text-ink"
                >
                  {w.label}
                </Link>
              ) : (
                <span>{w.label}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
