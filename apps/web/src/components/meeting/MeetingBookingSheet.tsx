"use client";

/**
 * 约会议（FR-4.1）：顶栏或首页「约会议」打开的右侧浮出面板（SidePanel，形状同通知栏），页头和二级页同一个（DetailFrame）。
 * 外壳一直挂着它、每次打开换一个 key：表单从空白开始，关时面板能原路滑出。
 * 名称、日期 + 起止、主持人（成员只能是本人，CEO 从 DRI 里选）、参会人（可空）、挂到（一个）。
 * 挂到：选项到了就默认挂上自己本月的第一个 Mission（没有就空着、直接展开去挑），收起时一行写着挂点和「我的 Mission / PO …」，右边「换」；
 * 换的时候是 WorldAnchorPicker，挑了 Mission、LTO 就收起，挑了 PO 不收（下面展开它的 Mission 可以再往下挑）。
 * 「约好」建会（只存天枢，不写本体），成功后跳到会议页。
 */
import { useEffect, useState } from "react";
import type { TPickedWorldAnchor, TWorldAnchor, TWorldAnchorOption } from "@warmap/contracts";
import { COMPANY_TIMEZONE } from "@/lib/companyTime";
import { refreshWorkspace } from "@/lib/toast";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { DatePicker } from "@/components/ui/DatePicker";
import { Select } from "@/components/ui/Select";
import { SidePanel } from "@/components/ui/SidePanel";
import { timeOptions } from "@/components/ui/pickerFormat";
import { bookMeeting, listPeople, listPersonDirectory, listWorldAnchorOptions, type DirectoryPerson } from "./meetingDecisionApi";
import { anchorRole, WorldAnchorPicker } from "./WorldAnchorPicker";
import d from "./meeting-decisions.module.css";

const BOOK_ERROR: Record<string, string> = { ANCHOR_NOT_FOUND: "挂点已失效", FORBIDDEN: "没有权限", INVALID_LEAD_DRI: "主持人不可选", INVALID_PARTICIPANT: "参会人不可选" };
const pad = (value: number) => String(value).padStart(2, "0");

/** 默认下一个整点开、开一小时（公司时区）。 */
function nextSlot(now = new Date()): { date: string; start: string; end: string } {
  const at = new Date(now.getTime() + 3_600_000);
  const date = at.toLocaleDateString("sv-SE", { timeZone: COMPANY_TIMEZONE });
  const hour = Number(at.toLocaleTimeString("en-GB", { timeZone: COMPANY_TIMEZONE, hour: "2-digit", hour12: false }).slice(0, 2));
  return { date, start: `${pad(hour)}:00`, end: hour >= 23 ? "23:45" : `${pad(hour + 1)}:00` };
}

export function MeetingBookingSheet({ open, onClose, viewer, initialParticipants = [] }: {
  open: boolean; onClose(): void;
  /** 打开时先填好的参会人（战场进展「约会议」）。 */
  initialParticipants?: string[];
  /** 登录的人；成员的主持人一栏就是 displayName。 */
  viewer: { personId: string; role: "ceo" | "member"; displayName: string };
}) {
  const { navigate } = useWorkspace();
  const [title, setTitle] = useState("");
  const [slot, setSlot] = useState(nextSlot);
  const [leadDriId, setLeadDriId] = useState(viewer.role === "member" ? viewer.personId : "");
  const [participants, setParticipants] = useState<string[]>(() => initialParticipants.filter((id) => id !== viewer.personId));
  const [anchors, setAnchors] = useState<TWorldAnchor[]>([]);
  const [options, setOptions] = useState<TWorldAnchorOption[] | null>(null);
  /** 人员名册（选参会人）；CEO 另取带角色的目录选主持人。 */
  const [people, setPeople] = useState<{ personId: string; displayName: string }[]>([]);
  const [hosts, setHosts] = useState<DirectoryPerson[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [optionsError, setOptionsError] = useState(false);
  const [picking, setPicking] = useState(false);
  const period = slot.date.slice(0, 7);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void listPersonDirectory().then((next) => { if (live) setPeople(next); }, () => undefined);
    if (viewer.role === "ceo") void listPeople().then((next) => { if (live) setHosts(next.filter((person) => person.roles.includes("dri"))); }, () => undefined);
    return () => { live = false; };
  }, [open, viewer.role]);
  // 挂点按开会那个月取：换了月份先收起旧选项再重取，已选的不在新选项里就去掉。
  useEffect(() => {
    if (!open) return;
    let live = true;
    setOptions(null);
    void listWorldAnchorOptions(period).then((next) => {
      if (!live) return;
      setOptions(next);
      setOptionsError(false);
      setAnchors((current) => {
        const kept = current.filter((anchor) => next.some((option) => option.kind === anchor.kind && option.id === anchor.id));
        if (kept.length) return kept;
        const mine = next.find((option) => option.kind === "mission" && option.ownerId === viewer.personId);
        return mine ? [{ kind: mine.kind, id: mine.id, title: mine.title }] : [];
      });
    }, () => { if (live) setOptionsError(true); });
    return () => { live = false; };
  }, [open, period, viewer.personId]);

  const nameOf = (personId: string) => people.find((person) => person.personId === personId)?.displayName ?? "";
  const anchorOption = (anchor: TWorldAnchor) => options?.find((option) => option.kind === anchor.kind && option.id === anchor.id);
  const valid = Boolean(title.trim() && slot.date && slot.start && slot.end && slot.end > slot.start && leadDriId && options && anchors.length);
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const result = await bookMeeting({
        title: title.trim(),
        scheduledAt: `${slot.date}T${slot.start}:00+08:00`,
        endsAt: `${slot.date}T${slot.end}:00+08:00`,
        ...(viewer.role === "ceo" ? { leadDriId } : {}),
        ...(participants.length ? { participants } : {}),
        anchors: anchors.map(({ kind, id }) => ({ kind: kind as TPickedWorldAnchor["kind"], id })),
      });
      if ("code" in result) { setError(BOOK_ERROR[result.code] ?? "没有约成"); return; }
      window.dispatchEvent(new Event("meeting-changed"));
      refreshWorkspace();
      onClose();
      navigate(result.card.navigation?.[0]?.href ?? `${viewer.role === "ceo" ? "" : "/me"}/meetings/${result.card.objectRef.id}`);
    } catch {
      setError("没有约成");
    } finally {
      setBusy(false);
    }
  };

  const invitable = people.filter((person) => person.personId !== leadDriId && !participants.includes(person.personId));

  return (
    <SidePanel open={open} onClose={onClose} label="约会议">
      <DetailFrame title="约会议" onBack={onClose} backLabel="关闭">
        <div className={d.booking}>
          <label className={d.bookField}>
            <span>名称</span>
            <input aria-label="名称" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <div className={d.bookField}>
            <span>时间</span>
            <div className={d.bookTime}>
              <DatePicker label="日期" value={slot.date} onChange={(date) => setSlot((current) => ({ ...current, date }))} />
              <div className={d.bookSpan}>
                <Select aria-label="开始" value={slot.start} options={timeOptions(slot.start).map((time) => ({ value: time, label: time }))}
                  onChange={(start) => setSlot((current) => ({ ...current, start }))} />
                <span aria-hidden="true">–</span>
                <Select aria-label="结束" value={slot.end} options={timeOptions(slot.end).map((time) => ({ value: time, label: time }))}
                  onChange={(end) => setSlot((current) => ({ ...current, end }))} />
              </div>
            </div>
          </div>
          <div className={d.bookField}>
            <span>主持人</span>
            {viewer.role === "member"
              ? <output aria-label="主持人" className={d.bookHost}>{viewer.displayName}</output>
              : <Select aria-label="主持人" value={leadDriId} placeholder="选主持人" options={hosts.map((person) => ({ value: person.personId, label: person.displayName }))}
                onChange={(next) => { setLeadDriId(next); setParticipants((current) => current.filter((id) => id !== next)); }} />}
          </div>
          <div className={d.bookField}>
            <span>参会人</span>
            {participants.length ? (
              <ul className={d.bookPeople}>
                {participants.map((personId) => (
                  <li key={personId}>
                    {nameOf(personId)}
                    <button type="button" aria-label={`去掉 ${nameOf(personId)}`} onClick={() => setParticipants((current) => current.filter((id) => id !== personId))}>×</button>
                  </li>
                ))}
              </ul>
            ) : null}
            <Select aria-label="添加参会人" value="" placeholder="添加参会人" options={invitable.map((person) => ({ value: person.personId, label: person.displayName }))}
              onChange={(personId) => { if (personId) setParticipants((current) => [...current, personId]); }} />
          </div>
          <div className={d.bookField}>
            <span>挂到</span>
            {options && anchors.length && !picking ? (
              <div className={d.bookAnchor} data-anchor-row>
                <span>
                  {anchors[0].title}
                  <small>{anchorOption(anchors[0]) ? anchorRole(anchorOption(anchors[0])!, viewer.personId, nameOf) : ""}</small>
                </span>
                <button type="button" onClick={() => setPicking(true)}>换</button>
              </div>
            ) : null}
            {options && (picking || !anchors.length) ? (
              <WorldAnchorPicker options={options} value={anchors} viewerId={viewer.personId} nameOf={nameOf}
                onChange={(next) => { setAnchors(next); if (next[0]?.kind !== "po") setPicking(false); }} />
            ) : null}
            {optionsError ? <p className={d.worldError} role="alert">没有读到对象</p> : null}
          </div>
          {error ? <p className={d.worldError} role="alert">{error}</p> : null}
          <div className={d.bookActions}>
            <button type="button" className={d.ghost} disabled={busy} onClick={onClose}>取消</button>
            <button type="button" className={d.primary} disabled={busy || !valid} onClick={() => void submit()}>约好</button>
          </div>
        </div>
      </DetailFrame>
    </SidePanel>
  );
}
