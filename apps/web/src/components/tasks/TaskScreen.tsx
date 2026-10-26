"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Check, Ellipsis, Pencil, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { TianshuPortalTheme } from "ts-design";
import { Button, Label, Popover, TextArea, TextField } from "ts-design/primitives";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { useConfirm } from "@/components/ConfirmDialog";
import { MenuDialog } from "@/components/AccountMenu";
import { ObjectMaterialArea } from "@/components/materials/ObjectMaterialArea";
import { CollaboratorsDialog } from "./CollaboratorsDialog";
import { TaskCover } from "./TaskCover";
import { TaskEditForm, type TaskPatch } from "./TaskEditForm";
import { AcceptDialog } from "./AcceptDialog";
import { UnplacedActions } from "./Unplaced";
import s from "./task-detail.module.css";
import c from "./task-cover.module.css";
import t from "@/styles/material-tabs.module.css";

type Detail = components["schemas"]["TaskDetailResponse"];
type Task = Detail["task"];
const cards: [] = [];
const COVER = "task";

/** 页头那一段状态：「等你验收」不是状态，是外部工具交了、推进人还没处理；协作者看到的是「待验收」。 */
function taskStatus(task: Task, owner: boolean): { tone: "idle" | "active" | "done" | "returned"; label: string } {
  if (task.status === "done") return { tone: "done", label: "完成" };
  if (task.status === "returned") return { tone: "returned", label: "已退回" };
  if (task.awaitingAcceptance) return { tone: "active", label: owner ? "等你验收" : "待验收" };
  return task.status === "in_progress" ? { tone: "active", label: "进行中" } : { tone: "idle", label: "未启动" };
}

/**
 * 执行事项详情就是这件事的「封面」（design-12）：页头写状态，右边材料下拉、验收、⋯；正文是封面（TaskCover）。
 * 状态跟着推进人的动作在服务端自动走，完成只能经推进人验收；页面只读、只发请求，不做状态迁移。
 */
export function TaskScreen({ initialDetail }: { initialDetail: Detail }) {
  const workspace = useWorkspace();
  const { ask, dialog } = useConfirm();
  const [detail, setDetail] = useState(initialDetail);
  const [editing, setEditing] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [acceptOpen, setAcceptOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [materialTab, setMaterialTab] = useState(COVER);
  const task = detail.task;
  const owner = detail.role === "owner";
  const done = task.status === "done";
  const acceptable = owner && task.status !== "done" && task.status !== "returned";
  const group = useMemo(() => ({ kind: "task" as const, taskId: task.id, viewerId: workspace.viewerId ?? task.owner.personId, members: [task.owner, ...task.collaborators].map((person) => ({ personId: person.personId, displayName: person.name })) }), [task.id, task.owner, task.collaborators, workspace.viewerId]);
  useRegisterDetail({ scope: `task:${task.id}`, label: task.title, mark: null, cards, group });
  /** 重读这件事。读不到返回 false：写入已经成功，下次打开或刷新时就是最新的。 */
  const refresh = async () => {
    try {
      const { data } = await browserApi.GET("/api/me/tasks/{id}", { params: { path: { id: task.id } } });
      if (!data) return false;
      setDetail(data);
      return true;
    } catch { return false; }
  };
  // 通知里的「等你验收」带 ?accept=1 打开：直接弹出验收，地址里的参数随即去掉（刷新不再弹）。
  // 这一页已经开着时再点那条通知，路由不会重新挂载这一页，所以跟着地址里的参数走，不只在打开时看一次。
  // 首页验收窗里「写完成标准」带 ?edit=1 打开：直接展开编辑表单，参数同样随即去掉。
  const params = useSearchParams();
  const acceptLink = params?.get("accept") === "1";
  const editLink = params?.get("edit") === "1";
  useEffect(() => {
    if (!acceptLink && !editLink) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("accept");
    url.searchParams.delete("edit");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    if (acceptLink && acceptable) setAcceptOpen(true);
    if (editLink && owner) setEditing(true);
    // 只响应参数出现的那一下。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acceptLink, editLink]);
  const failed = (failure: { message?: string; latestTask?: Task } | undefined, fallback: string) => {
    if (failure?.latestTask) { setDetail((current) => ({ ...current, task: failure.latestTask! })); void refresh(); }
    setError(failure?.latestTask ? "这件事刚被改过，请核对最新内容再保存。" : failure?.message ?? fallback);
  };
  const changed = (message: string) => { setNotice(message); window.dispatchEvent(new Event("member-tasks-changed")); void refresh(); };
  const patch = async (body: TaskPatch) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await browserApi.PATCH("/api/me/tasks/{id}", { params: { path: { id: task.id } }, body: { version: task.version, ...body } });
      if (result.data) { setEditing(false); changed("已保存"); }
      else failed(result.error as typeof result.error & { latestTask?: Task }, "没保存，请重试。输入已经保留。");
    } catch { setError("没保存，网络断了。输入已经保留，请重试。"); }
    finally { setBusy(false); }
  };
  const returnTask = async (reason: string): Promise<string | null> => {
    if (!await ask(`退回执行事项「${task.title}」？`, "退回执行事项")) return null;
    try {
      const { data, error: failure } = await browserApi.POST("/api/me/tasks/{id}/return", { params: { path: { id: task.id } }, body: { version: task.version, reason } });
      if (data) { setReturnOpen(false); changed("已退回执行事项"); return null; }
      if ((failure as { latestTask?: Task } | undefined)?.latestTask) void refresh();
      return failure?.message ?? "没退回，请重试。";
    } catch { return "没退回，网络断了，请重试。"; }
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
  const reopen = async () => {
    if (!await ask(`重新打开「${task.title}」？验收记录会清掉，状态回到进行中。`, "重新打开")) return;
    setBusy(true); setError("");
    try {
      const { data, error: failure } = await browserApi.POST("/api/me/tasks/{id}/reopen", { params: { path: { id: task.id } }, body: { version: task.version } });
      if (data) changed("已重新打开");
      else failed(failure as typeof failure & { latestTask?: Task }, "没重新打开，请重试。");
    } catch { setError("没重新打开，网络断了，请重试。"); }
    finally { setBusy(false); }
  };
  const status = taskStatus(task, owner);
  const deletable = task.status === "not_started" && task.source !== "meeting";
  return <div className={c.screen}>
    <DetailFrame title={task.title} subtitle="执行事项" onBack={workspace.close} actions={<>
      <span data-task-status className={c.status} data-tone={status.tone}>
        <span className={c.statusDot} aria-hidden /><span className={c.statusText}>{status.label}</span>
      </span>
      {owner ? <div data-task-actions className={c.headerActions}>
        {acceptable ? <Button variant={task.awaitingAcceptance ? "primary" : "ghost"} className={task.awaitingAcceptance ? c.acceptSolid : c.acceptQuiet}
          onPress={() => setAcceptOpen(true)}><Check size={15} strokeWidth={2} aria-hidden />验收</Button> : null}
        <MoreMenu items={[
          ...(acceptable ? [{ id: "accept", label: task.awaitingAcceptance ? "验收（外部工具已提交）" : "验收", icon: <Check size={15} strokeWidth={2} aria-hidden />, phoneOnly: true, run: () => setAcceptOpen(true) }] : []),
          { id: "edit", label: "编辑", icon: <Pencil size={15} strokeWidth={1.8} aria-hidden />, run: () => { setEditing(true); setError(""); } },
          ...(task.source === "meeting" && task.status !== "returned" && task.status !== "done" ? [{ id: "return", label: "退回", icon: <Undo2 size={15} strokeWidth={1.8} aria-hidden />, run: () => setReturnOpen(true) }] : []),
          ...(done ? [{ id: "reopen", label: "重新打开", icon: <RotateCcw size={15} strokeWidth={1.8} aria-hidden />, run: () => void reopen() }] : []),
          ...(deletable ? [{ id: "delete", label: "删除", icon: <Trash2 size={15} strokeWidth={1.8} aria-hidden />, danger: true, run: () => void remove() }] : []),
        ]} disabled={busy} />
      </div> : null}
    </>}>
      <ObjectMaterialArea objectType="task" objectId={task.id} baseTabs={[{ id: COVER, label: "预览", title: "预览" }]}
        selected={materialTab} onSelect={setMaterialTab} links onDraft={() => workspace.compose("帮我在这件事里起草一份：")}
        deliverables={done && detail.acceptance ? detail.acceptance.deliverableMaterialIds : null} onChanged={() => void refresh()}>
        {(area) => <>
          <TaskCover detail={detail} area={area} onEdit={() => setEditing(true)} onInvite={() => setInviteOpen(true)}
            unplaced={owner && task.unplaced ? <UnplacedActions task={task} missions={detail.missionOptions} onDone={() => { setNotice("已处理"); void refresh(); }} /> : null}
            onProgress={(entry) => { setDetail((current) => ({ ...current, progress: [entry, ...current.progress.filter((item) => item.id !== entry.id)].slice(0, 50) })); void refresh(); }}
            editor={editing && owner ? <TaskEditForm detail={detail} busy={busy} onSave={(body) => void patch(body)} onCancel={() => { setEditing(false); setError(""); }} /> : null} />
          {error || notice ? <div className={s.taskPane} role={error ? "alert" : "status"}><div className={s.pane}>
            {error ? <p className={s.error}>{error}</p> : <p className={s.notice}>{notice}</p>}
          </div></div> : null}
          {acceptOpen ? <AcceptDialog detail={detail} materials={area.materials} onClose={() => setAcceptOpen(false)} onStale={() => void refresh()}
            onOpenMaterial={(id) => area.open(id)} onEditStandards={() => { setEditing(true); setError(""); }}
            onDone={async (next, accepted) => {
              if (!await refresh()) setDetail((current) => ({ ...current, task: next }));
              setAcceptOpen(false); setNotice(accepted ? "已验收，这件事完成了" : "已退回，接着做");
            }} /> : null}
        </>}
      </ObjectMaterialArea>
    </DetailFrame>
    <CollaboratorsDialog taskId={task.id} options={detail.collaboratorOptions} isOpen={inviteOpen} onClose={() => setInviteOpen(false)} onAdded={() => void refresh()} />
    {returnOpen ? <ReturnDialog onClose={() => setReturnOpen(false)} onSubmit={returnTask} /> : null}
    {dialog}
  </div>;
}

type MoreItem = { id: string; label: string; icon: ReactNode; run: () => void; danger?: boolean; phoneOnly?: boolean };

/** 页头 ⋯：推进人的低频动作（编辑、退回、删除、重新打开；手机上验收也在这里）。下拉单和材料下拉同一种毛玻璃。 */
function MoreMenu({ items, disabled }: { items: MoreItem[]; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  return <Popover isOpen={open} onOpenChange={setOpen}>
    <Button variant="ghost" isIconOnly className={c.more} aria-label="更多" isDisabled={disabled}><Ellipsis size={18} aria-hidden /></Button>
    <Popover.Content placement="bottom end" offset={6} className={`${t.popover} ${c.moreMenu}`}>
      <TianshuPortalTheme>
        <Popover.Dialog className={t.menu} aria-label="更多">
          {items.map((item) => <Button key={item.id} variant="ghost" className={`${t.item}${item.danger ? ` ${c.danger}` : ""}${item.phoneOnly ? ` ${c.phoneOnly}` : ""}`}
            onPress={() => { setOpen(false); item.run(); }}>
            {item.icon}<span className={t.label}>{item.label}</span>
          </Button>)}
        </Popover.Dialog>
      </TianshuPortalTheme>
    </Popover.Content>
  </Popover>;
}

/** 退回（会后分派的事项）：写原因，主持人会收到提醒。 */
function ReturnDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (reason: string) => Promise<string | null> }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true); setError("");
    const failure = await onSubmit(reason.trim());
    setBusy(false);
    if (failure) setError(failure);
  };
  return <MenuDialog title="退回执行事项" onClose={onClose}>
    <form className={s.returnForm} onSubmit={(event) => { event.preventDefault(); if (reason.trim()) void submit(); }}>
      <TextField value={reason} onChange={setReason} maxLength={200} autoFocus>
        <Label>退回原因</Label>
        <TextArea rows={3} placeholder="比如：会上没这么定" />
      </TextField>
      {error ? <p className={s.error} role="alert">{error}</p> : null}
      <Button variant="primary" type="submit" isDisabled={busy || !reason.trim()}>退回，告诉主持人</Button>
    </form>
  </MenuDialog>;
}
