"use client";

/**
 * 记忆导入的确认组件（7a-3，组件约定见 .scratch/memory-page-import/组件约定.md）：可以单独用，
 * 「我的记忆」页的导入弹窗和上手流程最后一页的「导入的记忆」标签用的是同一个。
 *
 * - 处理中显示五步（读取、拆分、分类、去重和冲突、等你确认），每秒刷新一次；停住时一颗「重试」。
 * - 只列两组要本人看的：有冲突的（旧 / 新并排，三选一，默认保留旧的）、没把握的（默认不勾）。
 * - 其余各组折成一排数字，点开能逐条改勾选（密钥、注入锁住，勾不上）。
 * - 底部「确认导入 N」；「丢弃」要按两次。确认后回调 onConfirmed，组件停在完成态。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, LoaderCircle, Lock, RotateCcw } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { browserApi } from "@/lib/api/client";
import { StepList } from "@/components/steps/StepList";
import { FOLDED_GROUPS, SOURCE_LABEL, shortDate, type ImportCandidate, type MemoryImport, type MemoryImportDetail } from "./memoryModel";
import s from "./memory.module.css";

type Choice = "keep_old" | "use_new" | "neither";
const POLL_MS = 1000;

export function MemoryImportReview({ importId, onConfirmed, onDiscarded, className }: {
  importId: string;
  /** 确认成功后（导入了几条在 counts.imported）。 */
  onConfirmed?: (result: MemoryImport) => void;
  /** 丢弃成功后；不给时组件里不出现「丢弃」。 */
  onDiscarded?: () => void;
  className?: string;
}) {
  const [detail, setDetail] = useState<MemoryImportDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [checked, setChecked] = useState<Set<string> | null>(null);
  const [choices, setChoices] = useState<Map<string, Choice>>(new Map());
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discardArmed, setDiscardArmed] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await browserApi.GET("/api/me/memory/imports/{id}", { params: { path: { id: importId } } });
      setLoadFailed(!data);
      if (data) setDetail(data);
      return data ?? null;
    } catch {
      setLoadFailed(true);
      return null;
    }
  }, [importId]);

  useEffect(() => {
    setDetail(null);
    setChecked(null);
    setChoices(new Map());
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const next = await load();
      if (live && (!next || next.status === "processing")) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [load]);

  // 进入「等你确认」时按服务端的默认勾选起一份本地勾选。
  useEffect(() => {
    if (detail?.status === "awaiting_review" && checked === null) setChecked(new Set(detail.candidates.filter((item) => item.checked).map((item) => item.id)));
  }, [detail, checked]);

  const groups = useMemo(() => {
    const by = new Map<string, ImportCandidate[]>();
    for (const item of detail?.candidates ?? []) by.set(item.group ?? "", [...(by.get(item.group ?? "") ?? []), item]);
    return by;
  }, [detail]);

  const retry = async () => {
    setBusy(true);
    setError(null);
    const { data } = await browserApi.POST("/api/me/memory/imports/{id}/retry", { params: { path: { id: importId } } }).catch(() => ({ data: undefined }));
    setBusy(false);
    if (!data) { setError("没能重试"); return; }
    setDetail((current) => (current ? { ...current, ...data } : current));
    const poll = async () => { const next = await load(); if (next?.status === "processing") setTimeout(poll, POLL_MS); };
    setTimeout(poll, POLL_MS);
  };

  const confirm = async () => {
    if (!detail || !checked) return;
    setBusy(true);
    setError(null);
    const resolutions = (groups.get("conflict") ?? []).map((item) => ({ id: item.id, choice: choices.get(item.id) ?? "keep_old" }));
    const { data } = await browserApi.POST("/api/me/memory/imports/{id}/confirm", { params: { path: { id: importId } }, body: { checked: [...checked], resolutions } })
      .catch(() => ({ data: undefined }));
    setBusy(false);
    if (!data) { setError("没确认上"); return; }
    setDetail({ ...detail, ...data });
    onConfirmed?.(data);
  };

  const discard = async () => {
    if (!discardArmed) { setDiscardArmed(true); return; }
    setBusy(true);
    const { response } = await browserApi.DELETE("/api/me/memory/imports/{id}", { params: { path: { id: importId } } }).catch(() => ({ response: undefined }));
    setBusy(false);
    if (!response?.ok) { setError("没丢弃成功"); setDiscardArmed(false); return; }
    onDiscarded?.();
  };

  if (!detail) {
    return <div className={`${s.review} ${className ?? ""}`} aria-busy={!loadFailed}>{loadFailed ? <p className={s.error} role="alert">没读到</p> : <div className={s.loading} role="status" aria-label="加载中"><LoaderCircle size={16} aria-hidden /></div>}</div>;
  }

  const toggle = (id: string, on: boolean) => setChecked((current) => {
    const next = new Set(current ?? []);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  // 「导入」写勾上的条数；「公司」（V1 也当本人记忆导入）写勾上的 / 一共的；其余写一共几条。
  const foldCount = (id: string) => {
    const items = groups.get(id) ?? [];
    const on = items.filter((item) => checked?.has(item.id)).length;
    return id === "import" ? String(on) : id === "company" ? `${on}/${items.length}` : String(items.length);
  };
  const conflicts = groups.get("conflict") ?? [];
  const uncertain = groups.get("uncertain") ?? [];
  const importCount = (checked ? [...checked].filter((id) => detail.candidates.some((item) => item.id === id && !item.locked && item.group !== "conflict" && item.group !== "partner")).length : 0)
    + conflicts.filter((item) => (choices.get(item.id) ?? "keep_old") === "use_new" || (item.conflict?.candidateId && (choices.get(item.id) ?? "keep_old") === "keep_old")).length;

  return (
    <div className={`${s.review} ${className ?? ""}`} data-import-status={detail.status}>
      <div data-tone="ink" className={s.steps}><StepList steps={detail.steps} /></div>
      {detail.status === "failed" ? (
        <div className={s.reviewBar}>
          <HeroButton variant="tertiary" size="sm" isDisabled={busy} onPress={() => void retry()}><RotateCcw size={16} aria-hidden />重试</HeroButton>
        </div>
      ) : null}
      {detail.status === "confirmed" ? (
        <p className={s.done}><Check size={16} strokeWidth={2.2} aria-hidden />导入 {detail.counts.imported ?? 0}</p>
      ) : null}
      {detail.status === "awaiting_review" && checked ? (
        <>
          {conflicts.length ? (
            <section className={s.reviewGroup} aria-labelledby={`${importId}-conflict`}>
              <h3 id={`${importId}-conflict`} className={s.groupHead}>有冲突<span className={s.count}>{conflicts.length}</span></h3>
              <ul className={s.conflictList}>
                {conflicts.map((item) => <ConflictRow key={item.id} item={item} choice={choices.get(item.id) ?? "keep_old"}
                  onChoose={(choice) => setChoices((current) => new Map(current).set(item.id, choice))} />)}
              </ul>
            </section>
          ) : null}
          {uncertain.length ? (
            <section className={s.reviewGroup} aria-labelledby={`${importId}-uncertain`}>
              <h3 id={`${importId}-uncertain`} className={s.groupHead}>没把握<span className={s.count}>{uncertain.length}</span></h3>
              <ul className={s.candidateList}>
                {uncertain.map((item) => <CandidateRow key={item.id} item={item} checked={checked.has(item.id)} onToggle={(on) => toggle(item.id, on)} />)}
              </ul>
            </section>
          ) : null}
          <div className={s.folded} role="group" aria-label="其余各组">
            {FOLDED_GROUPS.filter((group) => groups.get(group.id)?.length).map((group) => (
              <button key={group.id} type="button" className={s.foldChip} aria-expanded={open === group.id} onClick={() => setOpen(open === group.id ? null : group.id)}>
                {group.label}<span>{foldCount(group.id)}</span>
                <ChevronDown size={13} aria-hidden />
              </button>
            ))}
          </div>
          {open && groups.get(open)?.length ? (
            <ul className={s.candidateList} data-folded={open}>
              {groups.get(open)!.map((item) => <CandidateRow key={item.id} item={item} checked={checked.has(item.id)} onToggle={(on) => toggle(item.id, on)} />)}
            </ul>
          ) : null}
          <div className={s.reviewBar}>
            {error ? <span className={s.error} role="alert">{error}</span> : null}
            {onDiscarded ? (
              <HeroButton variant="ghost" size="sm" isDisabled={busy} onPress={() => void discard()}>{discardArmed ? "再按一次丢弃" : "丢弃"}</HeroButton>
            ) : null}
            <HeroButton variant="primary" size="sm" isDisabled={busy} onPress={() => void confirm()}>确认导入 {importCount}</HeroButton>
          </div>
        </>
      ) : null}
    </div>
  );
}

const sourceMeta = (item: Pick<ImportCandidate, "source" | "path">) => {
  const file = item.path.split(/[\\/!#]/).filter(Boolean).pop() ?? "";
  return /^paste-\d+\.txt$/.test(file) ? SOURCE_LABEL[item.source] : `${SOURCE_LABEL[item.source]} · ${file}`;
};
const CATEGORY_TAG: Record<string, string> = { company_fact: "公司", project_instruction: "项目", drop: "不导入" };

function CandidateRow({ item, checked, onToggle }: { item: ImportCandidate; checked: boolean; onToggle: (on: boolean) => void }) {
  const tag = item.category ? CATEGORY_TAG[item.category] : undefined;
  return (
    <li className={s.candidate} data-locked={item.locked ? "" : undefined}>
      <label>
        {item.locked ? <Lock size={14} className={s.lock} aria-label="不能导入" /> : (
          <input type="checkbox" className={s.check} checked={checked} onChange={(event) => onToggle(event.target.checked)} />
        )}
        <span className={s.candidateText}>
          <span>{item.text}</span>
          <small>{sourceMeta(item)}{tag ? <em className={s.tag}>{tag}</em> : null}</small>
        </span>
      </label>
    </li>
  );
}

const CHOICES: { id: Choice; label: string }[] = [{ id: "keep_old", label: "保留旧的" }, { id: "use_new", label: "用新的" }, { id: "neither", label: "都不要" }];

function ConflictRow({ item, choice, onChoose }: { item: ImportCandidate; choice: Choice; onChoose: (choice: Choice) => void }) {
  const old = item.conflict;
  return (
    <li className={s.conflict}>
      <div className={s.versus}>
        <div className={s.side} data-picked={choice === "keep_old" ? "" : undefined}>
          <span className={s.sideTag}>旧</span>
          <p>{old?.text}</p>
          <small>{old?.memoryId ? "我的记忆" : "同批"} · {old ? shortDate(old.at) : ""}</small>
        </div>
        <div className={s.side} data-picked={choice === "use_new" ? "" : undefined}>
          <span className={s.sideTag}>新</span>
          <p>{item.text}</p>
          <small>{sourceMeta(item)}</small>
        </div>
      </div>
      <div className={s.choices} role="radiogroup" aria-label="怎么处理">
        {CHOICES.map((option) => (
          <label key={option.id} className={s.choice} data-checked={choice === option.id ? "" : undefined}>
            <input type="radio" name={`conflict-${item.id}`} checked={choice === option.id} onChange={() => onChoose(option.id)} />
            {option.label}
          </label>
        ))}
      </div>
    </li>
  );
}
