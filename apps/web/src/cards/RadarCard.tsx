"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ExternalLink, Radar } from "lucide-react";
import { browserApi } from "@/lib/api/client";
import type { CardRenderProps } from "./registry";
import { payloadOf, type RadarPayload, type SignalPayload } from "./payloads";
import f from "@/styles/radar-feed.module.css";
import a from "@/styles/radar-config.module.css";

type ScanResult = { trigger: string; status: string; companyDay: string; createdSignals: number; warnings: string[] };

/** Radar 视图：真实 Signal 列表 + 筛选/排序 + 手动补扫 + 只读监测范围。 */
export function RadarCard({ card, collection, onNavigate }: CardRenderProps) {
  const payload = payloadOf<RadarPayload>(card);
  const signals = useMemo(() => collection.filter((item) => item.kind === "signal"), [collection]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [sort, setSort] = useState<"latest" | "impact">("latest");
  const [configOpen, setConfigOpen] = useState(false);
  const configTrigger = useRef<HTMLButtonElement>(null);
  const configClose = useRef<HTMLButtonElement>(null);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanPending, setScanPending] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const router = useRouter();

  const visible = useMemo(() => {
    const rows = signals
      .map((item) => ({ card: item, payload: payloadOf<SignalPayload>(item) }))
      .filter((row) => !row.payload.state.dismissed)
      .filter((row) => (unreadOnly ? !row.payload.state.read : true));
    rows.sort((left, right) =>
      sort === "impact"
        ? right.payload.assessment.score.impact + right.payload.assessment.score.urgency - (left.payload.assessment.score.impact + left.payload.assessment.score.urgency)
        : Date.parse(right.payload.collectedAt) - Date.parse(left.payload.collectedAt),
    );
    return rows;
  }, [signals, unreadOnly, sort]);

  // 监测范围是模态层：Escape 只关闭它，焦点进入后归还给触发按钮。
  useEffect(() => {
    if (!configOpen) return;
    configClose.current?.focus({ preventScroll: true });
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setConfigOpen(false);
      configTrigger.current?.focus({ preventScroll: true });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [configOpen]);

  async function runScan() {
    setScanPending(true);
    setScanError(null);
    const { data, error, response } = await browserApi.POST("/api/radar/scans/manual");
    setScanPending(false);
    if (response.status === 401) {
      onNavigate("/access");
      return;
    }
    if (response.ok && data) {
      setScan(data as ScanResult);
      router.refresh();
      return;
    }
    const body = (error ?? {}) as { message?: string };
    setScanError(response.status === 409 ? "Radar 正在运行，请稍后再试。" : body.message ?? "手动补扫失败");
  }

  return (
    <div className={f.feed} data-testid="radar-view">
      <div className={f.toolbar}>
        <div className={f.toolbarGroups}>
          <button type="button" className={f.back} onClick={() => onNavigate("/")}>
            <ChevronLeft size={15} aria-hidden="true" />
            返回首页
          </button>
          <div className={f.filters} role="group" aria-label="Signal 筛选">
            <button type="button" aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>
              全部
            </button>
            <button type="button" aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>
              未读
            </button>
          </div>
          <div className={f.sorts} role="group" aria-label="Signal 排序">
            <button type="button" aria-pressed={sort === "latest"} onClick={() => setSort("latest")}>
              最新采集
            </button>
            <button type="button" aria-pressed={sort === "impact"} onClick={() => setSort("impact")}>
              影响优先
            </button>
          </div>
        </div>
        <div className={f.toolbarActions}>
          <button ref={configTrigger} type="button" onClick={() => setConfigOpen(true)}>
            <Radar size={14} aria-hidden="true" />
            监测范围
          </button>
          <button type="button" disabled={scanPending} onClick={() => void runScan()}>
            {scanPending ? "扫描中…" : "手动补扫"}
          </button>
        </div>
      </div>

      <p className={f.status}>
        {payload.unreadCount} 条未读 · 定时扫描 {payload.lastRun?.companyDay ?? "尚未运行"}
        {payload.lastRun ? ` · 最近一次${payload.lastRun.trigger === "manual" ? "手动补扫" : "定时扫描"}：${payload.lastRun.status}` : ""}
        {payload.lastScheduledAt ? ` · 上次启动 ${payload.lastScheduledAt.slice(0, 16).replace("T", " ")}` : ""}
      </p>
      {payload.lastRun?.warnings?.length ? (
        <p className={f.error} role="status">
          {payload.lastRun.warnings.join("；")}
        </p>
      ) : null}
      {scan ? (
        <p className={f.status} role="status">
          手动补扫完成：新增 {scan.createdSignals} 条 Signal（公司日期 {scan.companyDay}）
          {scan.warnings.length ? ` · ${scan.warnings.join("；")}` : ""}
        </p>
      ) : null}
      {scanError ? (
        <p className={f.error} role="alert">
          {scanError}
          <button type="button" onClick={() => void runScan()}>
            重试
          </button>
        </p>
      ) : null}

      {visible.length ? (
        <div className={f.stories}>
          {visible.map((row) => (
            <button
              key={row.card.id}
              type="button"
              className={f.story}
              onClick={() => onNavigate(`/radar/signals/${row.card.objectRef.id}`)}
            >
              <span className={f.meta}>
                {row.card.badge ?? "Web"} · {row.payload.source.title}
              </span>
              <h2>{row.payload.assessment.summary}</h2>
              <p>{row.payload.assessment.strategicImpact}</p>
              <span className={f.storyBottom}>
                {row.payload.state.read ? "已读" : "未读"}
                {row.payload.state.saved ? " · 已收藏" : ""} · 影响 {row.payload.assessment.score.impact}/5
                <ExternalLink size={12} aria-hidden="true" />
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className={f.empty}>
          <div className={`${f.orbit} ${scanPending ? f.spinning : ""}`} aria-hidden="true" />
          <h2>还没有可读的 Signal</h2>
          <p>定时扫描每天自动运行一次；也可以手动补扫。来源未配置时这里会保持为空。</p>
        </div>
      )}

      {configOpen ? (
        <div className={a.dialog} role="dialog" aria-modal="true" aria-label="监测范围">
          <header className={a.header}>
            <div>
              <span className={a.eyebrow}>RADAR</span>
              <h2>监测范围</h2>
              <p>WarMap 不提供配置写入入口；这里如实展示当前生效的锚点与来源。</p>
            </div>
            <button
              ref={configClose}
              type="button"
              className={a.close}
              onClick={() => {
                setConfigOpen(false);
                configTrigger.current?.focus({ preventScroll: true });
              }}
              aria-label="关闭监测范围"
            >
              ×
            </button>
          </header>
          <div className={a.scroll}>
            <section className={a.group}>
              <div className={a.groupHeading}>
                <div>
                  <h3>监测锚点</h3>
                  <p>{payload.anchors.length} 条 · 时区 {payload.timezone} · 回溯 {payload.lookbackHours}h</p>
                </div>
              </div>
              {payload.anchors.length ? (
                <div className={a.ontologyList}>
                  {payload.anchors.map((anchor, index) => (
                    <div key={anchor.id} className={a.ontologyItem}>
                      <span className={a.index}>{String(index + 1).padStart(2, "0")}</span>
                      <div>
                        <small>
                          {anchor.location.type === "company" ? "公司" : anchor.location.type === "battlefield" ? `战场 · ${anchor.location.id}` : `能力 · ${anchor.location.id}`}
                          {anchor.source ? ` · ${anchor.source}` : ""}
                        </small>
                        <h4>{anchor.title}</h4>
                        <p>{anchor.query}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className={a.empty}>尚未配置监测锚点。</p>
              )}
            </section>
            <section className={a.group}>
              <div className={a.groupHeading}>
                <div>
                  <h3>来源</h3>
                  <p>普通 Web 搜索与指定微信公众号账号级来源</p>
                </div>
              </div>
              <div className={a.appendList}>
                {Object.entries(payload.sources).map(([key, source]) => (
                  <div key={key} className={a.appendItem}>
                    <span className={a.index} aria-hidden="true" />
                    <div>
                      <h4>{key === "web" ? "Web 搜索" : "微信公众号"}</h4>
                      <p className={a.url}>{source.message}</p>
                    </div>
                    <span>{source.configured ? "启用" : "未配置"}</span>
                  </div>
                ))}
              </div>
            </section>
          </div>
          <footer className={a.footer}>
            <div>手动补扫与定时扫描共用同一条管线。</div>
            <div className={a.actions}>
              <button type="button" onClick={() => setConfigOpen(false)}>
                关闭
              </button>
            </div>
          </footer>
        </div>
      ) : null}
    </div>
  );
}
