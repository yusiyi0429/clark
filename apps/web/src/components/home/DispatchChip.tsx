"use client";

/**
 * 伙伴主线的派活卡（本人 11/18）：伙伴在这一轮开了哪个项目的哪个会话、或转给了哪个项目的对话，挂在那一轮回答下面一行。
 * 画成什么照云端算好的 state：
 * - 开的会话 active：会话小条（ThreadChip，名字前面淡色「项目名 · 」），名字、状态跟着首页数据里那个会话走；等项目绑文件夹时短状态写「等你」。
 *   首页数据里还没读到它（刚开）：先照卡上存的名字画，点了照样打开（电脑上在右边开，数据到了右边就画出来）；等文件夹时同样写「等你」。
 * - 转给项目对话 active：「项目名 ›」，项目对话里有没看过的新回复带蓝点，点了去那个项目的对话。
 * - archived / gone：一行淡色「项目名 · 会话名」（转给项目的只有项目名），不能点。
 * 「随手」项目的会话（本人 11/19 收到幕后）：不写「项目名 · 」，只写会话名；点开右边页头只写「从主线开的」。
 * 放不下就换行，不截断。
 */
import type { TConversationCard } from "@warmap/contracts";
import type { Project } from "@/lib/home/projects";
import type { SubSession } from "@/lib/home/types";
import { StateIcon } from "./StateIcon";
import { ThreadChip } from "./ThreadChip";
import h from "@/styles/home.module.css";

export type DispatchCard = Extract<TConversationCard, { kind: "buddy_dispatch" }>;

export function DispatchChip({ card, subs, projects, waitingFolder, onOpenSub, onOpenProject }: {
  card: DispatchCard;
  subs: readonly SubSession[];
  projects: readonly (Pick<Project, "id" | "name" | "archived" | "unseen"> & { scratch?: boolean })[];
  waitingFolder: (projectId: string) => boolean;
  onOpenSub: (sub: Pick<SubSession, "kind" | "id">, from: string) => void;
  onOpenProject: (projectId: string) => void;
}) {
  const project = projects.find((entry) => entry.id === card.projectId);
  const name = project?.name ?? card.projectName;
  /** 会话名前面那段（随手的为 null）；点开右边页头写的项目名（随手的给空）。 */
  const prefix = project?.scratch ? null : name;
  const from = prefix ?? "";
  const target = card.sub;
  const live = target?.id ? subs.find((entry) => entry.kind === target.kind && entry.id === target.id) : undefined;
  const waiting = waitingFolder(card.projectId);
  const node = card.state !== "active"
    ? <span className={h.dispatchFaded} data-testid="dispatch-faded">{target ? (prefix ? `${prefix} · ` : "") + (live?.title ?? target.title) : name}</span>
    : !target ? (
      <button type="button" className={h.thread} onClick={() => onOpenProject(card.projectId)} data-testid="dispatch-project">
        <span className={h.threadName}>{`${name} ›`}</span>
        {project?.unseen ? <i className={h.threadDot} aria-hidden data-testid="thread-dot" /> : null}
      </button>
    ) : live ? <ThreadChip sub={live} project={prefix ?? undefined} needsYou={waiting} onOpen={(sub) => onOpenSub(sub, from)} />
    : (
      <button type="button" className={h.thread} onClick={() => onOpenSub({ kind: target.kind, id: target.id! }, from)} data-testid="thread-chip">
        {waiting ? <StateIcon state="waiting" /> : null}
        <span className={h.threadName}>{prefix ? <span className={h.threadProject}>{`${prefix} · `}</span> : null}{target.title}</span>
        {waiting ? <span className={h.threadStatus} data-wait="">等你</span> : null}
      </button>
    );
  return <div className={h.dispatch} data-testid="dispatch-chip">{node}</div>;
}
