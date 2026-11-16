"use client";

/**
 * 约会议（FR-4.1）：顶栏或首页「约会议」打开的右侧浮出面板（SidePanel，形状同通知栏），页头和二级页同一个（DetailFrame）。
 * 外壳一直挂着它、每次打开换一个 key：表单从空白开始，关时面板能原路滑出。
 * 名称、日期 + 起止、主持人（成员只能是本人，CEO 从 DRI 里选）、参会人（可空）、挂到（一个）。
 * 挂到：选项到了就默认挂上自己本月的第一个 Mission（没有就空着、直接展开去挑），收起时一行写着挂点和「我的 Mission / PO …」，右边「换」；
 * 换的时候是 WorldAnchorPicker，挑了 Mission、LTO 就收起，挑了 PO 不收（下面展开它的 Mission 可以再往下挑）。
 * 「约好」建会（只存天枢，不写本体），成功后跳到会议页。
 * 材料（可不传）：拖进来或点选，可多份；约好拿到会议 id 后一份一份传进这场会的群材料，传不上的提示一句，会照样约好。
 * 本人的飞书授权不能在飞书日历约会（没连、过期或缺日历权限）时，按钮上方一行提示和「连接飞书」（新标签页里连，表单不丢）。
 * 整理模式（organize）：飞书里直接开的会待整理，用这份妙记建会；时间、参会人取自妙记只读，没有主持人一栏，挂点按妙记那个月取。
 * 对话里会议卡的「改」（draft）：名称、时间、主持人、参会人、挂到先按草稿填好（草稿没挂就空着，不默认挂），约好时带 draftId。
 */
import { useEffect, useState, type DragEvent } from "react";
import { Upload } from "lucide-react";
import type { TFeishuMinuteInboxItem, TPickedWorldAnchor, TWorldAnchor, TWorldAnchorOption } from "@warmap/contracts";
import { COMPANY_TIMEZONE, companyMonth, dateSpan } from "@/lib/companyTime";
import { feishuConnectHref, readFeishuConnection } from "@/lib/feishuLogin";
import { refreshWorkspace, showWorkspaceToast } from "@/lib/toast";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { DatePicker } from "@/components/ui/DatePicker";
import { Select } from "@/components/ui/Select";
import { SidePanel } from "@/components/ui/SidePanel";
import { timeOptions } from "@/components/ui/pickerFormat";
import { bookMeeting, listPeople, listPersonDirectory, listWorldAnchorOptions, organizeFeishuMinute, uploadMeetingMaterial, type DirectoryPerson } from "./meetingDecisionApi";
import { anchorRole, WorldAnchorPicker } from "./WorldAnchorPicker";
import d from "./meeting-decisions.module.css";

export const BOOK_ERROR: Record<string, string> = { ANCHOR_NOT_FOUND: "所属对象已失效", FORBIDDEN: "没有权限", INVALID_LEAD_DRI: "主持人不可选", INVALID_PARTICIPANT: "参会人不可选", MEETING_DRAFT_BUSY: "正在约" };
const ORGANIZE_ERROR: Record<string, string> = { MINUTE_TAKEN: "已经记到别的会上了", MINUTE_NOT_PENDING: "已经处理过了", ANCHOR_NOT_FOUND: "所属对象已失效" };
const pad = (value: number) => String(value).padStart(2, "0");
/** 群材料能收的格式和大小（同 ObjectMaterialArea）。 */
const MATERIAL_ACCEPT = ".md,.pdf,.docx,.html,.htm";
const MATERIAL_MAX_BYTES = 20 * 1024 * 1024;

/** 默认下一个整点开、开一小时（公司时区）。 */
function nextSlot(now = new Date()): { date: string; start: string; end: string } {
  const at = new Date(now.getTime() + 3_600_000);
  const date = at.toLocaleDateString("sv-SE", { timeZone: COMPANY_TIMEZONE });
  const hour = Number(at.toLocaleTimeString("en-GB", { timeZone: COMPANY_TIMEZONE, hour: "2-digit", hour12: false }).slice(0, 2));
  return { date, start: `${pad(hour)}:00`, end: hour >= 23 ? "23:45" : `${pad(hour + 1)}:00` };
}
const clockAt = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { timeZone: COMPANY_TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false });
/** 草稿的起止换成表单的日期、开始、结束（公司时区）。 */
const slotOf = ({ scheduledAt, endsAt }: BookingDraft) =>
  ({ date: new Date(scheduledAt).toLocaleDateString("sv-SE", { timeZone: COMPANY_TIMEZONE }), start: clockAt(scheduledAt), end: clockAt(endsAt) });

/** 对话里会议卡的草稿（「改」打开时先填好）。 */
export type BookingDraft = { draftId: string; title: string; scheduledAt: string; endsAt: string; leadDriId: string | null; participants: string[]; anchors: TWorldAnchor[] };

type Viewer = { personId: string; role: "ceo" | "member"; displayName: string };

export function MeetingBookingSheet({ open, onClose, viewer, organize, initialParticipants = [], draft }: {
  open: boolean; onClose(): void;
  /** 打开时先填好的参会人（战场进展「约会议」）。 */
  initialParticipants?: string[];
  /** 对话里会议卡的草稿（卡上的「改」）。 */
  draft?: BookingDraft;
} & (
  /** 约会议：登录的人；成员的主持人一栏就是 displayName。 */
  | { viewer: Viewer; organize?: undefined }
  /** 整理会议：待整理的那份妙记；整理好后跳到 `${meetingBase}/${meetingId}`。 */
  | { organize: { minute: TFeishuMinuteInboxItem; meetingBase: string; onOrganized(meetingId: string): void }; viewer?: undefined }
)) {
  const { navigate, viewerId: workspaceViewer } = useWorkspace();
  /** 登录的人（整理飞书会时没有 viewer，用工作台的）：挂点默认挂他的 Mission。 */
  const me = viewer?.personId ?? workspaceViewer ?? "";
  const role = viewer?.role;
  const [title, setTitle] = useState(() => organize?.minute.title ?? draft?.title ?? "");
  const [slot, setSlot] = useState(() => (draft ? slotOf(draft) : nextSlot()));
  const [leadDriId, setLeadDriId] = useState(viewer?.role === "member" ? viewer.personId : draft?.leadDriId ?? "");
  const [participants, setParticipants] = useState<string[]>(() => (draft?.participants ?? initialParticipants).filter((id) => id !== viewer?.personId));
  const [anchors, setAnchors] = useState<TWorldAnchor[]>(draft?.anchors ?? []);
  /** 草稿没挂（CEO 的会议卡默认不挂）：不替他默认挂自己的 Mission。 */
  const autoAnchor = !draft || draft.anchors.length > 0;
  const [options, setOptions] = useState<TWorldAnchorOption[] | null>(null);
  /** 人员名册（选参会人）；CEO 另取带角色的目录选主持人。 */
  const [people, setPeople] = useState<{ personId: string; displayName: string }[]>([]);
  const [hosts, setHosts] = useState<DirectoryPerson[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [optionsError, setOptionsError] = useState(false);
  const [picking, setPicking] = useState(false);
  /** 约好后要放进群材料的几份。 */
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  /** 约好后正在传第几份（按钮上显示）。 */
  const [uploadingAt, setUploadingAt] = useState(0);
  const [feishu, setFeishu] = useState<{ enabled: boolean; calendar: boolean } | null>(null);
  const [revision, setRevision] = useState(0);
  const [peopleError, setPeopleError] = useState(false);
  const period = organize ? companyMonth(new Date(organize.minute.startsAt)) : slot.date.slice(0, 7);
  const heading = organize ? "整理会议" : "约会议";

  // 整理会议不取人员名册（参会人取自妙记）。
  useEffect(() => {
    if (!open || !role) return;
    let live = true;
    setPeopleError(false);
    void listPersonDirectory().then((next) => { if (live) setPeople(next); }, () => { if (live) setPeopleError(true); });
    if (role === "ceo") void listPeople().then((next) => { if (live) setHosts(next.filter((person) => person.roles.includes("dri"))); }, () => { if (live) setPeopleError(true); });
    return () => { live = false; };
  }, [open, role, revision]);
  // 本人的飞书能不能在日历约会：打开时读一次；在新标签页连完回来（窗口拿回焦点）再读。整理会议不在飞书约，不读。
  useEffect(() => {
    if (!open || organize) return;
    let live = true;
    const load = () => void readFeishuConnection().then((next) => { if (live) setFeishu(next); });
    load();
    window.addEventListener("focus", load);
    return () => { live = false; window.removeEventListener("focus", load); };
  }, [open, organize, revision]);
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
        const mine = autoAnchor ? next.find((option) => option.kind === "mission" && option.ownerId === me) : undefined;
        return mine ? [{ kind: mine.kind, id: mine.id, title: mine.title }] : [];
      });
    }, () => { if (live) setOptionsError(true); });
    return () => { live = false; };
  }, [open, period, me, autoAnchor, revision]);

  const nameOf = (personId: string) => people.find((person) => person.personId === personId)?.displayName ?? "";
  const anchorOption = (anchor: TWorldAnchor) => options?.find((option) => option.kind === anchor.kind && option.id === anchor.id);
  const valid = organize
    ? Boolean(title.trim() && options && anchors.length)
    : Boolean(title.trim() && leadDriId && options && anchors.length && slot.date && slot.start && slot.end && slot.end > slot.start);
  const submitOrganize = async ({ minute, meetingBase, onOrganized }: NonNullable<typeof organize>) => {
    setBusy(true); setError("");
    try {
      const result = await organizeFeishuMinute(minute.minuteToken, {
        title: title.trim(),
        anchors: anchors.map(({ kind, id }) => ({ kind: kind as TPickedWorldAnchor["kind"], id })),
      });
      if ("code" in result) { setError(ORGANIZE_ERROR[result.code] ?? "没有整理成"); return; }
      window.dispatchEvent(new Event("meeting-changed"));
      refreshWorkspace();
      onOrganized(result.meetingId);
      navigate(`${meetingBase}/${result.meetingId}`);
    } catch {
      setError("没有整理成");
    } finally {
      setBusy(false);
    }
  };
  const addFiles = (picked: File[]) => {
    if (!picked.length) return;
    if (picked.some((file) => !/\.(md|pdf|docx|html|htm)$/i.test(file.name))) return setError("只支持 PDF、Word、Markdown 和 HTML");
    if (picked.some((file) => file.size > MATERIAL_MAX_BYTES)) return setError("单份材料不能超过 20 MB");
    setError("");
    setFiles((current) => [...current, ...picked]);
  };
  const dropping = {
    onDragOver: (event: DragEvent<HTMLLabelElement>) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); setDragging(true); },
    onDragLeave: (event: DragEvent<HTMLLabelElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); },
    onDrop: (event: DragEvent<HTMLLabelElement>) => { event.preventDefault(); setDragging(false); addFiles([...event.dataTransfer.files]); },
  };
  const submit = async (viewer: Viewer) => {
    if (!valid || busy) return;
    setBusy(true); setError("");
    try {
      const result = await bookMeeting({
        title: title.trim(),
        scheduledAt: `${slot.date}T${slot.start}:00+08:00`,
        endsAt: `${slot.date}T${slot.end}:00+08:00`,
        ...(viewer.role === "ceo" ? { leadDriId } : {}),
        ...(participants.length ? { participants } : {}),
        anchors: anchors.map(({ kind, id }) => ({ kind: kind as TPickedWorldAnchor["kind"], id })),
        ...(draft ? { draftId: draft.draftId } : {}),
      });
      if ("code" in result) { setError(BOOK_ERROR[result.code] ?? "没有约成"); return; }
      // 会已经约好：材料一份一份传，传不上的不挡跳转，提示一句（会议页的材料区还能再传）。
      let failed = 0;
      for (const [index, file] of files.entries()) {
        setUploadingAt(index + 1);
        if (await uploadMeetingMaterial(result.card.objectRef.id, file)) failed += 1;
      }
      if (failed) showWorkspaceToast({ text: `${failed} 份材料没传上，可在会议页再传` });
      window.dispatchEvent(new Event("meeting-changed"));
      refreshWorkspace();
      onClose();
      navigate(result.card.navigation?.[0]?.href ?? `${viewer.role === "ceo" ? "" : "/me/work"}/meetings/${result.card.objectRef.id}`);
    } catch {
      setError("没有约成");
    } finally {
      setBusy(false);
      setUploadingAt(0);
    }
  };

  const invitable = people.filter((person) => person.personId !== leadDriId && !participants.includes(person.personId));
  const retryRead = () => setRevision((value) => value + 1);

  return (
    <SidePanel open={open} onClose={onClose} label={heading}>
      <DetailFrame title={heading} onBack={onClose} backLabel="关闭">
        <div className={d.booking}>
          <label className={d.bookField}>
            <span>名称</span>
            <input aria-label="名称" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
          </label>
          {organize ? (
            <div className={d.bookField}>
              <span>时间</span>
              <output aria-label="时间" className={d.bookHost}>{dateSpan(organize.minute.startsAt, organize.minute.endsAt)}<small className={d.bookSource}>飞书</small></output>
            </div>
          ) : <div className={d.bookField}>
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
          </div>}
          {viewer ? <div className={d.bookField}>
            <span>主持人</span>
            {viewer.role === "member"
              ? <output aria-label="主持人" className={d.bookHost}>{viewer.displayName}</output>
              : <Select aria-label="主持人" value={leadDriId} placeholder="选主持人" options={hosts.map((person) => ({ value: person.personId, label: person.displayName }))}
                onChange={(next) => { setLeadDriId(next); setParticipants((current) => current.filter((id) => id !== next)); }} />}
          </div> : null}
          <div className={d.bookField}>
            <span>参会人</span>
            {organize ? (
              <ul className={d.bookPeople} data-readonly>
                {organize.minute.attendees.map((person) => <li key={person.personId}>{person.displayName}</li>)}
                {organize.minute.otherAttendees > 0 ? <li data-off>{`+${organize.minute.otherAttendees}`}</li> : null}
              </ul>
            ) : participants.length ? (
              <ul className={d.bookPeople}>
                {participants.map((personId) => (
                  <li key={personId}>
                    {nameOf(personId)}
                    <button type="button" aria-label={`去掉 ${nameOf(personId)}`} onClick={() => setParticipants((current) => current.filter((id) => id !== personId))}>×</button>
                  </li>
                ))}
              </ul>
            ) : null}
            {organize ? null : <Select aria-label="添加参会人" value="" placeholder="添加参会人" options={invitable.map((person) => ({ value: person.personId, label: person.displayName }))}
              onChange={(personId) => { if (personId) setParticipants((current) => [...current, personId]); }} />}
            {peopleError ? <p className={d.worldError} role="alert">没有读到人员目录 <button type="button" onClick={retryRead}>重试</button></p> : null}
          </div>
          <div className={d.bookField}>
            <span>所属</span>
            {options && anchors.length && !picking ? (
              <div className={d.bookAnchor} data-anchor-row>
                <span>
                  {anchors[0].title}
                  <small>{anchorOption(anchors[0]) ? anchorRole(anchorOption(anchors[0])!, me, nameOf) : ""}</small>
                </span>
                <button type="button" onClick={() => setPicking(true)}>更换</button>
              </div>
            ) : null}
            {options && (picking || !anchors.length) ? (
              <WorldAnchorPicker options={options} value={anchors} viewerId={me} nameOf={nameOf} company={role === "ceo"}
                onChange={(next) => { setAnchors(next); if (next[0]?.kind !== "po") setPicking(false); }} />
            ) : null}
            {optionsError ? <div className={d.worldError}><span role="alert">没有读到对象</span> <button type="button" onClick={retryRead}>重试</button></div> : null}
          </div>
          {organize ? null : <div className={d.bookField}>
            <span>材料</span>
            {files.length ? (
              <ul className={d.bookPeople}>
                {files.map((file, index) => (
                  <li key={`${index}:${file.name}`}>
                    {file.name}
                    <button type="button" aria-label={`去掉 ${file.name}`} disabled={busy}
                      onClick={() => setFiles((current) => current.filter((_, at) => at !== index))}>×</button>
                  </li>
                ))}
              </ul>
            ) : null}
            <label className={d.bookDrop} data-dragging={dragging || undefined} {...dropping}>
              <Upload size={15} strokeWidth={1.8} aria-hidden />
              拖入或点选文件
              <input className={d.bookFile} type="file" accept={MATERIAL_ACCEPT} multiple aria-label="上传材料" disabled={busy}
                onChange={(event) => { addFiles([...(event.target.files ?? [])]); event.target.value = ""; }} />
            </label>
          </div>}
          {error ? <p className={d.worldError} role="alert">{error}</p> : null}
          {!organize && feishu?.enabled && !feishu.calendar ? (
            <p className={d.bookFeishu} role="status">
              没连飞书，会议不会进你的飞书日历
              <a href={feishuConnectHref(window.location?.pathname ?? "/")} target="_blank" rel="noopener">连接飞书</a>
            </p>
          ) : null}
          <div className={d.bookActions}>
            <button type="button" className={d.ghost} disabled={busy} onClick={onClose}>取消</button>
            <button type="button" className={d.primary} disabled={busy || !valid} onClick={() => void (organize ? submitOrganize(organize) : submit(viewer))}>{organize ? "整理" : uploadingAt ? `上传材料 ${uploadingAt}/${files.length}` : "约好"}</button>
          </div>
        </div>
      </DetailFrame>
    </SidePanel>
  );
}
