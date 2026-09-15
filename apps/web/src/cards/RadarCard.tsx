"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Card } from "@/lib/api/client";
import { browserApi } from "@/lib/api/client";

type RadarPayload = {
  anchors?: { id: string; title: string }[];
  unreadCount?: number;
  lastScheduledAt?: string | null;
  lastRun?: { trigger?: string; status?: string; companyDay?: string; warnings?: string[] } | null;
  sources?: Record<string, { configured?: boolean; sourceCount?: number; message?: string }>;
};

export function RadarCard({ card }: { card: Card }) {
  const payload = card.payload as RadarPayload;
  const [lastRun, setLastRun] = useState(payload.lastRun ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function scan() {
    setBusy(true);
    setError(null);
    const { data, response } = await browserApi.POST("/api/radar/scans/manual");
    setBusy(false);
    if (response.status === 401) {
      router.push("/login");
      return;
    }
    if (response.ok && data) {
      setLastRun(data);
      router.refresh();
      return;
    }
    const body = (await response.json()) as { message?: string };
    setError(body.message ?? "扫描失败");
  }

  return (
    <section aria-labelledby="radar-card-title">
      <p><a href="/">← 返回首页</a> <a href="/signals">Signal 列表</a></p>
      <h1 id="radar-card-title">{card.title}</h1>
      <p><span>v{card.version}</span> {payload.lastRun?.companyDay ? <span>公司日期 {payload.lastRun.companyDay}</span> : null}</p>
      <p>未读 Signal：{payload.unreadCount ?? 0}</p>
      <ul>
        <li>Web Search：{payload.sources?.web?.configured ? "已配置" : "未配置"}</li>
        <li>微信公众号：{payload.sources?.wechat?.message}</li>
      </ul>
      <p>{payload.anchors?.length ? `监测方向：${payload.anchors.map((anchor) => anchor.title).join("、")}` : "尚未配置监测方向"}</p>
      {lastRun ? (
        <p>
          最近运行：{lastRun.trigger === "manual" ? "手动补扫" : "定时扫描"} · {lastRun.status}
          {lastRun.warnings?.length ? <span>（{lastRun.warnings.join("；")}）</span> : null}
        </p>
      ) : <p>尚无运行记录。</p>}
      {payload.lastScheduledAt ? <p>上次定时启动：{payload.lastScheduledAt}</p> : null}
      <button onClick={scan} disabled={busy}>{busy ? "扫描中…" : "手动补扫"}</button>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
