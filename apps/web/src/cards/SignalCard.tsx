"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Card } from "@/lib/api/client";
import { browserApi } from "@/lib/api/client";

type SignalPayload = {
  source?: { type?: string; title?: string; url?: string; excerpt?: string; publishedAt?: string };
  assessment?: { summary?: string; strategicImpact?: string; evidenceQuote?: string; unknowns?: string[] };
  state?: { read?: boolean; saved?: boolean; dismissed?: boolean };
};

export function SignalCard({ card }: { card: Card }) {
  const [payload, setPayload] = useState(card.payload as SignalPayload);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const state = payload.state ?? {};

  async function update(next: { read?: boolean; saved?: boolean; dismissed?: boolean }) {
    setBusy(true);
    setError(null);
    const { data, response } = await browserApi.PATCH("/api/signals/{id}/state", {
      params: { path: { id: card.objectRef.id } },
      body: next,
    });
    setBusy(false);
    if (response.status === 401) {
      router.push("/login");
      return;
    }
    const updated = data?.cards[0];
    if (response.ok && updated) {
      setPayload(updated.payload as SignalPayload);
      return;
    }
    const body = (await response.json()) as { message?: string };
    setError(body.message ?? "Signal 状态更新失败");
  }

  return (
    <section aria-labelledby="signal-card-title">
      <p>
        <a href="/">← 返回首页</a> <a href="/signals">Signal 列表</a>
      </p>
      <h1 id="signal-card-title">{card.title}</h1>
      <p>
        <span>{card.badge}</span> <span>v{card.version}</span>
        {state.read ? <span> 已读</span> : <span> 未读</span>}
        {state.saved ? <span> 已收藏</span> : null}
        {state.dismissed ? <span> 已隐藏</span> : null}
      </p>
      <p>{payload.assessment?.strategicImpact}</p>
      <blockquote>
        <p>{payload.assessment?.evidenceQuote}</p>
        <footer>
          来源：
          <a href={payload.source?.url} rel="noreferrer noopener" target="_blank">{payload.source?.title}</a>
          {payload.source?.publishedAt ? <span>（{payload.source.publishedAt}）</span> : null}
        </footer>
      </blockquote>
      {payload.assessment?.unknowns?.length ? (
        <ul>
          {payload.assessment.unknowns.map((item) => <li key={item}>{item}</li>)}
        </ul>
      ) : null}
      <p>
        <button onClick={() => update({ read: !state.read })} disabled={busy}>
          {state.read ? "标记未读" : "标记已读"}
        </button>{" "}
        <button onClick={() => update({ saved: !state.saved })} disabled={busy}>
          {state.saved ? "取消收藏" : "收藏"}
        </button>{" "}
        <button onClick={() => update({ dismissed: !state.dismissed })} disabled={busy}>
          {state.dismissed ? "取消隐藏" : "隐藏"}
        </button>
      </p>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
