"use client";

/**
 * 二号位首页的「计划外」（前端交互实现说明第 5 节第 4 条）：采集器整理时归不上你任何执行事项的工作。
 * 每条二选一：挂到某件执行事项上（记成这件事的进展），或者提出改计划（先只记下来）。右上角进同一战场的进展。
 */
import { useCallback, useEffect, useState } from "react";
import { Card } from "@heroui/react";
import { ChevronRight } from "lucide-react";
import { TianshuPortalTheme } from "ts-design";
import { Button, Label, ListBox, Select } from "ts-design/primitives";
import type { TMyOffPlanResponse, TOffPlanItem } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import { Artifacts, SOURCE_NAMES } from "./ProgressScreen";
import { spentText } from "./progressText";
import m from "./member-off-plan.module.css";

type Navigate = (href: string, origin?: Element | null) => void;

/** onAttached：挂上之后让首页重读执行事项（那件事多了一条进展）。 */
export function MemberOffPlan({ onNavigate, onAttached }: { onNavigate: Navigate; onAttached?: () => void }) {
  const [data, setData] = useState<TMyOffPlanResponse | null>(null);
  const load = useCallback(async () => {
    try {
      const { data: next } = await browserApi.GET("/api/me/off-plan");
      if (next) setData(next);
    } catch { /* 下次回到前台再读 */ }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load]);

  const items = data?.items ?? [];
  const minutes = items.reduce((sum, item) => sum + item.spentMinutes, 0);
  return <section className={m.section} aria-label="计划外">
    <div className={m.toolbar}>
      <span>{items.length ? <>计划外 <b>{items.length}</b> · {spentText(minutes)}</> : null}</span>
      <Button variant="ghost" size="sm" data-origin="/me/progress" onPress={(event) => onNavigate("/me/progress", event.target as Element)}>战场进展<ChevronRight size={15} aria-hidden /></Button>
    </div>
    {items.length ? <div className={m.grid}>{items.map((item) => <OffPlanCard key={item.id} item={item} tasks={data!.tasks} onChange={setData} onAttached={onAttached} />)}</div> : null}
  </section>;
}

function OffPlanCard({ item, tasks, onChange, onAttached }: { item: TOffPlanItem; tasks: TMyOffPlanResponse["tasks"]; onChange: (next: TMyOffPlanResponse) => void; onAttached?: () => void }) {
  const [choosing, setChoosing] = useState(false);
  const suggested = item.candidateTask && tasks.some((task) => task.taskId === item.candidateTask!.taskId) ? item.candidateTask.taskId : tasks[0]?.taskId ?? "";
  const [taskId, setTaskId] = useState(suggested);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const run = async (request: () => Promise<{ data?: TMyOffPlanResponse; error?: { message?: string } }>) => {
    setPending(true); setError("");
    try {
      const { data, error: failure } = await request();
      if (data) { onChange(data); setChoosing(false); return true; }
      setError(failure?.message ?? "没有记下，请重试");
    } catch { setError("暂时无法连接服务器，请重试"); }
    finally { setPending(false); }
    return false;
  };
  const attach = async () => { if (await run(() => browserApi.POST("/api/me/off-plan/{id}/attach", { params: { path: { id: item.id } }, body: { taskId } }))) onAttached?.(); };
  const replan = () => run(() => browserApi.POST("/api/me/off-plan/{id}/replan", { params: { path: { id: item.id } } }));
  const end = monthDayTime(item.evidence.endedAt);
  return <Card className={m.card} data-off-plan={item.id}>
    <div className={m.top}>
      <span className={m.kind} data-kind={item.kind}>{item.kind === "attach" ? "待挂靠" : "待改计划"}</span>
      <span className={m.spent}>{spentText(item.spentMinutes)}</span>
    </div>
    <p className={m.text}>{item.text}</p>
    <p className={m.meta}>{[SOURCE_NAMES[item.evidence.source] ?? item.evidence.source, item.evidence.repo, `${monthDayTime(item.evidence.startedAt)}–${end.slice(end.indexOf(" ") + 1)}`].filter(Boolean).join(" · ")}</p>
    <Artifacts items={item.evidence.links} />
    {item.replanProposedAt ? <p className={m.proposed} role="status">已提改计划 · {monthDayTime(item.replanProposedAt)}</p> : null}
    {choosing ? <div className={m.attach}>
      <Select aria-label="挂到哪件执行事项" selectedKey={taskId || null} onSelectionChange={(key) => setTaskId(String(key))}>
        <Label>挂到</Label>
        <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
        <Select.Popover><TianshuPortalTheme><ListBox>{tasks.map((task) => <ListBox.Item key={task.taskId} id={task.taskId} textValue={task.title}>{task.title}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></TianshuPortalTheme></Select.Popover>
      </Select>
      <div className={m.actions}>
        <Button variant="primary" size="sm" isDisabled={!taskId || pending} onPress={() => void attach()}>挂上</Button>
        <Button variant="ghost" size="sm" isDisabled={pending} onPress={() => setChoosing(false)}>取消</Button>
      </div>
    </div> : <div className={m.actions}>
      <Button variant={item.kind === "attach" ? "primary" : "secondary"} size="sm" isDisabled={!tasks.length || pending} onPress={() => setChoosing(true)}>挂到执行事项</Button>
      {item.replanProposedAt ? null : <Button variant={item.kind === "replan" ? "primary" : "secondary"} size="sm" isDisabled={pending} onPress={() => void replan()}>提出改计划</Button>}
    </div>}
    {error ? <p className={m.error} role="alert">{error}</p> : null}
  </Card>;
}
