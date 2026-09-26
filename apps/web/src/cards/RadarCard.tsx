"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Modal, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { Database, Link2, RefreshCw, SlidersHorizontal, X } from "lucide-react";
import { browserApi, type Card } from "@/lib/api/client";
import type { CardRenderProps } from "./registry";
import { payloadOf, type RadarPayload, type SignalPayload } from "./payloads";
import { registryName } from "./scopeNames";
import { SignalStory } from "./SignalStory";
import { DetailHeader } from "@/components/shell/DetailHeader";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { monthDayTime } from "@/lib/companyTime";
import w from "@/styles/app-shell.module.css";
import f from "@/styles/radar-feed.module.css";
import a from "@/styles/anchor-editor.module.css";

type ScanResult = { trigger: string; status: string; companyDay: string; createdSignals: number; warnings: string[] };
type Filter = "全部" | "未读" | "收藏";
type SortMode = "time" | "importance";

/** 出窗过滤是常规动作：只计入汇总；其余警告（Provider 失败、候选校验失败等）保持可见。 */
function splitWarnings(warnings: string[]): { outOfWindow: number; notable: string[] } {
  const notable = warnings.filter((warning) => !warning.startsWith("来源超出时间窗"));
  return { outOfWindow: warnings.length - notable.length, notable };
}

/** 三类来源固定标签：outlets 是发布方级媒体来源，不能与微信公众号混用。 */
const SOURCE_LABEL: Record<string, string> = { web: "Web 搜索", wechat: "微信公众号", outlets: "发布方级媒体来源" };

/**
 * 发布方级来源的展示名单。运行时启用清单存在 Radar 配置里，API 只回数量；
 * 这里按当前生效的发布方如实列出，避免为了展示名单新增 API。
 */
// ponytail: 名单写死；运行配置增减发布方时改这里，或等 API 暴露 outletId 列表。
const OUTLET_NAMES = ["BBC", "彭博", "路透社", "金融时报", "CNBC", "经济学人"];

export function radarSourceLabel(key: string): string {
  return SOURCE_LABEL[key] ?? key;
}

/** outlets 只读展示生效名单；其余来源直接用 API 的说明。 */
export function radarSourceMessage(key: string, source: { configured: boolean; message: string }): string {
  if (key === "outlets" && source.configured) return `${OUTLET_NAMES.join("、")} · 只读`;
  return source.message;
}

const RUN_STATUS: Record<string, string> = { completed: "已完成", succeeded: "已完成", running: "进行中", failed: "失败", partial: "部分完成" };

/** 状态行（clark：`{run.phase} · 时间`）：最近一次扫描的方式、结果与时间，按公司时区显示。 */
export function radarStatusLine(payload: RadarPayload, scanning: boolean): string {
  if (scanning) return "正在扫描外部信息";
  if (!payload.lastRun) return "雷达尚未运行 · 定时扫描每天一次";
  const how = payload.lastRun.trigger === "manual" ? "手动刷新" : "定时扫描";
  // 这一次运行自己的时间（手动刷新不会更新 lastScheduledAt）。
  const when = monthDayTime(payload.lastRun.completedAt ?? payload.lastRun.startedAt ?? payload.lastScheduledAt);
  return `${how}${RUN_STATUS[payload.lastRun.status] ?? payload.lastRun.status}${when ? ` · ${when}` : ""} · ${payload.unreadCount} 条未读`;
}

const signalTime = (payload: SignalPayload) => Date.parse(payload.source.publishedAt || payload.collectedAt) || 0;
const importance = (payload: SignalPayload) => payload.assessment.score.impact + payload.assessment.score.urgency;

/** 锚点所在位置：用首页已载入的注册表显示名称，不打印原始 id。 */
function anchorScope(location: { type: string; id?: string }, homeCards: Card[]): string {
  if (location.type === "battlefield") return `战场 · ${registryName(homeCards, "battlefield", location.id) ?? "未登记"}`;
  if (location.type === "capability") return `能力 · ${registryName(homeCards, "capability", location.id) ?? "未登记"}`;
  return "公司";
}

/** 雷达展开页（clark `radar-feed.tsx` 列表态）：一竖列信号，筛选 / 排序 / 监测范围 / 刷新信号。 */
export function RadarCard({ card, collection, onNavigate }: CardRenderProps) {
  const payload = payloadOf<RadarPayload>(card);
  const { homeCards } = useWorkspace();
  const signals = useMemo(() => collection.filter((item) => item.kind === "signal"), [collection]);
  const [filter, setFilter] = useState<Filter>("全部");
  const [sortMode, setSortMode] = useState<SortMode>("time");
  const [configOpen, setConfigOpen] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanPending, setScanPending] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const router = useRouter();

  // 扫描结果只短暂停留；可重试的失败保持可见。
  useEffect(() => {
    if (!scan) return;
    const timer = window.setTimeout(() => setScan(null), 7000);
    return () => window.clearTimeout(timer);
  }, [scan]);

  const anchorTitle = (id: string) => payload.anchors.find((anchor) => anchor.id === id)?.title;
  const visible = useMemo(() => {
    const rows = signals
      .map((item) => ({ card: item, payload: payloadOf<SignalPayload>(item) }))
      .filter((row) => !row.payload.state.dismissed)
      .filter((row) => filter === "全部" || (filter === "未读" && !row.payload.state.read) || (filter === "收藏" && row.payload.state.saved));
    rows.sort((left, right) =>
      sortMode === "importance"
        ? importance(right.payload) - importance(left.payload) || signalTime(right.payload) - signalTime(left.payload)
        : signalTime(right.payload) - signalTime(left.payload) || importance(right.payload) - importance(left.payload),
    );
    return rows;
  }, [signals, filter, sortMode]);

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
    setScanError(response.status === 409 ? "雷达正在运行，请稍后再试。" : body.message ?? "刷新信号失败");
  }

  const warnings = payload.lastRun ? splitWarnings(payload.lastRun.warnings ?? []).notable : [];
  const scanSummary = scan ? splitWarnings(scan.warnings) : null;

  return (
    <>
      <DetailHeader mark="signal" eyebrow="外部信息 · 雷达" title="雷达信号" closeLabel="返回全局" onClose={() => onNavigate("/")} />
      <div className={w.expandedScroll}>
        <div className={f.feed} data-testid="radar-view">
          <div className={f.toolbar}>
            <div className={f.toolbarGroups}>
              <ToggleButtonGroup
                className={f.filters}
                aria-label="雷达筛选"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[filter]}
                onSelectionChange={(keys) => {
                  const next = [...keys][0] as Filter | undefined;
                  if (next) setFilter(next);
                }}
              >
                {(["全部", "未读", "收藏"] as const).map((item) => (
                  <ToggleButton key={item} id={item} size="sm">
                    {item}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
              <ToggleButtonGroup
                className={f.sorts}
                aria-label="雷达排序方式"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[sortMode]}
                onSelectionChange={(keys) => {
                  const next = [...keys][0] as SortMode | undefined;
                  if (next) setSortMode(next);
                }}
              >
                <ToggleButton id="time" size="sm">
                  按时间
                </ToggleButton>
                <ToggleButton id="importance" size="sm">
                  按重要程度
                </ToggleButton>
              </ToggleButtonGroup>
            </div>
            <div className={f.toolbarActions}>
              <Button size="sm" variant="tertiary" aria-label="查看监测范围" aria-haspopup="dialog" aria-expanded={configOpen} onPress={() => setConfigOpen(true)}>
                <SlidersHorizontal size={16} aria-hidden="true" />
                监测范围
              </Button>
              <Button size="sm" variant="tertiary" isDisabled={scanPending} onPress={() => void runScan()}>
                <RefreshCw size={16} className={scanPending ? f.spinning : ""} aria-hidden="true" />
                {scanPending ? "正在扫描" : "刷新信号"}
              </Button>
            </div>
          </div>
          <div className={f.status} role="status">
            {scanSummary
              ? `刷新完成 · 新增 ${scan!.createdSignals} 条信号${scanSummary.outOfWindow ? ` · ${scanSummary.outOfWindow} 条来源超出时间窗` : ""}${scanSummary.notable.length ? ` · ${scanSummary.notable.length} 条其他警告` : ""}`
              : radarStatusLine(payload, scanPending)}
          </div>
          {scanError ? (
            <p className={f.error} role="alert">
              {scanError}
              <Button size="sm" variant="tertiary" onPress={() => void runScan()}>
                重试
              </Button>
            </p>
          ) : null}
          {warnings.length ? <p className={f.error}>{[...new Set(warnings)].join(" ")}</p> : null}

          {visible.length ? (
            <div className={f.stories}>
              {visible.map((row) => (
                <SignalStory key={row.card.id} card={row.card} anchorTitle={anchorTitle(row.payload.assessment.anchorId)} onOpen={onNavigate} />
              ))}
            </div>
          ) : (
            <div className={f.empty}>
              <div className={`${f.orbit} ${scanPending ? f.spinning : ""}`} aria-hidden="true" />
              <h2>{scanPending ? "正在寻找值得关注的变化" : filter === "全部" ? "从公司本体出发，看看外面发生了什么" : "这里暂时没有信号"}</h2>
              <p>
                {filter === "全部" ? "公司目标与监测锚点已经构成监测基线；定时扫描每天运行一次，也可以刷新信号。" : "换一个筛选，或刷新外部信息。"}
              </p>
            </div>
          )}
        </div>
      </div>

      {configOpen ? (
        <Modal isOpen onOpenChange={(open) => (open ? undefined : setConfigOpen(false))}>
          <Modal.Backdrop className={a.backdrop} isDismissable>
            <Modal.Container size="lg">
              <Modal.Dialog className={a.dialog} aria-labelledby="radar-scope-title" aria-describedby="radar-scope-description">
                <header className={a.header}>
                  <div>
                    <span className={a.eyebrow}>雷达 · 公司级监测</span>
                    <h2 id="radar-scope-title">监测范围</h2>
                    <p id="radar-scope-description">从公司本体出发，持续观察可能改变公司判断的外部变化。</p>
                  </div>
                  <Button isIconOnly variant="tertiary" className={a.close} aria-label="关闭监测范围" onPress={() => setConfigOpen(false)}>
                    <X size={19} aria-hidden="true" />
                  </Button>
                </header>
                <div className={a.scroll}>
                  <section className={a.group} aria-labelledby="radar-anchors-title">
                    <div className={a.groupHeading}>
                      <div>
                        <span className={a.groupIcon}>
                          <Database size={15} aria-hidden="true" />
                        </span>
                        <div>
                          <h3 id="radar-anchors-title">监测锚点</h3>
                          <p>
                            {payload.anchors.length} 条 · 时区 {payload.timezone} · 回溯 {payload.lookbackHours} 小时
                          </p>
                        </div>
                      </div>
                      <span className={a.readonly}>当前生效 · 只读</span>
                    </div>
                    {payload.anchors.length ? (
                      <div className={a.ontologyList}>
                        {payload.anchors.map((anchor, index) => (
                          <article key={anchor.id} className={a.ontologyItem}>
                            <span className={a.index}>{String(index + 1).padStart(2, "0")}</span>
                            <div>
                              <small>
                                {anchorScope(anchor.location, homeCards)}
                                {anchor.source && anchor.source !== "manual" ? ` · ${anchor.source}` : ""}
                              </small>
                              <h4>{anchor.title}</h4>
                              <p>{anchor.query}</p>
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className={a.empty}>尚未配置监测锚点。</p>
                    )}
                  </section>
                  <section className={a.group} aria-labelledby="radar-sources-title">
                    <div className={a.groupHeading}>
                      <div>
                        <span className={a.groupIcon}>
                          <Link2 size={15} aria-hidden="true" />
                        </span>
                        <div>
                          <h3 id="radar-sources-title">监测来源</h3>
                          <p>当前启用的外部检索渠道。</p>
                        </div>
                      </div>
                    </div>
                    <div className={a.appendList}>
                      {Object.entries(payload.sources).map(([key, source], index) => (
                        <article key={key} className={a.appendItem}>
                          <span className={a.index}>{String(index + 1).padStart(2, "0")}</span>
                          <div>
                            <h4>{radarSourceLabel(key)}</h4>
                            <p className={a.url}>{radarSourceMessage(key, source)}</p>
                          </div>
                          <span className={a.state} data-on={source.configured ? "true" : "false"}>
                            {source.configured ? "启用" : "未配置"}
                          </span>
                        </article>
                      ))}
                    </div>
                  </section>
                </div>
                <footer className={a.footer}>
                  <div>刷新信号与定时扫描共用同一条管线；监测配置在运营侧维护。</div>
                  <div className={a.actions}>
                    <Button variant="tertiary" onPress={() => setConfigOpen(false)}>
                      关闭
                    </Button>
                  </div>
                </footer>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      ) : null}
    </>
  );
}
