"use client";

import { useEffect, useRef, useState } from "react";
import { MessagesSquare, Paperclip, Plus, Trash2 } from "lucide-react";
import { calendarDate } from "@/lib/companyTime";
import { sessionLabel, type ConversationData, type Session } from "./useConversation";
import x from "@/styles/conversation-sessions.module.css";

const ATTACHMENT_ACCEPT =
  ".pdf,.docx,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown";

/**
 * 天枢独有的会话与附件（clark 每个上下文只有一条连续对话）：放在历史层 / 对话列页头的动作位，
 * 用 clark 的圆钮与浮层语言。未选择会话时消息保存到本页默认会话。
 */
export function SessionTools({ data, tone }: { data: ConversationData; tone?: "light" }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<Session | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const { loadSessions } = data;

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    if (!open) setConfirming(null);
  }, [open]);

  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true }));
  };

  return (
    <div
      className={`${x.wrap} ${tone === "light" ? x.light : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
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
        className={x.toolButton}
        aria-label={data.activeSessionId ? "上传附件（PDF/DOCX/Markdown）" : "选择会话后才能上传附件"}
        title={data.activeSessionId ? "上传附件" : "选择会话后才能上传附件"}
        aria-busy={data.uploading}
        disabled={data.uploading}
        onClick={() => file.current?.click()}
      >
        <Paperclip aria-hidden="true" />
      </button>
      <button
        ref={trigger}
        type="button"
        className={x.toolButton}
        aria-expanded={open}
        aria-label={`会话列表，共 ${data.sessions.length} 个`}
        onClick={() => setOpen((value) => !value)}
      >
        <MessagesSquare aria-hidden="true" />
        {data.sessions.length}
      </button>
      {open ? (
        <section className={x.panel} aria-label="会话列表">
          <header className={x.panelHead}>
            <span>
              <b>会话</b> · {data.activeSessionId ? "当前会话独立保存消息与附件" : "默认会话"}
            </span>
            <button type="button" className={x.newSession} onClick={() => void data.createSession()}>
              <Plus size={13} aria-hidden="true" />
              新建会话
            </button>
          </header>
          {data.sessionError ? (
            <p className={x.status} role="alert">
              {data.sessionError}
            </p>
          ) : null}
          <ul className={x.list}>
            {data.sessions.map((session) => (
              <li key={session.id} className={x.item} data-active={session.id === data.activeSessionId}>
                <button
                  type="button"
                  className={x.select}
                  aria-current={session.id === data.activeSessionId ? "true" : undefined}
                  onClick={() => {
                    data.selectSession(session.id);
                    close();
                  }}
                >
                  <span>{sessionLabel(session)}</span>
                  {session.createdAt ? <small>{calendarDate(session.createdAt)}</small> : null}
                </button>
                <button type="button" className={x.remove} aria-label={`删除会话 ${sessionLabel(session)}`} onClick={() => setConfirming(session)}>
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {confirming ? (
            <div className={x.confirm} role="alertdialog" aria-label="删除会话确认">
              删除后「{sessionLabel(confirming)}」的消息与附件不再可见，且不可恢复。
              <div>
                <button type="button" onClick={() => setConfirming(null)}>
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void data.deleteSession(confirming.id);
                    setConfirming(null);
                  }}
                >
                  删除
                </button>
              </div>
            </div>
          ) : null}
          <p className={x.note}>{data.sessions.length ? "未选择会话时，消息保存到本页默认会话。" : "还没有独立会话；消息保存到本页默认会话。"}</p>
        </section>
      ) : null}
    </div>
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
