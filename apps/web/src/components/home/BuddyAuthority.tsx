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
import { emitBuddyUi, useBuddyUi } from "@/lib/buddy/uiEvent";
import { browserApi } from "@/lib/api/client";
import { relativeDayTime } from "@/lib/companyTime";
import { Row, Section, SwitchRow } from "./pages/parts";
import p from "@/styles/home-pages.module.css";

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
    <Section title="伙伴" testId="pref-buddy">
      {authority ? <ul className={p.rows}><SwitchRow name="代我做事" checked={authority === "full"} onChange={toggle} testId="buddy-authority" /></ul> : null}
      {failed ? <FailedLine {...failed} /> : null}
      <BuddyLog />
    </Section>
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
    void undoBuddyAction(entry.id).then((next) => {
      setEntries((current) => current.map((item) => (item.id === entry.id ? next : item)));
      // 撤销以后界面马上跟着变：外观按服务端现在的换，首页和偏好重读（同伙伴做事时插进对话流的效果）。
      if (entry.action === "set_appearance") void browserApi.GET("/api/me/appearance").then(({ data }) => { if (data) emitBuddyUi({ kind: "appearance", appearance: data.appearance }); });
      emitBuddyUi({ kind: "refresh", what: ["work_home", "settings", "trash"] });
    },
      (error: unknown) => setProblem({ id: entry.id, text: error instanceof Error ? error.message : "撤不了" }));
  };
  return <BuddyLogList entries={entries} problem={problem} onUndo={undo} />;
}

export function BuddyLogList({ entries, problem, onUndo }: { entries: TBuddyAuditEntry[]; problem: { id: string; text: string } | null; onUndo: (entry: TBuddyAuditEntry) => void }) {
  return (
    <ul className={p.rows} aria-label="伙伴做过的事" data-testid="buddy-log">
      {entries.map((entry) => (
        <Row key={entry.id} name={entry.summary} sub={relativeDayTime(entry.at)}
          action={<>
            {problem?.id === entry.id ? <span className={p.error}>{problem.text}</span> : null}
            {entry.undoneAt ? <span className={p.state}>已撤销</span>
              : entry.undoable ? <HeroButton variant="tertiary" size="sm" onPress={() => onUndo(entry)}>撤销</HeroButton> : null}
          </>} />
      ))}
    </ul>
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
    <Section title="回收站" testId="pref-trash">
      <ul className={p.rows}>
        {items.map((item) => (
          <Row key={`${item.kind}:${item.id}`} name={item.title} sub={relativeDayTime(item.deletedAt)}
            action={<>
              {failed === item.id ? <span className={p.error}>失败</span> : null}
              <HeroButton variant="tertiary" size="sm" onPress={() => restore(item)}>{failed === item.id ? "重试" : "恢复"}</HeroButton>
            </>} />
        ))}
      </ul>
    </Section>
  );
}
