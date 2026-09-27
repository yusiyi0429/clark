"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { RADAR_SETTINGS_CHANGED, goToAccess } from "./personalRadar";
import {
  MAX_DIRECTIONS,
  MAX_DIRECTION_CHARS,
  RadarSettingsForm,
  chars,
  commitPending,
  draftFrom,
  saveBlockedReason,
  type RadarActionsTarget,
  type RadarDraft,
  type RadarSettingsView,
  type ScanNote,
} from "./RadarSettingsForm";

type MyRadar = components["schemas"]["MyRadar"];
type CompanyRadarSettings = components["schemas"]["CompanyRadarSettings"];
type ApiError = components["schemas"]["ApiError"];

export type RadarSavedSummary = { enabled: boolean; directions: number; sources: number };

const EMPTY_DRAFT: RadarDraft = { enabled: false, directions: [], sources: [], directionText: "", sourceText: "", editing: null };
const SCAN_FAILED = "扫描没能开始，稍后可以在「我的雷达」里刷新";

const fromPerson = (data: MyRadar): RadarSettingsView => ({
  enabled: data.enabled,
  directions: data.directions.map((direction) => direction.text),
  sources: data.sources,
  saved: data.updatedAt !== null,
  webSearch: data.webSearch,
  suggestions: data.suggestions,
  automatic: [],
});

const fromCompany = (data: CompanyRadarSettings): RadarSettingsView => ({
  enabled: true,
  directions: data.directions.map((direction) => direction.text),
  sources: data.sources,
  saved: true,
  webSearch: data.webSearch,
  suggestions: { directions: [], sources: data.suggestions.sources },
  automatic: data.automatic,
});

const sameList = (left: string[], right: string[]) => left.length === right.length && left.every((item, index) => item === right[index]);
const summaryOf = (view: RadarSettingsView): RadarSavedSummary => ({ enabled: view.enabled, directions: view.directions.length, sources: view.sources.length });
const messageOf = (error: unknown, fallback: string) => (error as ApiError | undefined)?.message || fallback;

/** 服务端 fieldErrors 的键是提交时的下标（directions/<i>、sources/<i>），按下标对回胶囊原文。 */
function fieldErrorsOf(fieldErrors: Record<string, string> | undefined, draft: RadarDraft): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const [key, message] of Object.entries(fieldErrors ?? {})) {
    const [list, index] = key.split("/");
    if (list !== "directions" && list !== "sources") continue;
    const text = draft[list][Number(index)];
    if (text !== undefined) mapped[`${list}:${text}`] = message;
  }
  return mapped;
}

/**
 * 雷达设置编辑器：引导第 3 步、个人菜单、「我的雷达」页头、CEO 雷达页「监测范围」四处是同一个。
 * 成员（person）改本人雷达：保存成功且开着时，在后台扫一次（不等结果）；CEO（company）改的是公司雷达的手工方向与媒体来源，
 * 保存后不扫描、只刷新页面数据。自己取数，写法同 VoiceprintCard；读法、规范化都由服务端算，这里只显示。
 */
export function RadarSettingsEditor({
  mode,
  submitLabel = "保存",
  onSaved,
  onLater,
  enable = false,
  actionsTarget,
}: {
  mode: "person" | "company";
  submitLabel?: string;
  onSaved?: (summary: RadarSavedSummary) => void;
  /** 只有引导传：显示「稍后」。 */
  onLater?: () => void;
  /** 打开编辑器时先把开关拨到开（「我的雷达」页的「打开」）。 */
  enable?: boolean;
  /** 引导把主按钮和「稍后」放进自己的底栏，与其他步骤同一个位置。 */
  actionsTarget?: RadarActionsTarget;
}) {
  const router = useRouter();
  const idPrefix = `radar${useId()}`;
  const [view, setView] = useState<RadarSettingsView | null>(null);
  const [draft, setDraft] = useState<RadarDraft>(EMPTY_DRAFT);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [scan, setScan] = useState<ScanNote | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const directionInput = useRef<HTMLTextAreaElement>(null);
  const wasEnabled = useRef<boolean | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const result = mode === "person" ? await browserApi.GET("/api/me/radar") : await browserApi.GET("/api/config/radar");
      if (!mounted.current) return;
      if (result.response.status === 401) return goToAccess();
      if (!result.response.ok || !result.data) {
        setLoadError(messageOf(result.error, "雷达设置没能读到，请重试。"));
        return;
      }
      const next = mode === "person" ? fromPerson(result.data as MyRadar) : fromCompany(result.data as CompanyRadarSettings);
      setView(next);
      setDraft(draftFrom(next, enable));
    } catch {
      if (mounted.current) setLoadError("雷达设置没能读到，请检查网络后重试。");
    }
  }, [mode, enable]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // 拨开开关（或从「打开」进来）时，光标直接落到方向输入框：写一句就能保存。
  useEffect(() => {
    if (!view) return;
    const previous = wasEnabled.current;
    wasEnabled.current = draft.enabled;
    if (draft.enabled && (previous === false || (previous === null && enable && !view.enabled))) directionInput.current?.focus();
  }, [draft.enabled, view, enable]);

  const update = useCallback((change: (current: RadarDraft) => RadarDraft) => {
    setDraft(change);
    setSaved(null);
    setSaveError(null);
  }, []);

  async function startScan() {
    let note: ScanNote;
    try {
      const { error, response } = await browserApi.POST("/api/me/radar/scan");
      if (response.status === 401) return goToAccess();
      // 409／429（正在扫、今天收满、10 分钟冷却）是正常情况：原样写服务端的话，不当成错误。
      note = response.status === 202 ? { tone: "info", text: "已在后台扫描" } : response.status === 409 || response.status === 429 ? { tone: "info", text: messageOf(error, "现在不能扫描") } : { tone: "error", text: SCAN_FAILED };
    } catch {
      note = { tone: "error", text: SCAN_FAILED };
    }
    if (mounted.current) setScan(note);
  }

  async function save() {
    if (!view || inFlight.current) return;
    const next = commitPending(draft);
    if (next !== draft) setDraft(next);
    if (saveBlockedReason(mode, next)) return;
    const pending = next.directionText.trim();
    if (pending) {
      // 输入框里还有一句没能变成胶囊：说清为什么，不悄悄丢掉。
      setSaveError(chars(pending) > MAX_DIRECTION_CHARS ? `输入框里那条方向超过 ${MAX_DIRECTION_CHARS} 个字，改短一点再保存` : `方向已经写满 ${MAX_DIRECTIONS} 条；删掉一条，或清空输入框再保存`);
      return;
    }
    const changed = !view.saved || next.enabled !== view.enabled || !sameList(next.directions, view.directions) || !sameList(next.sources, view.sources.map((source) => source.value));
    if (!changed) {
      // 没有改动：不重复保存、不重复扫描，引导里直接往下走。
      setSaved(mode === "person" ? "设置已保存" : "设置已保存 · 下次扫描时生效");
      onSaved?.(summaryOf(view));
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setSaveError(null);
    setErrors({});
    setScan(null);
    let savedView: RadarSettingsView | null = null;
    try {
      const body = { directions: next.directions, sources: next.sources };
      const result = mode === "person" ? await browserApi.PUT("/api/me/radar", { body: { enabled: next.enabled, ...body } }) : await browserApi.PUT("/api/config/radar", { body });
      if (result.response.status === 401) return goToAccess();
      if (!result.response.ok || !result.data) {
        if (!mounted.current) return;
        const failure = result.error as ApiError | undefined;
        setErrors(fieldErrorsOf(failure?.fieldErrors, next));
        setSaveError(messageOf(failure, "没保存成功，请重试。"));
        return;
      }
      savedView = mode === "person" ? fromPerson(result.data as MyRadar) : fromCompany(result.data as CompanyRadarSettings);
    } catch {
      if (mounted.current) setSaveError("网络连接失败，请再试一次。");
      return;
    } finally {
      inFlight.current = false;
      if (mounted.current) setSaving(false);
    }
    // 胶囊换成服务端返回的规范值；「设置已保存」与扫描状态分两行写。保存途中离开了（引导里点了上一步）就不再回调。
    const stillHere = mounted.current;
    if (stillHere) {
      setView(savedView);
      setDraft(draftFrom(savedView));
      setSaved(mode === "person" ? "设置已保存" : "设置已保存 · 下次扫描时生效");
    }
    if (mode === "company") router.refresh();
    if (stillHere) onSaved?.(summaryOf(savedView));
    // 引导不等扫描结果：onSaved 已经往下走，扫描在后台继续。
    if (mode === "person" && savedView.enabled) await startScan();
    window.dispatchEvent(new Event(RADAR_SETTINGS_CHANGED));
  }

  return (
    <RadarSettingsForm
      mode={mode}
      idPrefix={idPrefix}
      view={view}
      draft={draft}
      onDraft={update}
      errors={errors}
      status={{ loading: !view && !loadError, loadError, saving, saveError, saved, scan }}
      submitLabel={submitLabel}
      onSubmit={() => void save()}
      onLater={onLater}
      onReload={() => void load()}
      actionsTarget={actionsTarget}
      directionInput={directionInput}
    />
  );
}
