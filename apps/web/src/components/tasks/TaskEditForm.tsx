"use client";

import { useEffect, useRef, useState } from "react";
import { ActionButton, FormField, TianshuPortalTheme } from "ts-design";
import { Button, Input, Label, ListBox, Select, TextField } from "ts-design/primitives";
import type { components } from "@/lib/api/schema";
import { usePlanTasks } from "./usePlanTasks";
import s from "./task-detail.module.css";

type Detail = components["schemas"]["TaskDetailResponse"];
export type TaskPatch = Omit<components["schemas"]["PatchMyTaskRequest"], "version">;
type Draft = { title: string; missionId: string; planTaskId: string; startDate: string; dueDate: string; doneDefinition: string; judgment: string };
const draftOf = (detail: Detail): Draft => ({ title: detail.task.title, missionId: detail.task.mission?.missionId ?? "", planTaskId: detail.task.planTaskId ?? "", startDate: detail.task.startDate ?? "",
  dueDate: detail.task.dueDate ?? "", doneDefinition: detail.task.doneDefinition ?? "", judgment: detail.judgment ?? "" });

/**
 * ⋯ → 编辑（推进人）：标题、所属个人任务、挂到哪个 Task（这个 Mission 有 Task 时）、日期、完成标准、这件事的判断。
 * 只把这张表单里改过的字段交给保存（和打开时比）：别处同时改了别的字段，不会被表单里的旧值盖回去。
 */
export function TaskEditForm({ detail, busy, onSave, onCancel }: { detail: Detail; busy: boolean; onSave: (body: TaskPatch) => void; onCancel: () => void }) {
  const [opened] = useState<Draft>(() => draftOf(detail));
  const [draft, setDraft] = useState<Draft>(opened);
  const [error, setError] = useState("");
  const root = useRef<HTMLElement>(null);
  const task = detail.task;
  const missionOptions = task.mission && !detail.missionOptions.some((option) => option.missionId === task.mission?.missionId)
    ? [task.mission, ...detail.missionOptions] : detail.missionOptions;
  const planTasks = usePlanTasks();
  const taskOptions = draft.missionId ? planTasks.filter((option) => option.missionId === draft.missionId) : [];
  useEffect(() => { root.current?.scrollIntoView({ block: "nearest" }); }, []);
  const set = (key: keyof Draft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const save = () => {
    if (!draft.title.trim()) return setError("请填写执行事项标题。");
    if (draft.startDate && draft.dueDate && draft.startDate > draft.dueDate) return setError("计划开始不能晚于截止日期。");
    setError("");
    const body: TaskPatch = {};
    if (draft.title.trim() !== opened.title.trim()) body.title = draft.title.trim();
    if (draft.missionId !== opened.missionId) body.missionId = draft.missionId || null;
    if (draft.planTaskId !== opened.planTaskId) body.planTaskId = draft.planTaskId || null;
    if (draft.startDate !== opened.startDate) body.startDate = draft.startDate || null;
    if (draft.dueDate !== opened.dueDate) body.dueDate = draft.dueDate || null;
    if (draft.doneDefinition.trim() !== opened.doneDefinition.trim()) body.doneDefinition = draft.doneDefinition.trim() || null;
    if (draft.judgment.trim() !== opened.judgment.trim()) body.judgment = draft.judgment.trim() || null;
    if (!Object.keys(body).length) return onCancel();
    onSave(body);
  };
  return <section ref={root} className={s.paneBlock} aria-label="编辑执行事项">
    <h3>编辑执行事项</h3>
    <FormField label="执行事项标题" value={draft.title} onChange={(value) => set("title", value)} />
    {/* 换了 Mission，选过的 Task 就不算了。 */}
    <Select aria-label="所属个人任务" selectedKey={draft.missionId || "independent"} onSelectionChange={(key) => setDraft((current) => ({ ...current, missionId: key === "independent" ? "" : String(key), planTaskId: "" }))}>
      <Label>所属个人任务</Label>
      <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
      <Select.Popover><TianshuPortalTheme><ListBox>
        <ListBox.Item id="independent" textValue="不挂个人任务（独立事项）">不挂个人任务（独立事项）<ListBox.ItemIndicator /></ListBox.Item>
        {missionOptions.map((option) => <ListBox.Item key={option.missionId} id={option.missionId} textValue={option.title}>{option.title} · {option.battlefieldName}<ListBox.ItemIndicator /></ListBox.Item>)}
      </ListBox></TianshuPortalTheme></Select.Popover>
    </Select>
    {taskOptions.length ? <Select aria-label="挂到 Task" selectedKey={taskOptions.some((option) => option.taskId === draft.planTaskId) ? draft.planTaskId : "none"}
      onSelectionChange={(key) => set("planTaskId", key === "none" ? "" : String(key))}>
      <Label>挂到 Task</Label>
      <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
      <Select.Popover><TianshuPortalTheme><ListBox>
        <ListBox.Item id="none" textValue="不挂">不挂<ListBox.ItemIndicator /></ListBox.Item>
        {taskOptions.map((option) => <ListBox.Item key={option.taskId} id={option.taskId} textValue={option.name}>{option.name}<ListBox.ItemIndicator /></ListBox.Item>)}
      </ListBox></TianshuPortalTheme></Select.Popover>
    </Select> : null}
    <div className={s.twoFields}>
      <TextField><Label>计划开始日期 · 可选</Label><Input type="date" value={draft.startDate} onChange={(event) => set("startDate", event.target.value)} /></TextField>
      <TextField><Label>截止日期 · 可选</Label><Input type="date" value={draft.dueDate} onChange={(event) => set("dueDate", event.target.value)} /></TextField>
    </div>
    <FormField label="完成标准 · 可选" value={draft.doneDefinition} onChange={(value) => set("doneDefinition", value)} multiline rows={3} maxLength={500} />
    <FormField label="这件事的判断 · 可选" value={draft.judgment} onChange={(value) => set("judgment", value)} multiline rows={2} maxLength={2000} />
    <div className={s.paneRow}>
      <ActionButton intent="secondary" isDisabled={busy} onPress={save}>保存</ActionButton>
      <Button variant="ghost" onPress={onCancel}>取消</Button>
      {error ? <span className={s.error} role="alert">{error}</span> : null}
    </div>
  </section>;
}
