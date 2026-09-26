"use client";

import { useRef } from "react";
import { Paperclip } from "lucide-react";
import type { ConversationData } from "./useConversation";
import x from "@/styles/conversation-attachments.module.css";

const ATTACHMENT_ACCEPT =
  ".pdf,.docx,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown";

/** 附件键：随时可用，附件直接挂在这个人在这一页的那条对话上（二级页在输入条底行，首页在历史层页头）。 */
export function AttachButton({ data, className }: { data: ConversationData; className?: string }) {
  const file = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={file}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className={x.fileInput}
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          if (event.target.files) void data.uploadFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <button
        type="button"
        className={className}
        aria-label="上传附件（PDF/DOCX/Markdown）"
        title="上传附件"
        aria-busy={data.uploading}
        disabled={data.uploading}
        onClick={() => file.current?.click()}
      >
        <Paperclip size={18} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </>
  );
}

/** 附件上传的进度与错误：一行如实说明（C-04）。 */
export function AttachmentStatus({ data, className }: { data: ConversationData; className?: string }) {
  if (data.uploading)
    return (
      <p className={className} aria-live="polite">
        附件上传中…
      </p>
    );
  if (data.attachmentError)
    return (
      <p className={className} role="alert">
        {data.attachmentError}
      </p>
    );
  return null;
}
