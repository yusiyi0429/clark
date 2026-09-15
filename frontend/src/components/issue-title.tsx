"use client";

import { Pencil } from "lucide-react";
import { useState } from "react";
import { api, ApiError } from "@/lib/data/client";
import type { Issue } from "@/lib/data/types";
import { cn } from "@/lib/utils";

/**
 * 议题标题，外加一颗改题的键。**议题研究页顶栏和潜在议题页头部共用这一个组件。**
 *
 * ## 为什么必须共用
 *
 * 这两页渲染的是同一个字符串的两份拷贝：议题上的 `title` 和卡上的 `headline`
 * （落卡那几处都写着「卡面最响的一行就是这条议题本身，不另编一句」）。改题这件事
 * 治的正是「同一句话手抄多份」，两页各写一份编辑态等于一边治一边又种一个 —— 下一次
 * 改交互（回车要不要保存、空标题给不给按）就只会改到其中一页。
 *
 * 服务端那一侧同理：`api.renameIssue` 一次把议题标题和卡面那一行一起改。
 *
 * ## 点标题不进编辑态
 *
 * 标题是这两页上最大的那行字，眼睛落上去、鼠标跟过去是常事；一点就变输入框等于把
 * 「读」和「改」绑在同一个动作上。改题走旁边那颗单独的键。
 */
export function IssueTitle({
  issueId,
  title,
  className,
  titleClassName,
  onRenamed,
}: {
  issueId: string;
  /** 此刻屏幕上那行字。议题页给 `issue.title`，潜在议题页给 `card.headline`。 */
  title: string;
  /** 外面那一行的排版。两页的版面不同（一页要 truncate，一页要换行），由调用方给。 */
  className?: string;
  /** 标题本身的字号行高。同上。 */
  titleClassName?: string;
  /** 改成了。调用方拿这条新议题去刷自己那份缓存。 */
  onRenamed: (issue: Issue) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const save = async () => {
    const next = (draft ?? "").trim();
    if (!next || busy) return;
    setBusy(true);
    setFailed(null);
    try {
      const issue = await api.renameIssue(issueId, next);
      onRenamed(issue);
      setDraft(null);
    } catch (e) {
      setFailed(e instanceof ApiError ? e.message : "这一下没有走完 —— 刷新看一眼改成了没有。");
    } finally {
      setBusy(false);
    }
  };

  if (draft !== null) {
    return (
      <div className={cn("min-w-0", className)}>
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={draft}
            disabled={busy}
            placeholder="议题标题"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              /* 回车保存、Esc 退出。有了这两下，屏幕上就不必再写一句怎么操作。 */
              if (e.key === "Enter") void save();
              if (e.key === "Escape") setDraft(null);
            }}
            className="min-w-0 flex-1 rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-md leading-relaxed text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            disabled={busy || !draft.trim()}
            onClick={() => void save()}
            className="meta inline-flex h-8 flex-none items-center rounded-md bg-solid px-3 font-medium text-solid-fg transition-opacity duration-fast hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "正在保存…" : "保存"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setDraft(null)}
            className="meta flex-none rounded-[3px] px-1 text-ink-faint transition-colors duration-fast hover:text-ink-muted"
          >
            算了
          </button>
        </div>
        {failed ? (
          <p className="meta mt-1 text-counter" aria-live="polite">
            {failed}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <h1 className={cn("min-w-0", titleClassName)} title={title}>
        {title}
      </h1>
      {/* 图标本身说不清「改的是哪一行」，所以那三个字进 aria-label 和 title —— 同这一行
          上那颗话筒（`issue-header.tsx`）。 */}
      <button
        type="button"
        aria-label="改题"
        title="改题"
        onClick={() => setDraft(title)}
        className="inline-flex size-7 flex-none items-center justify-center rounded-md text-ink-faint transition-colors duration-fast ease-swift hover:bg-wash-hover hover:text-ink"
      >
        <Pencil className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
