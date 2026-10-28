import type { CSSProperties } from "react";
import {
  CalendarDays, ClipboardCheck, FileText, Flag, Gavel, Inbox, Lightbulb, MessageSquareReply, MessagesSquare,
  Network, Radar, Send, UserCheck, Waypoints, type LucideIcon,
} from "lucide-react";
import s from "@/styles/context-mark.module.css";

/** monthly 是旧名，等同 review。 */
export type ContextMarkKind =
  | "request" | "impact" | "record" | "meeting" | "review" | "mission" | "m2"
  | "decision" | "issue" | "unplaced" | "signal" | "assign" | "progress" | "chat" | "monthly";

const MARKS: Record<ContextMarkKind, { icon: LucideIcon; tone: string }> = {
  request: { icon: Send, tone: "slate" },
  impact: { icon: Waypoints, tone: "plum" },
  record: { icon: FileText, tone: "teal" },
  meeting: { icon: CalendarDays, tone: "blue" },
  review: { icon: ClipboardCheck, tone: "amber" },
  monthly: { icon: ClipboardCheck, tone: "amber" },
  mission: { icon: Flag, tone: "sage" },
  m2: { icon: Network, tone: "violet" },
  decision: { icon: Gavel, tone: "rose" },
  issue: { icon: Lightbulb, tone: "cyan" },
  unplaced: { icon: Inbox, tone: "neutral" },
  signal: { icon: Radar, tone: "cyan" },
  assign: { icon: UserCheck, tone: "rose" },
  progress: { icon: MessageSquareReply, tone: "slate" },
  chat: { icon: MessagesSquare, tone: "slate" },
};

/** 通知分组与工作区的对象标记：灰白玻璃方块 + 线条图标，每类叠一层很淡的底色。 */
export function ContextMark({ kind, className = "", style }: { kind: ContextMarkKind; className?: string; style?: CSSProperties }) {
  const { icon: Icon, tone } = MARKS[kind];
  return (
    <span className={`${s.mark} ${className}`} style={style} data-context-mark={kind} data-tone={tone} aria-hidden="true">
      <Icon size={17} />
    </span>
  );
}
