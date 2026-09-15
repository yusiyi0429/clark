import type { Card } from "@/lib/api/client";

export function IssueCard({ card }: { card: Card }) {
  const payload = card.payload as { summary?: string };
  return (
    <section aria-labelledby="issue-card-title">
      <p><a href="/">← 返回首页</a></p>
      <h1 id="issue-card-title">{card.title}</h1>
      <p><span>{card.badge}</span> <span>v{card.version}</span></p>
      <p>{payload.summary}</p>
    </section>
  );
}
