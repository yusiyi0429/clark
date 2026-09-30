import type { components } from "@/lib/api/schema";

export type MissionGroupView = components["schemas"]["MissionCardGroupView"];
export type MissionGroupEntry = MissionGroupView["entries"][number];
export type FeedbackRequest = components["schemas"]["CreateMissionCardFeedbackRequest"];
export type MissionGroupPhase = "draft" | "open" | "closed" | "reviewing" | "confirmed";
export type MissionGroupReference = {
  missionId: string;
  field: NonNullable<FeedbackRequest["field"]>;
  quote: string;
  sourceVersion: number;
  nonce: number;
};
export type PersonalMissionGroup = {
  kind?: "mission-card";
  cardId: string;
  viewerId: string;
  members: { personId: string; displayName: string }[];
  phase: MissionGroupPhase;
  round: number;
  onRefresh: () => void;
  reference?: MissionGroupReference | null;
  onRemoveReference: () => void;
};

export type TaskGroup = {
  kind: "task";
  taskId: string;
  viewerId: string;
  members: { personId: string; displayName: string }[];
};

export type ThreadGroup = {
  kind: "thread";
  objectType: "issue" | "meeting";
  objectId: string;
  viewerId: string;
  members: { personId: string; displayName: string }[];
};

export type DetailGroup = PersonalMissionGroup | TaskGroup | ThreadGroup;

export function groupInputState(phase: MissionGroupPhase) {
  if (phase === "draft") return { writable: false, placeholder: "讨论还没开放" };
  if (phase === "confirmed") return { writable: false, placeholder: "本月 Mission Card 已确定" };
  return { writable: true, placeholder: phase === "open" ? "输入你的想法…" : "讨论结束后留言 · 待后续审核" };
}

export function mergeGroupEntries(previous: MissionGroupEntry[], incoming: MissionGroupEntry[]): MissionGroupEntry[] {
  const key = (entry: MissionGroupEntry) => entry.type === "message" ? `message:${entry.feedback.id}` : `${entry.type}:${entry.at}:${entry.text}`;
  const at = (entry: MissionGroupEntry) => entry.type === "message" ? entry.feedback.createdAt : entry.at;
  const order = { divider: 0, opening: 1, message: 2 };
  // after 只筛选意见；服务端每次重算完整分隔线。重开时替换旧截止说明，不叠出两条。
  const entries = new Map<string, MissionGroupEntry>(previous.filter((entry) => entry.type === "message").map((entry) => [key(entry), entry]));
  incoming.forEach((entry) => entries.set(key(entry), entry));
  return [...entries.values()].sort((a, b) => Date.parse(at(a)) - Date.parse(at(b)) || order[a.type] - order[b.type] || (a.type === "message" && b.type === "message" ? a.feedback.seq - b.feedback.seq : 0));
}
