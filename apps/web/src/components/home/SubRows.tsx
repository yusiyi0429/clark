"use client";

/**
 * 子会话行（原来在左栏项目下面，设计 4.1 起挪去右边的会话面板）：行、状态点、读法、先后，「…」菜单、改名、「已归档」里的一行。
 * 左栏的项目行也用这里的「刚看过」「…」两个 context 和改名框。
 */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { TArchivedSubSession, TSubSessionKind } from "@warmap/contracts";
import { cardHref, subQueueText, topicHref } from "@/lib/home/derive";
import type { SubSession } from "@/lib/home/types";
import { LocalContext, latestSessionFor } from "@/lib/local/LocalRunnerProvider";
import { runLabel } from "@/lib/local/runModel";
import { running } from "@/lib/local/sessionView";
import { showUnseen, type SeenKind, type SeenMarks } from "@/lib/home/seen";
import { showWorkspaceToast } from "@/lib/toast";
import { useNameTip } from "./NameTip";
import { RowMenu, conflictText, useLongPress, type RowMenuItem } from "./RowMenu";
import type { IconState } from "./StateIcon";
import type { View } from "./view";
import h from "@/styles/home.module.css";

/** 左栏里的「刚看过」（25 条）：画蓝点前查，点行时在跳页之前记。 */
export const SeenContext = createContext<{ seen?: SeenMarks; onOpen?: (kind: SeenKind, id: string, marker: string | null) => void }>({});

/** 行尾「…」菜单要做的事（35 条）：调云端的在 useProjects 里；不给就不画菜单。 */
export type RowActions = {
  renameProject: (id: string, name: string) => Promise<unknown>;
  archiveProject: (id: string, archived: boolean) => Promise<unknown>;
  deleteProject: (id: string) => Promise<unknown>;
  renameSub: (kind: TSubSessionKind, id: string, title: string) => Promise<unknown>;
  archiveSub: (kind: TSubSessionKind, id: string, archived: boolean) => Promise<unknown>;
  deleteSub: (kind: TSubSessionKind, id: string) => Promise<unknown>;
};
export const ActionsContext = createContext<RowActions | null>(null);

/** 菜单里没成时就地写的话（B 契约 c3366f28 的 409）。 */
export const archiveSubFail = (error: unknown) => conflictText(error, { SUB_SESSION_RUNNING: "先停下再归档" }, "没归档成");
export const deleteSubFail = (error: unknown) => conflictText(error, { SUB_SESSION_RUNNING: "先停下再删" }, "没删成");

/** 改名：就地一个输入框，回车、移开存，Esc 不改；空的或没变不存。 */
export function RenameInput({ value, maxLength, onDone }: { value: string; maxLength: number; onDone: (name: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  // 从「…」菜单进来时焦点还关在菜单里（autoFocus 落不进来），菜单关掉时焦点掉回页面：那一下接住。
  useEffect(() => {
    const input = ref.current;
    if (!input || document.activeElement === input) return;
    if (document.activeElement === document.body) { input.focus(); return; }
    const settle = (event: FocusEvent) => { if (event.relatedTarget) return; document.removeEventListener("focusout", settle); input.focus(); };
    document.addEventListener("focusout", settle);
    return () => document.removeEventListener("focusout", settle);
  }, []);
  const done = (next: string) => { const trimmed = next.trim(); onDone(trimmed && trimmed !== value ? trimmed : null); };
  return (
    <input ref={ref} className={h.projectName} autoFocus defaultValue={value} aria-label="新名字" maxLength={maxLength} data-testid="row-rename" onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => done(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onDone(null); }
      }} />
  );
}

export const subHref = (sub: Pick<SubSession, "kind" | "id">) => (sub.kind === "card" ? cardHref(sub.id) : topicHref(sub.id));

export const subKey = (sub: Pick<SubSession, "kind" | "id">) => `${sub.kind}:${sub.id}`;

/**
 * 子会话行最右边的状态点（18.10）：在跑灰点闪（同项目标题的呼吸点）；停了（一轮做完、被停下、做完了）、本人还没看过的蓝点（26 条，看过就不画）；
 * 要人介入（问题、批准、验收拿主意、等你补、合回）黄点；排队不出点（行尾写在等什么）。读屏按状态读。
 */
const ASK: Record<NonNullable<SubSession["waiting"]>, string> = { approval: "等你批准", question: "在问你", verdict: "等你拿主意", needs_person: "等你补", merge: "等你合回" };
export function subDot(sub: Pick<SubSession, "state" | "waiting" | "unseen" | "stopWhy">): { tone: "running" | "stopped" | "attention"; label: string } | null {
  const state = treeState(sub.state);
  if (state === "queued") return null;
  if (state === "running") return { tone: "running", label: "在跑" };
  if (state === "waiting" && sub.waiting) return { tone: "attention", label: ASK[sub.waiting] };
  // 蓝点只是提醒（26 条）：停了、本人还没看过才画，打开过就消失（云端算 unseen）。
  if (!sub.unseen) return null;
  return state === "done" ? { tone: "stopped", label: "已完成" } : { tone: "stopped", label: stoppedLabel(sub) };
}

/** 派活单的先后：卡按看板里建出来的时间（一次开工建的几张按派活单的顺序建），没读到的和专题排在后面、按最近动静。 */
export function planOrder(subs: SubSession[], cardAt?: ReadonlyMap<string, string>): SubSession[] {
  const at = (sub: SubSession) => (sub.kind === "card" ? cardAt?.get(sub.id) : undefined);
  return [...subs].sort((a, b) => {
    const x = at(a), y = at(b);
    if (x && y) return x.localeCompare(y);
    if (x || y) return x ? -1 : 1;
    return a.updatedAt.localeCompare(b.updatedAt);
  });
}

/**
 * 树上的状态图标：契约的 failed 是「验收没过、改法还没送回」，第一次没过照 5.4.2 仍是进行中（不画叉；第二次没过是受阻，走等你）。
 * 叉只给程序层面的失败（后台任务那边）。
 */
const treeState = (state: SubSession["state"]): SubSession["state"] => (state === "failed" ? "running" : state);

/**
 * 一个子会话的图标和读法（树、事件行共用）：第一次验收没过画进行中；停下了、没在问你（waiting 没有具体等什么）是「已停下」——
 * Square、--ink-faint，不是等你（契约 aa6aba9e：一轮做完停下的不进等你）。
 */
export function subIcon(sub: Pick<SubSession, "state" | "waiting" | "stopWhy">): { state: IconState; label?: string } {
  if (sub.state === "waiting" && !sub.waiting) return { state: "stopped", label: stoppedLabel(sub) };
  return { state: treeState(sub.state) };
}

/** 停着、不在等什么的读法：一轮正常做完、在等本人下一句的「做完一轮」（和项目动态那行报告同一个说法）；本人停的、强停、出错、本机程序重启打断的、云端没报原因的「已停下」。 */
export const stoppedLabel = (sub: Pick<SubSession, "stopWhy">) => (sub.stopWhy === "turn_done" ? "做完一轮" : "已停下");

/** flat：没有上一级，不缩进、不画竖线（状态位在 x=16，名字在 x=40）。 */
export function Subs({ subs, view, go, flat = false }: { subs: SubSession[]; view: View; go: (href: string) => void; flat?: boolean }) {
  return (
    <ul className={h.subs} data-flat={flat ? "" : undefined}>
      {subs.map((sub) => <SubRow key={subKey(sub)} sub={sub} view={view} go={go} />)}
    </ul>
  );
}

/** status：名字后面一个淡色短状态（右边会话面板用，设计 4.3）；不给不画。 */
export function SubRow({ sub, view, go, status = null }: { sub: SubSession; view: View; go: (href: string) => void; status?: string | null }) {
  const current = (view.kind === "card" || view.kind === "topic") && view.kind === sub.kind && view.id === sub.id;
  // 悬停全名的提示里带一行「来源 · 模型」（这台电脑上跑着、报了来源的才有；行里不放，太挤）。
  const local = useContext(LocalContext);
  const run = sub.sessionId ? local?.sessions.find((entry) => entry.id === sub.sessionId)?.run : null;
  // 排着的（第 68 条）：悬停写全「已排队 · 等 B 改登录页 这一轮做完」，行尾短写在等哪个字母。
  const queued = subQueueText(sub);
  const name = useNameTip(sub.title, queued ?? runLabel(run));
  const heldBy = sub.state === "queued" && sub.queueReason === "folder_busy" ? sub.heldBy ?? null : null;
  const opened = useContext(SeenContext);
  const unseen = showUnseen(sub.unseen, opened.seen, "sub", sub.id, sub.updatedAt);
  const dot = subDot({ ...sub, unseen });
  const actions = useContext(ActionsContext);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const press = useLongPress(() => setMenu(true));
  // 停止只在这台电脑上跑着时有（本机直接停）；会话照子会话页的认法（这张卡、这个专题最近的那个）。
  const session = local ? latestSessionFor(local.sessions, sub.kind === "card" ? { cardId: sub.id } : { topicId: sub.id }) : null;
  const stoppable = !!session && running(session.status);
  // 行尾「…」（35 条）：重命名、标为已读、停止（在跑时）、归档、删除（进回收站）。
  const menuItems: RowMenuItem[] = actions ? [
    { id: "rename", label: "重命名", run: () => setRenaming(true) },
    { id: "read", label: "标为已读", disabled: !unseen, run: () => opened.onOpen?.("sub", sub.id, sub.updatedAt) },
    ...(stoppable && local ? [{ id: "stop", label: "停止", run: async () => { await local.runner.kill(session!.id); await local.refresh(); }, failText: () => "没停下" }] : []),
    { id: "archive", label: "归档", run: () => actions.archiveSub(sub.kind, sub.id, true), failText: archiveSubFail },
    { id: "delete", label: "删除", danger: true, run: () => actions.deleteSub(sub.kind, sub.id), failText: deleteSubFail },
  ] : [];
  const rename = (title: string | null) => {
    setRenaming(false);
    if (title && actions) void actions.renameSub(sub.kind, sub.id, title).catch(() => showWorkspaceToast({ text: "没改成" }));
  };
  if (renaming) return <li><RenameInput value={sub.title} maxLength={sub.kind === "topic" ? 60 : 120} onDone={rename} /></li>;
  return (
    <li className={h.subItem} {...press}>
      <button type="button" className={h.sub} data-state={sub.state} aria-current={current ? "page" : undefined} onClick={() => { opened.onOpen?.("sub", sub.id, sub.updatedAt); go(subHref(sub)); }} data-tree-row="" data-testid="tree-sub" {...name.rowProps}>
        <span ref={name.textRef} className={h.subName}>{sub.title}</span>
        {heldBy ? <span className={h.subReason} data-testid="sub-held">等「{heldBy.title}」</span> : null}
        {status ? <span className={h.subStatus} data-testid="sub-status">{status}</span> : null}
        {dot ? <span className={h.subDot} data-tone={dot.tone} role="img" aria-label={dot.label} data-testid="sub-dot"><i aria-hidden /></span> : null}
      </button>
      {name.tip}
      {actions ? <RowMenu label={sub.title} items={menuItems} open={menu} onOpenChange={setMenu} /> : null}
    </li>
  );
}

/** 「已归档」里的一个子会话（35 条）：名字、淡色写原来的项目；点了打开，「…」里恢复回原来的项目。 */
export function ArchivedSubRow({ sub, go }: { sub: TArchivedSubSession; go: (href: string) => void }) {
  const actions = useContext(ActionsContext);
  const [menu, setMenu] = useState(false);
  const press = useLongPress(() => setMenu(true));
  return (
    <li className={h.subItem} {...press} data-testid="tree-archived-sub">
      <button type="button" className={h.sub} data-state="done" onClick={() => go(subHref(sub))} data-tree-row="">
        <span className={h.subName}>{sub.title}{sub.projectName ? <span className={h.menuFaint}> · {sub.projectName}</span> : null}</span>
      </button>
      {actions ? <RowMenu label={sub.title} open={menu} onOpenChange={setMenu}
        items={[{ id: "restore", label: "恢复", run: () => actions.archiveSub(sub.kind, sub.id, false), failText: () => "没恢复成" }]} /> : null}
    </li>
  );
}
