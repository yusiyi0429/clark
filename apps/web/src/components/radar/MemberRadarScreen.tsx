"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import { RefreshCw, SlidersHorizontal } from "lucide-react";
import { browserApi, type Card } from "@/lib/api/client";
import { MenuDialog } from "@/components/AccountMenu";
import { DetailHeader } from "@/components/shell/DetailHeader";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { SignalStoryView } from "@/cards/SignalStory";
import { RadarSettingsEditor } from "./RadarSettingsEditor";
import {
  RADAR_COPY,
  RADAR_SETTINGS_CHANGED,
  failureReason,
  goToAccess,
  personalSignalTime,
  personalStory,
  personalStatusLine,
  scanActive,
  type MyRadar,
  type PersonalRadarRun,
  type PersonalSignalBrief,
} from "./personalRadar";
import w from "@/styles/app-shell.module.css";
import f from "@/styles/radar-feed.module.css";

type Filter = "全部" | "未读" | "收藏";
type Note = { tone: "info" | "error"; text: string };

const EMPTY_CARDS: Card[] = [];
const POLL_MS = 5_000;
const POLL_LIMIT_MS = 180_000;
const runKey = (run: PersonalRadarRun | null | undefined) => (run ? `${run.status}:${run.queuedAt ?? run.startedAt ?? ""}` : "");

/** 空态：关着、失败、第一次还没扫完、扫完没有结果、筛选下没有，各说各的。 */
function emptyState(radar: MyRadar, hasSignals: boolean, filter: Filter, scanning: boolean) {
  const run = radar.lastRun;
  if (hasSignals && filter !== "全部") return { kind: "filter" as const, title: "这里暂时没有信号", text: "换一个筛选看看。" };
  if (!radar.enabled) return { kind: "off" as const, title: RADAR_COPY.off, text: "关着时不再扫描；已经收到的信号仍留在这里。" };
  if (run?.status === "failed" && !scanning) return { kind: "failed" as const, title: "扫描失败", text: failureReason(run) };
  if (scanning || !run || scanActive(run)) return { kind: "first" as const, title: RADAR_COPY.firstScan, text: "扫完后会自动出现在这里。" };
  return { kind: "empty" as const, title: RADAR_COPY.empty, text: "雷达每天按你的方向看一遍；也可以在「设置」里改改方向和来源。" };
}

/**
 * 我的雷达（成员）：沿用公司雷达页的一竖列信息流，只有「全部／未读／收藏」，按时间排。
 * 页头「设置」打开同一个编辑器；「刷新」排队扫描一次，收到 202 后每 5 秒看一次进度，最多 3 分钟，完成后刷新页面。
 */
export function MemberRadarScreen({ radar, signals }: { radar: MyRadar; signals: PersonalSignalBrief[] }) {
  const { navigate, close } = useWorkspace();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("全部");
  const [requesting, setRequesting] = useState(false);
  const [watching, setWatching] = useState(() => scanActive(radar.lastRun));
  const [note, setNote] = useState<Note | null>(null);
  const [settings, setSettings] = useState<{ enable: boolean } | null>(null);
  /** 等满 3 分钟仍在扫的那一次：不再自动接着等，免得一直轮询；再按「刷新」会重新开始。 */
  const stalled = useRef<string | null>(null);
  useRegisterDetail({ scope: "global", label: "我的雷达", mark: null, cards: EMPTY_CARDS });

  // 服务端说在排队或扫描（包括第一次扫描），就接着看，直到完成再刷新页面。
  useEffect(() => {
    if (scanActive(radar.lastRun) && runKey(radar.lastRun) !== stalled.current) setWatching(true);
  }, [radar.lastRun]);

  useEffect(() => {
    if (!watching) return;
    let stopped = false;
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (stopped) return;
      void (async () => {
        try {
          const { data, response } = await browserApi.GET("/api/me/radar");
          if (stopped) return;
          if (response.status === 401) return goToAccess();
          const done = data && !scanActive(data.lastRun);
          if (!done && Date.now() - started < POLL_LIMIT_MS) return;
          if (!done) stalled.current = runKey(data?.lastRun);
          stopped = true;
          window.clearInterval(timer);
          setWatching(false);
          router.refresh();
        } catch {
          // 断网时下一轮再看。
        }
      })();
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [watching, router]);

  // 在弹窗或个人菜单里改了设置：重读这一页。
  useEffect(() => {
    const changed = () => router.refresh();
    window.addEventListener(RADAR_SETTINGS_CHANGED, changed);
    return () => window.removeEventListener(RADAR_SETTINGS_CHANGED, changed);
  }, [router]);

  async function scan() {
    if (requesting) return;
    setRequesting(true);
    setNote(null);
    try {
      const { error, response } = await browserApi.POST("/api/me/radar/scan");
      if (response.status === 401) return goToAccess();
      const failure = error as { code?: string; message?: string } | undefined;
      // 已经在扫（定时扫描或刚保存设置时排的那一次）：接着看进度，不另起一次。
      if (response.status === 202 || failure?.code === "RADAR_SCAN_IN_PROGRESS") {
        stalled.current = null;
        setWatching(true);
        return;
      }
      // 409／429（没开、今天收满、10 分钟冷却）原样写服务端的话，不当成错误。
      const message = failure?.message;
      setNote(response.status === 409 || response.status === 429 ? { tone: "info", text: message ?? "现在不能扫描" } : { tone: "error", text: message ?? "没能开始扫描，请稍后再试。" });
    } catch {
      setNote({ tone: "error", text: "网络连接失败，请再试一次。" });
    } finally {
      setRequesting(false);
    }
  }

  const scanning = requesting || watching;
  const listed = useMemo(() => signals.filter((signal) => !signal.state.dismissed), [signals]);
  const visible = useMemo(
    () =>
      listed
        .filter((signal) => filter === "全部" || (filter === "未读" && !signal.state.read) || (filter === "收藏" && signal.state.saved))
        .sort((left, right) => personalSignalTime(right) - personalSignalTime(left)),
    [listed, filter],
  );
  const run = radar.lastRun;
  const failed = run?.status === "failed" && !scanning;
  const empty = visible.length ? null : emptyState(radar, listed.length > 0, filter, scanning);

  return (
    <>
      <DetailHeader
        mark="signal"
        eyebrow="外部信息 · 只给你看"
        title="我的雷达"
        closeLabel="关闭我的雷达"
        onClose={close}
        actions={
          <div className={f.headerActions}>
            <Button size="sm" variant="tertiary" aria-label="雷达设置" aria-haspopup="dialog" onPress={() => setSettings({ enable: false })}>
              <SlidersHorizontal size={16} aria-hidden="true" />
              <span>设置</span>
            </Button>
            {radar.enabled ? (
              <Button size="sm" variant="tertiary" aria-label={scanning ? "正在扫描" : "刷新我的雷达"} isDisabled={scanning} onPress={() => void scan()}>
                <RefreshCw size={16} className={scanning ? f.spinning : ""} aria-hidden="true" />
                <span>{scanning ? "正在扫描" : "刷新"}</span>
              </Button>
            ) : null}
          </div>
        }
      />
      <div className={w.expandedScroll}>
        <div className={f.feed} data-testid="member-radar">
          {!radar.enabled && listed.length ? (
            <div className={f.personalNotice}>
              <p>{RADAR_COPY.off}</p>
              <Button size="sm" variant="tertiary" onPress={() => setSettings({ enable: true })}>
                打开
              </Button>
            </div>
          ) : null}
          {listed.length ? (
            <div className={f.toolbar}>
              <ToggleButtonGroup
                className={f.filters}
                aria-label="我的雷达筛选"
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
            </div>
          ) : null}
          <div className={f.status} role="status">
            {personalStatusLine(radar, scanning)}
          </div>
          {note ? (
            <p className={note.tone === "error" ? f.error : f.notice} role={note.tone === "error" ? "alert" : undefined}>
              {note.text}
            </p>
          ) : null}
          {failed && run && listed.length ? (
            <p className={f.error} role="alert">
              扫描失败：{failureReason(run)}
              <Button size="sm" variant="tertiary" isDisabled={requesting} onPress={() => void scan()}>
                重试
              </Button>
            </p>
          ) : null}
          {run?.status === "completed" && run.warnings.length && !scanning ? <p className={f.notice}>{[...new Set(run.warnings)].join(" ")}</p> : null}

          {visible.length ? (
            <div className={f.stories}>
              {visible.map((signal) => (
                <SignalStoryView key={signal.id} {...personalStory(signal)} onOpen={navigate} />
              ))}
            </div>
          ) : empty ? (
            <div className={f.empty} data-empty={empty.kind}>
              <div className={`${f.orbit} ${empty.kind === "first" && scanning ? f.spinning : ""}`} aria-hidden="true" />
              <h2>{empty.title}</h2>
              <p>{empty.text}</p>
              {empty.kind === "off" ? (
                <Button className={f.emptyAction} variant="primary" onPress={() => setSettings({ enable: true })}>
                  打开
                </Button>
              ) : empty.kind === "failed" ? (
                <Button className={f.emptyAction} variant="tertiary" isDisabled={requesting} onPress={() => void scan()}>
                  重试
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {settings ? (
        <MenuDialog title="我的雷达" wide onClose={() => setSettings(null)}>
          <RadarSettingsEditor mode="person" enable={settings.enable} />
        </MenuDialog>
      ) : null}
    </>
  );
}
