"use client";

/**
 * 首页「会议安排」、CEO 通知栏里待交记录的会：整块能拖文件进来上传，也能点「上传」选文件；传上去就进会议页看结果，没传上去在卡里写原因。
 * children 拿到打开选文件的函数和上传中状态，自己摆「上传」按钮。
 */
import { useRef, useState, type ReactNode } from "react";
import { MEETING_RECORD_ACCEPT, uploadMeetingRecord } from "@/lib/meetingRecordUpload";
import { FileDropZone } from "@/components/FileDropZone";

export function MeetingRecordDrop({ meetingId, title, href, onNavigate, className, errorClassName, children }: {
  meetingId: string;
  title: string;
  href: string;
  onNavigate: (href: string, from?: Element | null) => void;
  className?: string;
  errorClassName?: string;
  children: (pick: () => void, busy: boolean) => ReactNode;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const upload = async (file: File) => {
    setBusy(true); setError("");
    const result = await uploadMeetingRecord(meetingId, file);
    setBusy(false);
    if (result.ok) return onNavigate(href);
    if (result.status === 401) return onNavigate("/access");
    setError(result.message);
  };
  return (
    <FileDropZone className={className} busy={busy} onFile={(file) => void upload(file)}>
      {children(() => fileRef.current?.click(), busy)}
      <input ref={fileRef} type="file" accept={MEETING_RECORD_ACCEPT} hidden aria-label={`给「${title}」上传会议记录`}
        onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
      {error ? <small className={errorClassName} role="alert">{error}</small> : null}
    </FileDropZone>
  );
}
