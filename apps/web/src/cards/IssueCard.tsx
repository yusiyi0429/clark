import type { Card } from "@/lib/api/client";

type IssuePayload = {
  origin?: "radar" | "dri";
  status?: string;
  location?: { level: string; battlefieldId?: string; capabilityId?: string; relatedBattlefieldIds?: string[] };
  urgency?: { level?: string; reason?: string; decisionBy?: string };
  research?: { status?: string; error?: { code?: string; message?: string } | null };
};

function locationLabel(location: IssuePayload["location"]): string {
  if (!location) return "未标注";
  if (location.level === "battlefield") return `战场 · ${location.battlefieldId}`;
  if (location.level === "capability") return `能力 · ${location.capabilityId}`;
  const battlefields = location.relatedBattlefieldIds ?? [];
  return battlefields.length > 0 ? `公司（${battlefields.join("、")}）` : "公司";
}

const RESEARCH_LABELS: Record<string, string> = {
  pending: "预研排队中",
  running: "预研进行中",
  ready: "预研已完成",
  failed: "预研失败",
};

export function IssueCard({ card }: { card: Card }) {
  const payload = card.payload as IssuePayload;
  const research = payload.research;
  return (
    <section aria-labelledby="issue-card-title">
      <p><a href="/">← 返回首页</a></p>
      <h1 id="issue-card-title">{card.title}</h1>
      <p><span>{card.badge}</span> <span>v{card.version}</span></p>
      <dl>
        <dt>归属</dt>
        <dd>{locationLabel(payload.location)}</dd>
        <dt>紧迫度</dt>
        <dd>
          {payload.urgency?.level ?? "gray"}
          {payload.urgency?.decisionBy ? ` · 决定期限 ${payload.urgency.decisionBy}` : ""}
          {payload.urgency?.reason ? ` · ${payload.urgency.reason}` : ""}
        </dd>
        <dt>预研</dt>
        <dd>
          {RESEARCH_LABELS[research?.status ?? ""] ?? "未知状态"}
          {research?.error ? `（${research.error.code}：${research.error.message}）` : ""}
        </dd>
      </dl>
    </section>
  );
}
