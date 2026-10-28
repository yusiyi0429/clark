"use client";

/**
 * 首页「会议安排」、CEO 通知栏里待交记录的会：点「上传」在这一行下面展开一张小卡，首选贴妙记链接读取，也能选文件；整块仍能拖文件进来。
 * 贴链接读到了就不跳走：这一行原地显示读取妙记 → 生成会议卡，等列表刷新后换成服务端的进度；选文件传上去的还要确认说话人，照旧进会议页。
 * children 拿到展开小卡的函数和是否在办，自己摆「上传」按钮。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MEETING_RECORD_ACCEPT, uploadMeetingRecord } from "@/lib/meetingRecordUpload";
import { FileDropZone } from "@/components/FileDropZone";
import { readMeetingMinutesLink } from "./meetingDecisionApi";
import { RecordProcessingMeta } from "./MeetingRecordProcessing";
import d from "@/styles/meeting-record-drop.module.css";

const READ_FAILURE: Record<string, string> = { no_permission: "没有权限读这份妙记，去会议页连接飞书", not_ready: "妙记还没生成好，稍后再读" };
const LINK_ERROR: Record<string, string> = { INVALID_MINUTES_URL: "不是妙记链接" };

type Stage = { phase: "reading" | "card"; since: string } | null;

export function MeetingRecordDrop({ meetingId, title, href, onNavigate, className, errorClassName, children }: {
  meetingId: string;
  title: string;
  href: string;
  onNavigate: (href: string, from?: Element | null) => void;
  className?: string;
  errorClassName?: string;
  children: (open: () => void, busy: boolean) => ReactNode;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  const [panel, setPanel] = useState(false);
  const [url, setUrl] = useState("");
  const [stage, setStage] = useState<Stage>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const busy = uploading || stage !== null;
  useEffect(() => { if (panel) linkRef.current?.focus(); }, [panel]);

  const upload = async (file: File) => {
    setUploading(true); setError("");
    const result = await uploadMeetingRecord(meetingId, file);
    setUploading(false);
    if (result.ok) return onNavigate(href);
    if (result.status === 401) return onNavigate("/access");
    setError(result.message);
  };
  const read = async () => {
    const link = url.trim();
    if (!link || busy) return;
    setError(""); setPanel(false); setStage({ phase: "reading", since: new Date().toISOString() });
    try {
      const result = await readMeetingMinutesLink(meetingId, link);
      if ("code" in result) {
        setStage(null); setPanel(true);
        return setError((result.code === "MINUTE_TAKEN" && result.message) || LINK_ERROR[result.code] || "没有读到");
      }
      if (result.minutesStatus !== "ready") {
        setStage(null); setPanel(true);
        return setError(READ_FAILURE[result.minutesFailure ?? ""] ?? "没有读到这份妙记");
      }
      setUrl("");
      setStage({ phase: "card", since: new Date().toISOString() });
      window.dispatchEvent(new Event("meeting-changed"));
    } catch {
      setStage(null); setPanel(true); setError("没有读到");
    }
  };

  return (
    <FileDropZone className={[className, stage ? d.processing : null].filter(Boolean).join(" ")} busy={busy} onFile={(file) => void upload(file)}>
      {children(() => { setError(""); setPanel((open) => !open); }, busy)}
      {stage ? <div className={d.stage} role="status">
        <RecordProcessingMeta processing={{ since: stage.since, failed: false }} label={stage.phase === "reading" ? "读取妙记" : "生成会议卡"}
          expectedMs={stage.phase === "reading" ? null : undefined} />
      </div> : null}
      {panel && !stage ? <form className={d.panel} onSubmit={(event) => { event.preventDefault(); void read(); }}>
        <div className={d.linkRow}>
          <input ref={linkRef} type="url" inputMode="url" value={url} onChange={(event) => setUrl(event.target.value)}
            placeholder="粘贴妙记链接" aria-label={`「${title}」的妙记链接`} />
          <button type="submit" disabled={!url.trim()}>读取</button>
        </div>
        <button type="button" className={d.quiet} disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? "上传中…" : "选文件"}</button>
      </form> : null}
      <input ref={fileRef} type="file" accept={MEETING_RECORD_ACCEPT} hidden aria-label={`给「${title}」上传会议记录`}
        onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} />
      {error ? <small className={errorClassName} role="alert">{error}</small> : null}
    </FileDropZone>
  );
}
