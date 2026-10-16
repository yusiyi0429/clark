"use client";

import { useState } from "react";
import { Modal } from "@heroui/react";
import { CalendarPlus, Ellipsis, Trash2 } from "lucide-react";
import { TianshuPortalTheme } from "ts-design";
import { Button, Popover } from "ts-design/primitives";
import type { Card, CardAction } from "@/lib/api/client";
import { ActionFeedback, useCardAction } from "@/lib/useCardAction";
import { refreshWorkspace, showWorkspaceToast } from "@/lib/toast";
import { Select } from "@/components/ui/Select";
import t from "@/styles/material-tabs.module.css";
import c from "@/styles/confirm-dialog.module.css";
import m from "@/styles/issue-more.module.css";

/**
 * 议题页页头的「更多 ⋯」（一号位视角）：低频、有分量的动作收在这里，页面正文里不再有「决策路径」「移出决策面」两节。
 * - 加入已有会议…：弹层里用统一的 Select 选一场待开的会议再确认，沿用 issue.join_meeting 与「已加入…」提示。
 * - 移出议题…：确认对话框，说明可恢复、必填原因，确认钮危险色，取消是默认焦点。
 * 「安排一场会议」不在一号位议题页（创建会议不是一号位该做的事）。菜单用材料菜单同一套 Popover 与样式，触屏 / 手持 ≥44。
 */

export type MoreMenuEntry = { id: "join" | "dismiss"; label: string };

/** 菜单里有哪几项：只看这张卡带不带对应 Action；议题不在待处理时一项都没有（整颗按钮不出现）。 */
export function moreMenuEntries(card: Pick<Card, "actions">, pendingIssue: boolean): MoreMenuEntry[] {
  if (!pendingIssue) return [];
  const has = (type: string) => card.actions.some((action) => action.actionType === type);
  return [
    ...(has("issue.join_meeting") ? [{ id: "join" as const, label: "加入已有会议…" }] : []),
    ...(has("issue.dismiss") ? [{ id: "dismiss" as const, label: "移出议题…" }] : []),
  ];
}

export const DISMISS_NOTE = "移出后不再出现在决策面，可在已处理中恢复。";

/** 菜单项（Popover 里的内容；单独导出便于不开浮层就能校验）。 */
export function MoreMenuList({ entries, onPick }: { entries: MoreMenuEntry[]; onPick: (id: MoreMenuEntry["id"]) => void }) {
  return (
    <>
      {entries.map((entry) => (
        <Button key={entry.id} variant="ghost" className={`${t.item} ${m.row}`} onPress={() => onPick(entry.id)}>
          {entry.id === "join" ? <CalendarPlus size={15} strokeWidth={1.8} aria-hidden /> : <Trash2 size={15} strokeWidth={1.8} aria-hidden />}
          <span className={t.label}>{entry.label}</span>
        </Button>
      ))}
    </>
  );
}

/** 「加入已有会议」弹层内容：统一 Select 选会议，确认前不提交。 */
export function JoinDialogContent({ options, value, onChange, pending, onCancel, onConfirm }: {
  options: { value: string; label: string }[]; value: string; onChange: (value: string) => void;
  pending: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <>
      <Modal.Header><Modal.Heading>加入已有会议</Modal.Heading></Modal.Header>
      <Modal.Body>
        <p className={m.lead}>把这个议题加入一场待开的会议，会上一并讨论。</p>
        <Select aria-label="选择会议" placeholder={options.length ? "选择一场待开的会议" : "暂时没有待开的会议"} value={value} onChange={onChange}
          options={options} disabled={!options.length} />
      </Modal.Body>
      <Modal.Footer>
        <Button variant="secondary" onPress={onCancel}>取消</Button>
        <Button variant="primary" isDisabled={pending || !value} onPress={onConfirm}>{pending ? "正在加入…" : "加入会议"}</Button>
      </Modal.Footer>
    </>
  );
}

/** 「移出议题」确认内容：说明可恢复、必填原因、危险色确认钮；取消是默认焦点。 */
export function DismissDialogContent({ reason, onReason, pending, onCancel, onConfirm }: {
  reason: string; onReason: (value: string) => void; pending: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <>
      <h2 id="issue-dismiss-title" className={m.title}>移出这个议题？</h2>
      <p className={c.text}>{DISMISS_NOTE}</p>
      <label className={m.field}>
        <span>原因（必填）</span>
        <input value={reason} maxLength={200} required placeholder="例如：已在别处解决" aria-label="移出原因" onChange={(event) => onReason(event.target.value)} />
      </label>
      <div className={c.actions}>
        <Button variant="tertiary" autoFocus onPress={onCancel}>取消</Button>
        <Button variant="danger" isDisabled={pending || !reason.trim()} onPress={onConfirm}>{pending ? "正在移出…" : "移出议题"}</Button>
      </div>
    </>
  );
}

export function IssueMoreMenu({ card, onCard, pendingIssue, scheduledMeetings }: {
  card: Card; onCard: (card: Card) => void; pendingIssue: boolean; scheduledMeetings: Card[];
}) {
  const entries = moreMenuEntries(card, pendingIssue);
  const { state, run, retry, reset, pending } = useCardAction(onCard);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<MoreMenuEntry["id"] | null>(null);
  const [meetingId, setMeetingId] = useState("");
  const [reason, setReason] = useState("");
  if (!entries.length) return null;
  const actionOf = (type: string): CardAction | undefined => card.actions.find((action) => action.actionType === type);

  const pick = (id: MoreMenuEntry["id"]) => { setOpen(false); reset(); setMeetingId(""); setReason(""); setDialog(id); };
  const close = () => { setDialog(null); reset(); };
  const join = async () => {
    const action = actionOf("issue.join_meeting");
    if (!action || !meetingId) return;
    const target = scheduledMeetings.find((option) => option.objectRef.id === meetingId);
    const joined = await run(action, { meetingId });
    if (!joined) return;
    close();
    showWorkspaceToast({ text: `已加入「${target?.title ?? joined.title}」` });
    refreshWorkspace();
  };
  const dismiss = async () => {
    const action = actionOf("issue.dismiss");
    if (!action || !reason.trim()) return;
    const next = await run(action, { reason: reason.trim() });
    if (!next) return;
    close();
    showWorkspaceToast({ text: "已移出议题，可在已处理中恢复" });
    refreshWorkspace();
  };

  return (
    <>
      <Popover isOpen={open} onOpenChange={setOpen}>
        <Button variant="ghost" className={m.more} aria-label="更多操作">
          <Ellipsis size={18} strokeWidth={1.8} aria-hidden />
        </Button>
        <Popover.Content placement="bottom end" offset={6} className={t.popover}>
          <TianshuPortalTheme>
            <Popover.Dialog aria-label="议题的更多操作" className={`${t.menu} ${m.list}`}>
              <MoreMenuList entries={entries} onPick={pick} />
            </Popover.Dialog>
          </TianshuPortalTheme>
        </Popover.Content>
      </Popover>
      <Modal isOpen={dialog === "join"} onOpenChange={(next) => { if (!next) close(); }}>
        <Modal.Backdrop isDismissable>
          <Modal.Container>
            <Modal.Dialog className={m.joinDialog} aria-label="加入已有会议">
              <Modal.CloseTrigger aria-label="关闭" />
              <JoinDialogContent options={scheduledMeetings.map((option) => ({ value: option.objectRef.id, label: option.title }))}
                value={meetingId} onChange={setMeetingId} pending={pending} onCancel={close} onConfirm={() => void join()} />
              <ActionFeedback state={state} onRetry={retry} />
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
      <Modal isOpen={dialog === "dismiss"} onOpenChange={(next) => { if (!next) close(); }}>
        <Modal.Backdrop className={c.backdrop} isDismissable>
          <Modal.Container size="sm">
            <Modal.Dialog className={c.dialog} role="alertdialog" aria-labelledby="issue-dismiss-title">
              <DismissDialogContent reason={reason} onReason={setReason} pending={pending} onCancel={close} onConfirm={() => void dismiss()} />
              <ActionFeedback state={state} onRetry={retry} />
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  );
}
