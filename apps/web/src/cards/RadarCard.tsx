"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Modal, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { Bookmark, Database, Link2, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { MenuDialog } from "@/components/AccountMenu";
import { RadarSettingsEditor } from "@/components/radar/RadarSettingsEditor";
import { RADAR_SETTINGS_CHANGED } from "@/components/radar/personalRadar";
import { browserApi, type Card } from "@/lib/api/client";
import type { CardRenderProps } from "./registry";
import { payloadOf, type RadarPayload, type SignalPayload } from "./payloads";
import { registryName } from "./scopeNames";
import { SignalStoryView } from "./SignalStory";
import { DetailHeader } from "@/components/shell/DetailHeader";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { calendarDate, monthDayTime, publishedDate } from "@/lib/companyTime";
import w from "@/styles/app-shell.module.css";
import f from "@/styles/radar-feed.module.css";
import a from "@/styles/anchor-editor.module.css";

type ScanResult = { trigger: string; status: string; companyDay: string; createdSignals: number; warnings: string[] };
export type RadarSortMode = "importance" | "time";
export type RadarReadFilter = "all" | "unread" | "read";
export type RadarDatePreset = "all" | "7d" | "30d" | "custom";
/** 阅读状态、收藏、发布日期三类筛选彼此独立、取交集；排序不属于筛选。from / to 是公司时区的「YYYY-MM-DD」，仅 custom 使用。 */
export type RadarFilters = { read: RadarReadFilter; savedOnly: boolean; date: RadarDatePreset; from: string; to: string };
export type RadarView = { sort: RadarSortMode; filters: RadarFilters };
export type RadarViewAction = { type: "sort"; sort: RadarSortMode } | { type: "filter"; patch: Partial<RadarFilters> } | { type: "clear" };

export const RADAR_DEFAULT_FILTERS: RadarFilters = { read: "all", savedOnly: false, date: "all", from: "", to: "" };
/** 首次打开：按重要程度（原生 impact + urgency）排序，不加任何筛选。 */
export const RADAR_DEFAULT_VIEW: RadarView = { sort: "importance", filters: RADAR_DEFAULT_FILTERS };

/** 换排序只改排序、筛选原样保留；清空筛选只复位筛选、排序原样保留。 */
export function radarViewReducer(view: RadarView, action: RadarViewAction): RadarView {
  if (action.type === "sort") return view.sort === action.sort ? view : { ...view, sort: action.sort };
  if (action.type === "filter") return { ...view, filters: { ...view.filters, ...action.patch } };
  return { ...view, filters: RADAR_DEFAULT_FILTERS };
}

export function radarFiltersActive(filters: RadarFilters): boolean {
  return filters.read !== "all" || filters.savedOnly || filters.date !== "all";
}

const READ_LABEL: Record<RadarReadFilter, string> = { all: "全部", unread: "未读", read: "已读" };
/** 监测方向从哪来：不露内部来源名（ontology 等）。 */
const ANCHOR_SOURCE: Record<string, string> = { ontology: "来自本月计划", "meeting-reopen": "会议复议条件" };
const DATE_LABEL: Record<RadarDatePreset, string> = { all: "全部日期", "7d": "近 7 天", "30d": "近 30 天", custom: "自定义" };

type SignalScore = { relevance: number; impact: number; urgency: number };
/** API 投影：没有真实研判的信号 score 为 null、scoreStatus 为 unassessed（未评估），不是 0 分。 */
type RadarSignalPayload = Omit<SignalPayload, "assessment"> & {
  assessment: Omit<SignalPayload["assessment"], "score"> & { score: SignalScore | null; scoreStatus?: "assessed" | "unassessed" };
};
type RadarRow = { card: Card; payload: RadarSignalPayload };

/** 原生重要度 = impact + urgency（各 0–5，合计 0–10）；未评估返回 null，排序时排在已评估之后，不当作 0 分。 */
export function radarImportance(payload: RadarSignalPayload): number | null {
  const { score, scoreStatus } = payload.assessment;
  if (scoreStatus === "unassessed" || !score) return null;
  const value = score.impact + score.urgency;
  return Number.isFinite(value) ? value : null;
}

export function radarImportanceLabel(payload: RadarSignalPayload): string {
  const value = radarImportance(payload);
  return value === null ? "重要度未评估" : `重要度 ${value}/10`;
}

const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const companyToday = () => calendarDate(new Date().toISOString());

/** 日期筛选的闭区间（公司时区的发布日）。近 N 天含今天；自定义可只填一端，起止颠倒时按先后对调。 */
export function radarDateWindow(filters: RadarFilters, today: string): { from?: string; to?: string } | null {
  if (filters.date === "7d") return { from: shiftDay(today, -6) };
  if (filters.date === "30d") return { from: shiftDay(today, -29) };
  if (filters.date !== "custom" || (!filters.from && !filters.to)) return null;
  const [from, to] = filters.from && filters.to && filters.from > filters.to ? [filters.to, filters.from] : [filters.from, filters.to];
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

/** 空态里如实写出是哪些条件把信号排除了。 */
export function radarFilterSummary(filters: RadarFilters): string {
  const parts: string[] = [];
  if (filters.read !== "all") parts.push(READ_LABEL[filters.read]);
  if (filters.savedOnly) parts.push("已收藏");
  if (filters.date === "custom") {
    const range = radarDateWindow(filters, "");
    if (range?.from && range.to) parts.push(`发布于 ${range.from} 至 ${range.to}`);
    else if (range?.from) parts.push(`发布于 ${range.from} 及以后`);
    else if (range?.to) parts.push(`发布于 ${range.to} 及以前`);
  } else if (filters.date !== "all") parts.push(`发布于${DATE_LABEL[filters.date]}`);
  return parts.join(" · ");
}

const signalTime = (payload: RadarSignalPayload) => Date.parse(payload.source.publishedAt || payload.collectedAt) || 0;
const signalDay = (payload: RadarSignalPayload) => {
  const day = calendarDate(payload.source.publishedAt || payload.collectedAt);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "";
};
const byTime = (left: RadarRow, right: RadarRow) => signalTime(right.payload) - signalTime(left.payload);
const byImportance = (left: RadarRow, right: RadarRow) => {
  const l = radarImportance(left.payload), r = radarImportance(right.payload);
  if (l === r) return 0;
  if (l === null) return 1;
  if (r === null) return -1;
  return r - l;
};
const byId = (left: RadarRow, right: RadarRow) => (left.card.id < right.card.id ? -1 : left.card.id > right.card.id ? 1 : 0);

/**
 * 列表 = 未隐藏信号 ∩ 阅读状态 ∩ 收藏 ∩ 发布日期，再排序。
 * 重要程度：重要度高→低（未评估排最后）→ 发布时间新→旧 → id；按时间：发布时间新→旧 → 重要度 → id。
 */
export function radarVisibleSignals(signals: Card[], view: RadarView, today: string): RadarRow[] {
  const { read, savedOnly } = view.filters;
  const window = radarDateWindow(view.filters, today);
  const rows = signals
    .map((card) => ({ card, payload: payloadOf<RadarSignalPayload>(card) }))
    .filter(({ payload }) => !payload.state.dismissed)
    .filter(({ payload }) => read === "all" || (read === "read") === payload.state.read)
    .filter(({ payload }) => !savedOnly || payload.state.saved)
    .filter(({ payload }) => {
      if (!window) return true;
      const day = signalDay(payload);
      return Boolean(day) && (!window.from || day >= window.from) && (!window.to || day <= window.to);
    });
  return rows.sort(
    view.sort === "importance"
      ? (l, r) => byImportance(l, r) || byTime(l, r) || byId(l, r)
      : (l, r) => byTime(l, r) || byImportance(l, r) || byId(l, r),
  );
}

/** 三类来源固定标签：outlets 是发布方级媒体来源，不能与微信公众号混用。 */
const SOURCE_LABEL: Record<string, string> = { web: "Web 搜索", wechat: "微信公众号", outlets: "发布方级媒体来源" };

export function radarSourceLabel(key: string): string {
  return SOURCE_LABEL[key] ?? key;
}

/** outlets 如实列出负载里当前启用的发布方（在「雷达设置」里增减）；其余来源直接用 API 的说明。 */
export function radarSourceMessage(key: string, source: { configured: boolean; message: string; names?: string[] }): string {
  if (key === "outlets" && source.configured && source.names?.length) return `${source.names.join("、")} · 只读`;
  return source.message;
}

const RUN_STATUS: Record<string, string> = { completed: "已完成", succeeded: "已完成", running: "进行中", failed: "失败", partial: "部分完成" };

/** 状态行（clark：`{run.phase} · 时间`）：最近一次扫描的方式、结果与时间，按公司时区显示。 */
export function radarStatusLine(payload: RadarPayload, scanning: boolean, scheduled = true): string {
  if (scanning) return "正在扫描外部信息";
  if (!payload.lastRun) return scheduled ? "尚未扫描 · 每天定时扫描一次" : "尚未扫描 · 点击「发现更多」开始";
  const how = payload.lastRun.trigger === "manual" ? "手动刷新" : "定时扫描";
  // 这一次运行自己的时间（手动刷新不会更新 lastScheduledAt）。
  const when = monthDayTime(payload.lastRun.completedAt ?? payload.lastRun.startedAt ?? payload.lastScheduledAt);
  return `${how}${RUN_STATUS[payload.lastRun.status] ?? payload.lastRun.status}${when ? ` · ${when}` : ""} · ${payload.unreadCount} 条未读`;
}

export function radarScanStatusLine(scan: ScanResult): string {
  return `${scan.status === "completed" || scan.status === "succeeded" ? "刷新完成" : "扫描未完成"} · 新增 ${scan.createdSignals} 条信号`;
}

/** 锚点所在位置：用首页已载入的注册表显示名称，不打印原始 id。 */
function anchorScope(location: { type: string; id?: string }, homeCards: Card[]): string {
  if (location.type === "battlefield") return `战场 · ${registryName(homeCards, "battlefield", location.id) ?? "未登记"}`;
  if (location.type === "capability") return `能力 · ${registryName(homeCards, "capability", location.id) ?? "未登记"}`;
  return "公司";
}

/** 雷达展开页（clark `radar-feed.tsx` 列表态）：一竖列信号，筛选 / 排序 / 监测范围 / 发现更多。 */
export function RadarCard({ card, collection, onCard, onNavigate, initialView = RADAR_DEFAULT_VIEW }: CardRenderProps & { initialView?: RadarView }) {
  const payload = payloadOf<RadarPayload>(card);
  const { homeCards } = useWorkspace();
  const signals = useMemo(() => collection.filter((item) => item.kind === "signal"), [collection]);
  const [view, dispatch] = useReducer(radarViewReducer, initialView);
  const [configOpen, setConfigOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [scanPending, setScanPending] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const scanInFlight = useRef(false);
  const router = useRouter();

  // 在「雷达设置」（这里或个人菜单）改了公司雷达：重读雷达卡，「监测范围」马上是新的方向与媒体。
  useEffect(() => {
    const changed = () => {
      void browserApi.GET("/api/cards/radar").then(({ data }) => {
        const updated = data?.cards[0];
        if (updated) onCard(updated);
      }, () => undefined);
    };
    window.addEventListener(RADAR_SETTINGS_CHANGED, changed);
    return () => window.removeEventListener(RADAR_SETTINGS_CHANGED, changed);
  }, [onCard]);

  // 扫描结果只短暂停留；可重试的失败保持可见。
  useEffect(() => {
    if (!scan || scan.status === "failed") return;
    const timer = window.setTimeout(() => setScan(null), 7000);
    return () => window.clearTimeout(timer);
  }, [scan]);

  const anchorTitle = (id: string) => payload.anchors.find((anchor) => anchor.id === id)?.title;
  // 「今天」按公司时区（Asia/Shanghai）取日期，与发布日期同一口径。
  // 近 7/30 天按业务日计算：演示场次用资料包的业务日期，不随电脑当天漂移。
  const businessDate = (card.payload as { businessDate?: string }).businessDate;
  const visible = useMemo(() => radarVisibleSignals(signals, view, businessDate ?? companyToday()), [signals, view, businessDate]);
  const available = useMemo(() => signals.filter((item) => !payloadOf<SignalPayload>(item).state.dismissed).length, [signals]);
  const filtersActive = radarFiltersActive(view.filters);
  const setFilters = (patch: Partial<RadarFilters>) => dispatch({ type: "filter", patch });
  const clearFilters = () => dispatch({ type: "clear" });

  async function runScan() {
    if (scanInFlight.current) return;
    scanInFlight.current = true;
    setScanPending(true);
    setScanError(null);
    setScan(null);
    try {
      const { data, error, response } = await browserApi.POST("/api/radar/scans/manual");
      if (response.status === 401) {
        onNavigate("/access");
        return;
      }
      if (!response.ok || !data) {
        const body = (error ?? {}) as { message?: string };
        setScanError(response.status === 409 ? "雷达正在运行，请稍后再试。" : body.message ?? "发现更多失败");
        return;
      }
      setScan(data);
      if (data.status === "failed") setScanError("扫描未完成，请重试。");
      // The detail panel owns its collection; a route refresh alone preserves that client state.
      const [radarResult, signalResult] = await Promise.all([
        browserApi.GET("/api/cards/radar"),
        browserApi.GET("/api/cards/signals"),
      ]);
      for (const updated of [...(radarResult.data?.cards ?? []), ...(signalResult.data?.cards ?? [])]) onCard(updated);
      if (!radarResult.response.ok || !signalResult.response.ok) setScanError("扫描已结束，结果未能完整载入。请刷新页面查看。");
      router.refresh();
    } catch {
      setScanError("网络连接中断，暂时无法读取扫描结果。请稍后重试。");
    } finally {
      scanInFlight.current = false;
      setScanPending(false);
    }
  }

  // 服务端只把「本轮真的出了问题」写进 warnings（常规记录只进日志），这里原样展示。
  const warnings = scanPending ? [] : scan?.warnings ?? payload.lastRun?.warnings ?? [];

  return (
    <>
      <DetailHeader mark="signal" eyebrow="外部信息 · 雷达" title="雷达信号" closeLabel="返回全局" onClose={() => onNavigate("/")} />
      <div className={w.expandedScroll}>
        <div className={f.feed} data-testid="radar-view">
          <div className={f.toolbar}>
            <div className={f.toolbarGroups}>
              <ToggleButtonGroup
                className={f.filters}
                aria-label="阅读状态筛选"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[view.filters.read]}
                onSelectionChange={(keys) => {
                  const next = [...keys][0] as RadarReadFilter | undefined;
                  if (next) setFilters({ read: next });
                }}
              >
                {(["all", "unread", "read"] as const).map((item) => (
                  <ToggleButton key={item} id={item} size="sm">
                    {READ_LABEL[item]}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
              <ToggleButton size="sm" aria-label="只看收藏" isSelected={view.filters.savedOnly} onChange={(savedOnly) => setFilters({ savedOnly })}>
                <Bookmark size={15} fill={view.filters.savedOnly ? "currentColor" : "none"} aria-hidden="true" />
                收藏
              </ToggleButton>
              {/* 发布日期只留「近 7 天」一个开关：关着就是全部日期（「全部」已在阅读状态里出现过一次）。 */}
              <ToggleButton size="sm" aria-label="只看近 7 天" isSelected={view.filters.date === "7d"} onChange={(recent) => setFilters({ date: recent ? "7d" : "all" })}>
                {DATE_LABEL["7d"]}
              </ToggleButton>
              {filtersActive ? (
                <span className={f.meta}>
                  <span>{`显示 ${visible.length} / ${available} 条`}</span>
                  <Button size="sm" variant="tertiary" onPress={clearFilters}>
                    清空筛选
                  </Button>
                </span>
              ) : null}
            </div>
            {/* 同一排：左边是「看哪些」，右边是「怎么排、看什么范围、再去找」。 */}
            <div className={f.toolbarActions}>
              <ToggleButtonGroup
                className={f.sorts}
                aria-label="雷达排序方式"
                selectionMode="single"
                disallowEmptySelection
                selectedKeys={[view.sort]}
                onSelectionChange={(keys) => {
                  const next = [...keys][0] as RadarSortMode | undefined;
                  if (next) dispatch({ type: "sort", sort: next });
                }}
              >
                <ToggleButton id="importance" size="sm">
                  按重要程度
                </ToggleButton>
                <ToggleButton id="time" size="sm">
                  按时间
                </ToggleButton>
              </ToggleButtonGroup>
              <span className={f.toolbarRule} aria-hidden="true" />
              <Button size="sm" variant="tertiary" aria-label="查看监测范围" aria-haspopup="dialog" aria-expanded={configOpen} onPress={() => setConfigOpen(true)}>
                <SlidersHorizontal size={16} aria-hidden="true" />
                监测范围
              </Button>
              <Button size="sm" variant="tertiary" className={f.discover} data-pending={scanPending || undefined} isDisabled={scanPending} onPress={() => void runScan()}>
                <Sparkles size={16} aria-hidden="true" />
                {scanPending ? "正在发现" : "发现更多"}
              </Button>
            </div>
          </div>
          <div className={f.status} role="status">
            {scanPending ? radarStatusLine(payload, true, true) : scan ? radarScanStatusLine(scan) : radarStatusLine(payload, false, true)}
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
              {visible.map((row) => {
                const id = row.card.objectRef.id;
                const { state } = row.payload;
                return (
                  <SignalStoryView
                    key={row.card.id}
                    href={`/radar/signals/${id}`}
                    imageSrc={row.payload.source.images?.length ? `/api/signals/${id}/images/0` : undefined}
                    title={row.payload.source.title}
                    summary={row.payload.assessment.summary}
                    meta={`${row.card.badge ?? "Web"} · ${publishedDate(row.payload.source.publishedAt)} · ${anchorTitle(row.payload.assessment.anchorId) ?? "公司监测"} · ${radarImportanceLabel(row.payload)}`}
                    status={`${state.read ? "已读" : "新信号"}${state.saved ? " · 已收藏" : ""}`}
                    onOpen={onNavigate}
                  />
                );
              })}
            </div>
          ) : available ? (
            // 有信号但全被筛选条件排除：如实说明是筛选造成的空列表，并给出恢复入口。
            <div className={f.empty} data-empty="filtered">
              <div className={f.orbit} aria-hidden="true" />
              <h2>当前筛选条件排除了全部信号</h2>
              <p>{`${available} 条信号都不满足「${radarFilterSummary(view.filters)}」。清空筛选即可恢复全部信号。`}</p>
              <Button className={f.emptyAction} variant="tertiary" onPress={clearFilters}>
                清空筛选
              </Button>
            </div>
          ) : (
            <div className={f.empty}>
              <div className={`${f.orbit} ${scanPending ? f.spinning : ""}`} aria-hidden="true" />
              <h2>{scanPending ? "正在扫描外部变化" : "暂无信号，点击「发现更多」开始扫描"}</h2>
              <p>
                每天定时扫描一次，也可点「发现更多」立即扫描。
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
                    <p id="radar-scope-description">持续观察可能改变公司判断的外部变化。</p>
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
                          <h3 id="radar-anchors-title">监测方向</h3>
                          <p>
                            {payload.anchors.length} 条 · 每次看最近 {payload.lookbackHours} 小时
                          </p>
                        </div>
                      </div>
                      <span className={a.readonly}>当前生效</span>
                    </div>
                    {payload.anchors.length ? (
                      <div className={a.ontologyList}>
                        {payload.anchors.map((anchor, index) => (
                          <article key={anchor.id} className={a.ontologyItem}>
                            <span className={a.index}>{String(index + 1).padStart(2, "0")}</span>
                            <div>
                              <small>
                                {anchorScope(anchor.location, homeCards)}
                                {anchor.source && ANCHOR_SOURCE[anchor.source] ? ` · ${ANCHOR_SOURCE[anchor.source]}` : ""}
                              </small>
                              <h4>{anchor.title}</h4>
                              <p>{anchor.query}</p>
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className={a.empty}>尚未设置监测方向。</p>
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
                  <div>「发现更多」与定时扫描共用同一条管线；手工方向和媒体来源在个人菜单「雷达设置」中修改；公众号与全网检索由运营侧配置。</div>
                  <div className={a.actions}>
                    <Button variant="tertiary" onPress={() => setConfigOpen(false)}>
                      关闭
                    </Button>
                    <Button
                      variant="primary"
                      onPress={() => {
                        setConfigOpen(false);
                        setSettingsOpen(true);
                      }}
                    >
                      在雷达设置里修改
                    </Button>
                  </div>
                </footer>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      ) : null}
      {settingsOpen ? (
        <MenuDialog title="雷达设置" wide onClose={() => setSettingsOpen(false)}>
          <RadarSettingsEditor mode="company" />
        </MenuDialog>
      ) : null}
    </>
  );
}
