"use client";

/**
 * 「偏好」里伙伴代本人做事的那几块（设计 17.4、17.7）：
 * - 授权开关（GET / PUT /api/me/buddy-authority）：开着伙伴有和本人一样的权限，关了只能读。
 * - 伙伴做过的事（GET /api/me/buddy-actions/log）：新的在前，能撤的给「撤销」，撤过的写「已撤销」；撤不了（409）在那一行写原因。
 * - 回收站（GET /api/me/trash）：删掉的子会话，「恢复」；空着不画。
 * 伙伴改了设置或删了东西（对话流的 ui refresh：settings、trash）时重读。
 */
import { useCallback, useEffect, useState } from "react";
import type { TBuddyAuditEntry, TBuddyAuthority, TTrashItem } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { FailedLine, failureOf, type Failure } from "@/components/work/DecisionBox";
import { readBuddyAuthority, readBuddyLog, readTrash, restoreTrash, saveBuddyAuthority, undoBuddyAction } from "@/lib/buddy/actions";
import { useBuddyUi } from "@/lib/buddy/uiEvent";
import { relativeDayTime } from "@/lib/companyTime";
import s from "@/styles/v2-local.module.css";

export function BuddyAuthoritySection() {
  const [authority, setAuthority] = useState<TBuddyAuthority["authority"] | null>(null);
  const [failed, setFailed] = useState<Failure | null>(null);
  const load = useCallback(() => void readBuddyAuthority().then((found) => setAuthority(found.authority), () => undefined), []);
  useEffect(load, [load]);
  useBuddyUi((effect) => { if (effect.kind === "refresh" && effect.what.includes("settings")) load(); });
  const toggle = (on: boolean) => {
    const next = on ? "full" : "none";
    const previous = authority;
    setFailed(null);
    setAuthority(next);
    void saveBuddyAuthority(next).catch((error: unknown) => { setAuthority(previous); setFailed(failureOf(error, () => toggle(on))); });
  };
  return (
    <section className={s.section} aria-label="伙伴" data-testid="pref-buddy">
      <p className={s.lab}>伙伴</p>
      {authority ? (
        <label className={s.toggle}>
          <input type="checkbox" checked={authority === "full"} onChange={(event) => toggle(event.target.checked)} data-testid="buddy-authority" />
          <span>代我做事</span>
        </label>
      ) : null}
      {failed ? <FailedLine inline {...failed} /> : null}
      <BuddyLog />
    </section>
  );
}

export function BuddyLog() {
  const [entries, setEntries] = useState<TBuddyAuditEntry[]>([]);
  const [problem, setProblem] = useState<{ id: string; text: string } | null>(null);
  const load = useCallback(() => void readBuddyLog().then(setEntries, () => undefined), []);
  useEffect(load, [load]);
  useBuddyUi((effect) => { if (effect.kind === "refresh") load(); });
  if (!entries.length) return null;
  const undo = (entry: TBuddyAuditEntry) => {
    setProblem(null);
    void undoBuddyAction(entry.id).then((next) => setEntries((current) => current.map((item) => (item.id === entry.id ? next : item))),
      (error: unknown) => setProblem({ id: entry.id, text: error instanceof Error ? error.message : "撤不了" }));
  };
  return <BuddyLogList entries={entries} problem={problem} onUndo={undo} />;
}

export function BuddyLogList({ entries, problem, onUndo }: { entries: TBuddyAuditEntry[]; problem: { id: string; text: string } | null; onUndo: (entry: TBuddyAuditEntry) => void }) {
  return (
    <div className={s.block} aria-label="伙伴做过的事" data-testid="buddy-log">
      {entries.map((entry) => (
        <div key={entry.id} className={s.line}>
          <span>{entry.summary}</span>
          <small className={s.faint}>{relativeDayTime(entry.at)}</small>
          <span className={s.grow} />
          {problem?.id === entry.id ? <span className={s.error}>{problem.text}</span> : null}
          {entry.undoneAt ? <span className={s.state}>已撤销</span>
            : entry.undoable ? <HeroButton variant="ghost" size="sm" onPress={() => onUndo(entry)}>撤销</HeroButton> : null}
        </div>
      ))}
    </div>
  );
}

export function TrashSection() {
  const [items, setItems] = useState<TTrashItem[]>([]);
  const [failed, setFailed] = useState<string | null>(null);
  const load = useCallback(() => void readTrash().then(setItems, () => undefined), []);
  useEffect(load, [load]);
  useBuddyUi((effect) => { if (effect.kind === "refresh" && effect.what.includes("trash")) load(); });
  if (!items.length) return null;
  const restore = (item: TTrashItem) => {
    setFailed(null);
    void restoreTrash(item).then(() => setItems((current) => current.filter((entry) => entry.id !== item.id)), () => setFailed(item.id));
  };
  return (
    <section className={s.section} aria-label="回收站" data-testid="pref-trash">
      <p className={s.lab}>回收站</p>
      <div className={s.block}>
        {items.map((item) => (
          <div key={`${item.kind}:${item.id}`} className={s.line}>
            <span>{item.title}</span>
            <small className={s.faint}>{relativeDayTime(item.deletedAt)}</small>
            <span className={s.grow} />
            {failed === item.id ? <span className={s.error}>失败</span> : null}
            <HeroButton variant="ghost" size="sm" onPress={() => restore(item)}>{failed === item.id ? "重试" : "恢复"}</HeroButton>
          </div>
        ))}
      </div>
    </section>
  );
}
