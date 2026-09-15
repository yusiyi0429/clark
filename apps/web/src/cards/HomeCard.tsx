"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Card } from "@/lib/api/client";
import { browserApi } from "@/lib/api/client";

type HomePayload = {
  notice?: { text?: string; dismissed?: boolean };
};

export function HomeCard({ card }: { card: Card }) {
  const payload = card.payload as HomePayload;
  const [dismissed, setDismissed] = useState(Boolean(payload.notice?.dismissed));
  const [version, setVersion] = useState(card.version);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function execute(action: Card["actions"][number]) {
    setBusy(true);
    setError(null);
    const { data, response } = await browserApi.POST("/api/actions/execute", {
      body: { actionId: action.actionId, input: {} },
    });
    setBusy(false);
    if (response.status === 401) {
      router.push("/login");
      return;
    }
    if (response.ok && data) {
      const next = data.cards[0];
      if (next) {
        setVersion(next.version);
        setDismissed((next.payload as HomePayload).notice?.dismissed === true);
      }
      return;
    }
    const body = (await response.json()) as { message?: string };
    setError(body.message ?? "Action 执行失败");
  }

  return (
    <section aria-labelledby="home-card-title">
      <h1 id="home-card-title">{card.title}</h1>
      <p>
        <span>{card.badge}</span> <span>v{version}</span>
      </p>
      {payload.notice && !dismissed ? (
        <div>
          <p>{payload.notice.text}</p>
          {card.actions.map((action) => (
            <button key={action.actionId} onClick={() => execute(action)} disabled={busy}>
              {busy ? "提交中…" : action.label}
            </button>
          ))}
        </div>
      ) : (
        <p>本周无待处理通知。</p>
      )}
      {card.navigation?.map((item) => <p key={item.href}><a href={item.href}>{item.label}</a></p>)}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
