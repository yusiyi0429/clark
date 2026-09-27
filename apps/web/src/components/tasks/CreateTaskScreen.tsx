"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUpRight } from "lucide-react";
import { FormField, TianshuPortalTheme } from "ts-design";
import { Button, Input, Label, ListBox, Select, TextField } from "ts-design/primitives";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import s from "./task-detail.module.css";

type Plan = components["schemas"]["MonthPlanResponse"];
const cards: [] = [];

/** clark CreateTaskPane：独立事项也是一个明确的归属选项。 */
export function CreateTaskScreen() {
  const workspace = useWorkspace();
  useRegisterDetail({ scope: "global", label: "开启执行事项", mark: null, cards });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [missionId, setMissionId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [doneDefinition, setDoneDefinition] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const clientId = useRef<string | null>(null);
  const change = (set: (value: string) => void, value: string) => { set(value); setError(""); clientId.current = null; };

  useEffect(() => {
    let live = true;
    void browserApi.GET("/api/me/plan").then(({ data }) => {
      if (!live) return;
      if (data) setPlan(data);
      else setError("暂时读不到个人任务，可先建独立事项。请稍后重试。");
    }).catch(() => { if (live) setError("暂时读不到个人任务，可先建独立事项。请稍后重试。"); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    if (startDate && dueDate && startDate > dueDate) return setError("计划开始不能晚于截止日期。");
    setBusy(true); setError("");
    clientId.current ??= crypto.randomUUID();
    try {
      const { data, error: failure } = await browserApi.POST("/api/me/tasks", { body: {
        clientId: clientId.current, title: title.trim(), missionId: missionId || null,
        ...(startDate ? { startDate } : {}), ...(dueDate ? { dueDate } : {}),
        ...(doneDefinition.trim() ? { doneDefinition: doneDefinition.trim() } : {}),
      } });
      if (data) { window.dispatchEvent(new Event("member-tasks-changed")); workspace.navigate(`/me/tasks/${encodeURIComponent(data.id)}`); }
      else setError(failure?.message ?? "没建成，请重试。输入已经保留。");
    } catch { setError("没建成，网络断了。输入已经保留，请重试。"); }
    finally { setBusy(false); }
  };

  return <DetailFrame title="开启执行事项" subtitle="我的工作台" onBack={workspace.close}>
    <form className={s.createForm} onSubmit={(event) => void submit(event)}>
      <p className={s.intro}>先选这件执行事项要推进的个人任务，再邀请同事协作。也可以作为独立事项开启。</p>
      <FormField label="执行事项标题" value={title} onChange={(value) => change(setTitle, value)} placeholder="用一句短话说清要完成的事" />
      <Select aria-label="所属个人任务" selectedKey={missionId || "independent"} onSelectionChange={(key) => change(setMissionId, key === "independent" ? "" : String(key))}>
        <Label>所属个人任务</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
        <Select.Popover><TianshuPortalTheme><ListBox><ListBox.Item id="independent" textValue="不挂个人任务（独立事项）">不挂个人任务（独立事项）<ListBox.ItemIndicator /></ListBox.Item>{plan?.editable ? plan.groups.filter((group) => group.missionId).map((group) => <ListBox.Item key={group.missionId} id={group.missionId!} textValue={group.title}>{group.title} · {group.battlefieldName}<ListBox.ItemIndicator /></ListBox.Item>) : null}</ListBox></TianshuPortalTheme></Select.Popover>
      </Select>
      {loading ? <p className={s.muted} role="status">正在读取个人任务…</p> : null}
      <div className={s.twoFields}>
        <TextField><Label>计划开始日期 · 可选</Label><Input type="date" value={startDate} onChange={(event) => change(setStartDate, event.target.value)} /></TextField>
        <TextField><Label>截止日期 · 可选</Label><Input type="date" value={dueDate} onChange={(event) => change(setDueDate, event.target.value)} /></TextField>
      </div>
      <FormField label="完成时应该留下什么 · 可选" value={doneDefinition} onChange={(value) => change(setDoneDefinition, value)} multiline rows={3} placeholder="例如：一页结论，以及支撑它的依据。" />
      {error ? <p className={s.error} role="alert">{error}</p> : null}
      <Button variant="primary" type="submit" isDisabled={busy || !title.trim()} className={s.submit}>{busy ? "正在开启…" : "开启执行事项"}<ArrowUpRight size={16} aria-hidden /></Button>
    </form>
  </DetailFrame>;
}
