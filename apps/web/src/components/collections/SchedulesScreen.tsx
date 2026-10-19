"use client";

/**
 * 设置里的定时任务区（个人菜单「定时任务」进来，二级页统一壳）。参照 Linear 的 Recurring issues 列表：
 * 按「收集」「其他」分组，每行是名字、节奏、下次时间；每周固定的收集任务可以停用（再按一次才停，同退出登录）；点开去最近一轮。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardList, Laptop, NotebookPen } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { TScheduleItem } from "@warmap/contracts";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import type { Card } from "@/lib/api/client";
import { requestError } from "@/components/requests/requestApi";
import r from "@/components/requests/requests.module.css";
import { deadlineText, readSchedules, runCollectionAction } from "./collectionApi";
import c from "./collections.module.css";

const NO_CARDS: Card[] = [];
const GROUPS: { category: TScheduleItem["category"]; title: string }[] = [{ category: "collect", title: "收集" }, { category: "other", title: "其他" }];
const ICON = { collection: ClipboardList, weekly_review: NotebookPen, local: Laptop } as const;

export function SchedulesScreen() {
  const workspace = useWorkspace();
  const [items, setItems] = useState<TScheduleItem[] | null>(null);
  const [error, setError] = useState("");
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useRegisterDetail(useMemo(() => ({ scope: "global", label: "定时任务", mark: null, cards: NO_CARDS }), []));
  const load = useCallback(async () => {
    try { setItems(await readSchedules()); } catch (cause) { setError(requestError(cause, "没有读到定时任务")); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const stop = async (item: TScheduleItem) => {
    const action = item.actions.find((candidate) => candidate.actionType === "collection.stop");
    if (!action || busy) return;
    if (armed !== item.id) { setArmed(item.id); return; }
    setBusy(true); setError("");
    try { await runCollectionAction(action); setArmed(null); workspace.showToast(`已停用：${item.name}`); await load(); }
    catch (cause) { setError(requestError(cause, "没有停用，请重试")); }
    finally { setBusy(false); }
  };

  return (
    <div className={r.screen}>
      <DetailFrame title="定时任务" subtitle="设置" onBack={() => workspace.close()}>
        <div className={r.content}>
          <div className={r.stack}>
            {error ? <p className={r.error} role="alert">{error}</p> : null}
            {!items ? <div className={c.placeholder} aria-busy="true" /> : GROUPS.map((group) => {
              const rows = items.filter((item) => item.category === group.category);
              if (!rows.length && (items.length || group.category !== "collect")) return null;
              return (
                <section key={group.category} className={c.group} aria-labelledby={`schedules-${group.category}`}>
                  <h2 id={`schedules-${group.category}`} className={c.groupHead}>{group.title}<b className={r.count} data-tone="done">{rows.length}</b></h2>
                  {rows.length ? (
                    <ul className={c.schedules}>
                      {rows.map((item) => {
                        const Icon = ICON[item.origin];
                        const meta = [item.cadence, item.nextRunAt ? `下次 ${deadlineText(item.nextRunAt)}` : null, item.deviceName, item.active ? null : "已停用"].filter(Boolean);
                        const main = <><strong>{item.name}</strong><small>{meta.map((text) => <span key={text}>{text}</span>)}</small></>;
                        return (
                          <li key={item.id} className={c.schedule} data-origin={item.origin} data-inactive={item.active ? undefined : ""}>
                            <span className={c.scheduleIcon} aria-hidden="true"><Icon size={18} /></span>
                            {item.href
                              ? <button type="button" className={c.scheduleMain} onClick={() => workspace.navigate(item.href!)}>{main}</button>
                              : <div className={c.scheduleMain}>{main}</div>}
                            <span className={c.scheduleSide}>
                              {item.actions.length ? (
                                <Button variant="ghost" className={r.ghost} isDisabled={busy} onPress={() => void stop(item)} onBlur={() => setArmed(null)}>
                                  {armed === item.id ? "再按一次停用" : "停用"}
                                </Button>
                              ) : null}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </section>
              );
            })}
          </div>
        </div>
      </DetailFrame>
    </div>
  );
}
