"use client";

import { useMemo, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { ActionButton, FormField, StatusBadge, TianshuPortalTheme } from "ts-design";
import { Button, Input, Label, ListBox, Select, TextField, ToggleButton, ToggleButtonGroup } from "ts-design/primitives";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { useConfirm } from "@/components/ConfirmDialog";
import { monthDayTime } from "@/lib/companyTime";
import { TASK_STATUS } from "@/components/member/MemberTasks";
import { CollaboratorsDialog } from "./CollaboratorsDialog";
import s from "./task-detail.module.css";

type Detail = components["schemas"]["TaskDetailResponse"];
type Task = Detail["task"];
type Draft = { title: string; missionId: string; startDate: string; dueDate: string; doneDefinition: string; judgment: string };
const cards: [] = [];
const draftOf = (detail: Detail): Draft => ({ title: detail.task.title, missionId: detail.task.mission?.missionId ?? "", startDate: detail.task.startDate ?? "", dueDate: detail.task.dueDate ?? "", doneDefinition: detail.task.doneDefinition ?? "", judgment: detail.judgment ?? "" });
const dateLabel = (date: string | null) => date ? `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日` : null;

/** clark TaskPane：推进人编辑，协作者只能保存自己的私有批注。 */
export function TaskScreen({ initialDetail }: { initialDetail: Detail }) {
  const workspace = useWorkspace();
  const { ask, dialog } = useConfirm();
  const [detail, setDetail] = useState(initialDetail);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initialDetail));
  const [note, setNote] = useState(initialDetail.myNote ?? "");
  const [editing, setEditing] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnReason, setReturnReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const task = detail.task;
  const owner = detail.role === "owner";
  const missionOptions = task.mission && !detail.missionOptions.some((option) => option.missionId === task.mission?.missionId)
    ? [task.mission, ...detail.missionOptions] : detail.missionOptions;
  const group = useMemo(() => ({ kind: "task" as const, taskId: task.id, viewerId: workspace.viewerId ?? task.owner.personId, members: [task.owner, ...task.collaborators].map((person) => ({ personId: person.personId, displayName: person.name })) }), [task.id, task.owner, task.collaborators, workspace.viewerId]);
  useRegisterDetail({ scope: `task:${task.id}`, label: task.title, mark: null, cards, group });
  const set = (key: keyof Draft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const refresh = async () => {
    try {
      const { data } = await browserApi.GET("/api/me/tasks/{id}", { params: { path: { id: task.id } } });
      if (data) { setDetail(data); setDraft(draftOf(data)); setNote(data.myNote ?? ""); }
    } catch { /* 写入已成功；下次打开或刷新时读最新详情。 */ }
  };
  const failed = (failure: { message?: string; latestTask?: Task } | undefined, fallback: string) => {
    if (failure?.latestTask) setDetail((current) => ({ ...current, task: failure.latestTask! }));
    setError(failure?.latestTask ? "这件事刚被改过，请核对最新内容再保存。" : failure?.message ?? fallback);
  };
  const patch = async (body: Omit<components["schemas"]["PatchMyTaskRequest"], "version">, success: string) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await browserApi.PATCH("/api/me/tasks/{id}", { params: { path: { id: task.id } }, body: { version: task.version, ...body } });
      if (result.data) { setDetail((current) => ({ ...current, task: result.data!, ...(body.judgment !== undefined ? { judgment: body.judgment ?? null } : {}) })); setEditing(false); setNotice(success); window.dispatchEvent(new Event("member-tasks-changed")); await refresh(); }
      else failed(result.error as typeof result.error & { latestTask?: Task }, "没保存，请重试。输入已经保留。");
    } catch { setError("没保存，网络断了。输入已经保留，请重试。"); }
    finally { setBusy(false); }
  };
  const save = () => {
    if (!draft.title.trim()) return setError("请填写执行事项标题。");
    if (draft.startDate && draft.dueDate && draft.startDate > draft.dueDate) return setError("计划开始不能晚于截止日期。");
    const body: Omit<components["schemas"]["PatchMyTaskRequest"], "version"> = {};
    if (draft.title.trim() !== task.title) body.title = draft.title.trim();
    if ((draft.missionId || null) !== (task.mission?.missionId ?? null)) body.missionId = draft.missionId || null;
    if ((draft.startDate || null) !== task.startDate) body.startDate = draft.startDate || null;
    if ((draft.dueDate || null) !== task.dueDate) body.dueDate = draft.dueDate || null;
    if ((draft.doneDefinition.trim() || null) !== task.doneDefinition) body.doneDefinition = draft.doneDefinition.trim() || null;
    if (!Object.keys(body).length) { setEditing(false); return; }
    void patch(body, "已保存执行事项");
  };
  const saveNote = async () => {
    setBusy(true); setError("");
    try {
      const { data, error: failure } = await browserApi.PUT("/api/me/tasks/{id}/note", { params: { path: { id: task.id } }, body: { note: note.trim() || null } });
      if (data) { setDetail((current) => ({ ...current, myNote: data.myNote, myNoteAt: data.myNote ? new Date().toISOString() : null })); setNotice("已保存我的批注"); }
      else setError(failure?.message ?? "批注没保存，请重试。");
    } catch { setError("批注没保存，请重试。"); }
    finally { setBusy(false); }
  };
  const returnTask = async () => {
    if (!returnReason.trim()) return setError("请填写退回原因。");
    if (!await ask(`退回执行事项「${task.title}」？`, "退回执行事项")) return;
    setBusy(true); setError("");
    try {
      const { data, error: failure } = await browserApi.POST("/api/me/tasks/{id}/return", { params: { path: { id: task.id } }, body: { version: task.version, reason: returnReason.trim() } });
      if (data) { setReturnOpen(false); setNotice("已退回执行事项"); window.dispatchEvent(new Event("member-tasks-changed")); await refresh(); }
      else failed(failure as typeof failure & { latestTask?: Task }, "没退回，请重试。");
    } catch { setError("没退回，网络断了，请重试。"); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!await ask(`删除执行事项「${task.title}」？删除后无法找回。`, "删除执行事项")) return;
    setBusy(true); setError("");
    try {
      const { response, error: failure } = await browserApi.DELETE("/api/me/tasks/{id}", { params: { path: { id: task.id }, query: { version: task.version } } });
      if (response.status === 204) { window.dispatchEvent(new Event("member-tasks-changed")); workspace.navigate("/me"); }
      else failed(failure as typeof failure & { latestTask?: Task }, "没删除，请重试。");
    } catch { setError("没删除，网络断了，请重试。"); }
    finally { setBusy(false); }
  };
  return <>
    <DetailFrame title={task.title} subtitle="执行事项" onBack={workspace.close} actions={owner ? <Button variant="ghost" onPress={() => { setEditing((value) => !value); setError(""); }}>编辑</Button> : undefined}>
      <div className={s.taskPane}><div className={s.pane}>
        <section className={s.paneBlock}>
          <div className={s.paneRow}>{task.mission ? <Button variant="ghost" className={s.longLink} onPress={() => workspace.navigate(`/me/mission-cards/${encodeURIComponent(task.mission!.cardId)}`)}>{task.mission.title}<ArrowUpRight size={15} aria-hidden /></Button> : <StatusBadge tone="info"><span className={s.sourceBadge}>{task.source === "meeting" ? `会后分派 · ${task.origin?.meetingTitle ?? "独立事项"}` : "独立事项"}</span></StatusBadge>}<StatusBadge tone={task.status === "done" ? "success" : "info"}>{TASK_STATUS[task.status]}</StatusBadge></div>
          <p className={s.paneNote}>{task.mission?.battlefieldName ?? "未关联战场"} · {owner ? "你在推进" : `${task.owner.name}在推进`}{task.mission ? ` · 第 ${task.mission.step} 步，共 ${task.mission.steps} 步` : ""}</p>
          {task.waitingOn ? <p className={s.paneNote}>等上一步：{task.waitingOn.title}</p> : null}
        </section>
        <div className={s.paneRow}><span className={s.paneNote}>{task.dueDate ? `${dateLabel(task.dueDate)}前完成` : "截止日期待定"} · 参与：{[task.owner, ...task.collaborators].map((person) => person.name).join("、")}</span>{owner ? <Button variant="secondary" onPress={() => setInviteOpen(true)}>邀请协作</Button> : null}</div>
        {task.startDate ? <p className={s.paneNote}>计划开始 {dateLabel(task.startDate)}</p> : null}
        {editing && owner ? <section className={s.paneBlock}><h3>编辑执行事项</h3>
          <FormField label="执行事项标题" value={draft.title} onChange={(value) => set("title", value)} />
          <Select aria-label="所属个人任务" selectedKey={draft.missionId || "independent"} onSelectionChange={(key) => set("missionId", key === "independent" ? "" : String(key))}><Label>所属个人任务</Label><Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger><Select.Popover><TianshuPortalTheme><ListBox><ListBox.Item id="independent" textValue="不挂个人任务（独立事项）">不挂个人任务（独立事项）<ListBox.ItemIndicator /></ListBox.Item>{missionOptions.map((option) => <ListBox.Item key={option.missionId} id={option.missionId} textValue={option.title}>{option.title} · {option.battlefieldName}<ListBox.ItemIndicator /></ListBox.Item>)}</ListBox></TianshuPortalTheme></Select.Popover></Select>
          <div className={s.twoFields}><TextField><Label>计划开始日期 · 可选</Label><Input type="date" value={draft.startDate} onChange={(event) => set("startDate", event.target.value)} /></TextField><TextField><Label>截止日期 · 可选</Label><Input type="date" value={draft.dueDate} onChange={(event) => set("dueDate", event.target.value)} /></TextField></div>
          <FormField label="完成时应该留下什么 · 可选" value={draft.doneDefinition} onChange={(value) => set("doneDefinition", value)} multiline rows={3} />
          <div className={s.paneRow}><ActionButton intent="secondary" isDisabled={busy} onPress={save}>保存</ActionButton><Button variant="ghost" onPress={() => { setDraft(draftOf(detail)); setEditing(false); }}>取消</Button></div>
        </section> : null}
        <section className={s.paneBlock}><h3>完成时留下什么</h3><p className={task.doneDefinition ? undefined : s.paneNote}>{task.doneDefinition ?? "还没有写完成定义。"}</p></section>
        <section className={s.paneBlock}><h3>{owner ? "这件事的判断" : "这件事的判断（推进人写的）"}</h3>
          <p className={detail.judgment ? undefined : s.paneNote}>{detail.judgment ?? (owner ? "还没写过。写下来之后，别人打开这件事看到的就是这一句。" : `${task.owner.name}还没写过。`)}</p>
          {detail.judgment && detail.judgmentAt ? <p className={s.paneNote}>{owner ? "你" : task.owner.name}写于 {monthDayTime(detail.judgmentAt)}</p> : null}
          <div className={s.separator} />
          {owner ? <><FormField label="写下这件事的判断" value={draft.judgment} onChange={(value) => set("judgment", value)} multiline rows={3} /><div className={s.paneRow}><ActionButton intent="secondary" isDisabled={busy} onPress={() => void patch({ judgment: draft.judgment.trim() || null }, "已保存这件事的判断")}>保存</ActionButton></div></> : <><FormField label="我的批注（只属于你，不覆盖这件事的判断）" value={note} onChange={setNote} multiline rows={3} /><div className={s.paneRow}><ActionButton intent="secondary" isDisabled={busy} onPress={() => void saveNote()}>保存</ActionButton>{detail.myNote && detail.myNoteAt ? <span className={s.paneNote}>上次写于 {monthDayTime(detail.myNoteAt)}</span> : null}</div></>}
        </section>
        <section className={s.paneBlock}><h3>报进度</h3>{owner && task.status !== "returned" ? <><p className={s.paneNote}>进度只认推进人自报。没报过是「还没报」，不是 0%。</p><ToggleButtonGroup selectionMode="single" disallowEmptySelection selectedKeys={[task.status]} aria-label="报进度" onSelectionChange={(keys) => { const next = [...keys][0]; if (next === "not_started" || next === "in_progress" || next === "done") void patch({ status: next }, "状态已更新"); }}>{(["not_started", "in_progress", "done"] as const).map((status) => <ToggleButton key={status} id={status} isDisabled={busy}>{TASK_STATUS[status]}</ToggleButton>)}</ToggleButtonGroup>{task.source === "meeting" ? <><Button variant="ghost" onPress={() => setReturnOpen((open) => !open)}>退回</Button>{returnOpen ? <div className={s.returnForm}><FormField label="退回原因" value={returnReason} onChange={setReturnReason} multiline rows={2} /><ActionButton intent="secondary" isDisabled={busy || !returnReason.trim()} onPress={() => void returnTask()}>确认退回</ActionButton></div> : null}</> : null}</> : <p className={s.paneNote}>{task.status === "returned" ? `这件事已退回。${task.returnReason ? `原因：${task.returnReason}` : ""}` : `这件事由${task.owner.name}推进，进度只认他自报的。你的看法写在上面的批注里。`}</p>}</section>
        {task.origin ? <section className={s.paneBlock}><h3>会议来源</h3><p>{task.origin.meetingTitle}</p>{task.origin.quote ? <blockquote>{task.origin.quote}</blockquote> : null}</section> : null}
        {owner && task.status === "not_started" && (task.source === "self" || task.source === "plan") ? <div className={s.paneRow}><Button variant="ghost" isDisabled={busy} onPress={() => void remove()}>删除执行事项</Button></div> : null}
        {error ? <p className={s.error} role="alert">{error}</p> : null}{notice ? <p className={s.notice} role="status">{notice}</p> : null}
      </div></div>
    </DetailFrame>
    <CollaboratorsDialog taskId={task.id} options={detail.collaboratorOptions} isOpen={inviteOpen} onClose={() => setInviteOpen(false)} onAdded={() => void refresh()} />
    {dialog}
  </>;
}
