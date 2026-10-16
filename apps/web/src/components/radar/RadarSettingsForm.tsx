"use client";

import { createPortal } from "react-dom";
import type { ClipboardEvent, KeyboardEvent, ReactNode, Ref } from "react";
import { ArrowRight, Building2, Check, Plus, X } from "lucide-react";
import type { components } from "@/lib/api/schema";
import f from "@/components/onboarding/foundation.module.css";
import s from "@/styles/radar-settings.module.css";

export type RadarSource = components["schemas"]["RadarSourceSetting"];
export type DirectionSuggestion = components["schemas"]["MyRadar"]["suggestions"]["directions"][number];
type List = "directions" | "sources";

/** 与契约 RADAR_* 同值，只用于输入时的提示；是否合规、规范成什么，以服务端为准。 */
export const MAX_DIRECTION_CHARS = 40;
export const MAX_DIRECTIONS = 5;
const MAX_SOURCES = 10;
export const DIRECTION_PLACEHOLDER = "用一句话写你想看的，比如「1 号位产品的设计」";
export const SOURCE_PLACEHOLDER = "粘贴网址，或选常用来源";

/** 服务端给回的设置：成员的本人雷达与 CEO 的公司雷达统一成这一份再交给表单。 */
export type RadarSettingsView = {
  enabled: boolean;
  directions: string[];
  sources: RadarSource[];
  /** 成员是否保存过（updatedAt 不为空）；公司雷达一直算保存过。 */
  saved: boolean;
  webSearch: boolean;
  suggestions: { directions: DirectionSuggestion[]; sources: RadarSource[] };
  /** 公司雷达的自动方向（本月目标、会议复议条件），只读。 */
  automatic: string[];
};

/** 正在编辑的草稿：胶囊就是字符串；输入框里还没变成胶囊的字也在这里。 */
export type RadarDraft = {
  enabled: boolean;
  directions: string[];
  sources: string[];
  directionText: string;
  sourceText: string;
  editing: { list: List; index: number; text: string } | null;
};

export type ScanNote = { tone: "info" | "error"; text: string };
export type RadarActionsTarget = { primary: HTMLElement | null; secondary: HTMLElement | null };
type Update = (update: (draft: RadarDraft) => RadarDraft) => void;

/** 按字符计（与服务端 Array.from 同口径），emoji 和生僻字都算一个。 */
export const chars = (text: string) => Array.from(text).length;

/** 看起来是网址或域名时才变成胶囊；能不能读、规范成什么，都由服务端判定。 */
const looksLikeSource = (text: string) => /^(https?:\/\/)?[^\s/?#]+\.[^\s/?#.]{2,}([/?#]\S*)?$/i.test(text.trim());

const splitSources = (text: string) => text.split(/[\s,，、]+/).filter(Boolean);
const sameText = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();

export function draftFrom(view: RadarSettingsView, enable = false): RadarDraft {
  return { enabled: view.enabled || enable, directions: [...view.directions], sources: view.sources.map((source) => source.value), directionText: "", sourceText: "", editing: null };
}

function addDirection(draft: RadarDraft): RadarDraft {
  const text = draft.directionText.trim();
  if (!text || chars(text) > MAX_DIRECTION_CHARS || draft.directions.length >= MAX_DIRECTIONS) return draft;
  if (draft.directions.includes(text)) return { ...draft, directionText: "" };
  return { ...draft, directions: [...draft.directions, text], directionText: "" };
}

function addSources(draft: RadarDraft, items: string[]): RadarDraft {
  const sources = [...draft.sources];
  for (const item of items.map((value) => value.trim()).filter(Boolean)) {
    if (sources.length >= MAX_SOURCES) break;
    if (!sources.includes(item)) sources.push(item);
  }
  return { ...draft, sources, sourceText: "" };
}

/** 保存前把输入框里写了但没回车的字也变成胶囊：写一句方向就能直接保存。 */
export function commitPending(draft: RadarDraft): RadarDraft {
  const withDirection = draft.directionText.trim() ? addDirection(draft) : draft;
  const pendingSources = splitSources(withDirection.sourceText);
  return pendingSources.length ? addSources(withDirection, pendingSources) : withDirection;
}

function removeAt(list: List, index: number) {
  return (draft: RadarDraft): RadarDraft => ({ ...draft, [list]: draft[list].filter((_, at) => at !== index), editing: null });
}

function commitEdit(draft: RadarDraft): RadarDraft {
  const editing = draft.editing;
  if (!editing) return draft;
  const text = editing.text.trim();
  const items = [...draft[editing.list]];
  if (editing.list === "directions" && chars(text) > MAX_DIRECTION_CHARS) return { ...draft, editing: null };
  if (!text || items.some((item, at) => at !== editing.index && item === text)) items.splice(editing.index, 1);
  else items[editing.index] = text;
  return { ...draft, [editing.list]: items, editing: null };
}

/** 保存键为什么按不下去；null 表示可以保存。 */
export function saveBlockedReason(mode: "person" | "company", draft: RadarDraft): string | null {
  if (mode !== "person" || !draft.enabled || draft.directions.length) return null;
  const pending = draft.directionText.trim();
  return pending && chars(pending) <= MAX_DIRECTION_CHARS ? null : "开启雷达至少要写一条方向";
}

/** 回车只加胶囊、不提交；中文输入法组词时的回车（isComposing／keyCode 229）不算。 */
function enterOnly(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, action: () => void) {
  if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (!event.repeat) action();
}

export function RadarSettingsForm({
  mode,
  idPrefix,
  view,
  draft,
  onDraft,
  errors,
  status,
  submitLabel,
  onSubmit,
  onLater,
  onReload,
  actionsTarget,
  directionInput,
}: {
  mode: "person" | "company";
  idPrefix: string;
  view: RadarSettingsView | null;
  draft: RadarDraft;
  onDraft: Update;
  /** 服务端 fieldErrors，按「列表:胶囊原文」对到胶囊上。 */
  errors: Record<string, string>;
  status: { loading: boolean; loadError: string | null; saving: boolean; saveError: string | null; saved: string | null; scan: ScanNote | null };
  submitLabel: string;
  onSubmit: () => void;
  onLater?: () => void;
  onReload: () => void;
  /** 引导把主按钮与「稍后」放进自己的底栏；不传就放在卡片底部。 */
  actionsTarget?: RadarActionsTarget;
  directionInput?: Ref<HTMLTextAreaElement>;
}) {
  const person = mode === "person";
  const open = !person || draft.enabled;
  const blocked = view ? saveBlockedReason(mode, draft) : null;
  const hintId = `${idPrefix}-action-hint`;

  const body = !view ? (
    status.loadError ? (
      <div className={s.state} role="alert">
        <p>{status.loadError}</p>
        <button type="button" className={f.textButton} onClick={onReload}>
          重试
        </button>
      </div>
    ) : (
      <p className={s.state} role="status">
        正在读取雷达设置…
      </p>
    )
  ) : (
    <>
      {person ? (
        <button
          type="button"
          role="switch"
          aria-checked={draft.enabled}
          aria-labelledby={`${idPrefix}-switch`}
          aria-describedby={`${idPrefix}-switch-note`}
          className={s.switchRow}
          onClick={() => onDraft((current) => ({ ...current, enabled: !current.enabled }))}
        >
          <span className={s.switchText}>
            <span id={`${idPrefix}-switch`} className={s.switchLabel}>
              开启雷达
            </span>
            <span id={`${idPrefix}-switch-note`} className={s.switchNote}>
              {draft.enabled ? "我每天按你的方向替你看一遍，结果只给你自己看。运营者在后台能看到运行记录。" : "打开后，我每天按你的方向替你看一遍，结果只给你自己看。运营者在后台能看到运行记录。"}
            </span>
          </span>
          <span className={f.switch} data-on={draft.enabled} aria-hidden="true">
            <span />
          </span>
        </button>
      ) : null}
      <div className={s.body} data-open={open} inert={!open}>
        <div className={s.bodyInner}>
          {directionsSection({ mode, idPrefix, view, draft, onDraft, errors, directionInput })}
          {sourcesSection({ mode, idPrefix, view, draft, onDraft, errors })}
        </div>
      </div>
    </>
  );

  const hint = blocked ?? status.saveError;
  const primary = (
    <>
      {actionsTarget && hint ? (
        <p id={hintId} className={s.footerHint} data-tone={status.saveError && !blocked ? "error" : undefined} role={status.saveError && !blocked ? "alert" : undefined}>
          {hint}
        </p>
      ) : null}
      <button
        type="button"
        className={`${f.primary} ${s.submit}`}
        data-radar-submit
        disabled={!view || status.saving || Boolean(blocked)}
        aria-describedby={hint ? hintId : undefined}
        onClick={onSubmit}
      >
        {status.saving ? "正在保存…" : submitLabel}
        {actionsTarget && !status.saving ? <ArrowRight size={18} aria-hidden="true" /> : null}
      </button>
    </>
  );
  const later = onLater ? (
    <button type="button" className={f.textButton} onClick={onLater} disabled={status.saving}>
      稍后
    </button>
  ) : null;

  return (
    <section className={`${f.glass} ${s.editor}`} data-mode={mode} data-onboarding={actionsTarget ? true : undefined} aria-label={person ? "我的雷达设置" : "公司雷达设置"}>
      {!person ? (
        <p className={s.company}>
          <Building2 size={17} aria-hidden="true" />
          这里改的是公司雷达
        </p>
      ) : null}
      {body}
      {actionsTarget ? (
        <>
          {actionsTarget.primary ? createPortal(primary, actionsTarget.primary) : null}
          {actionsTarget.secondary && later ? createPortal(later, actionsTarget.secondary) : null}
        </>
      ) : (
        <div className={s.actions}>
          <div className={s.statusStack} aria-live="polite">
            {blocked ? (
              <p id={hintId} className={s.hint}>
                {blocked}
              </p>
            ) : null}
            {status.saveError && !blocked ? (
              <p id={hintId} className={s.hint} data-tone="error" role="alert">
                {status.saveError}
              </p>
            ) : null}
            {status.saved ? (
              <p className={s.saved}>
                <Check size={16} aria-hidden="true" />
                {status.saved}
              </p>
            ) : null}
            {status.scan ? (
              <p className={s.scanNote} data-tone={status.scan.tone}>
                {status.scan.text}
              </p>
            ) : null}
          </div>
          <div className={s.buttons}>
            {later}
            {primary}
          </div>
        </div>
      )}
    </section>
  );
}

type SectionProps = {
  mode: "person" | "company";
  idPrefix: string;
  view: RadarSettingsView;
  draft: RadarDraft;
  onDraft: Update;
  errors: Record<string, string>;
};

function directionsSection({ mode, idPrefix, view, draft, onDraft, errors, directionInput }: SectionProps & { directionInput?: Ref<HTMLTextAreaElement> }) {
  const count = chars(draft.directionText.trim());
  const over = count > MAX_DIRECTION_CHARS;
  const full = draft.directions.length >= MAX_DIRECTIONS;
  const suggestions = full ? [] : view.suggestions.directions.filter((item) => !draft.directions.some((direction) => sameText(direction, item.text)));
  const automatic = view.automatic;
  return (
    <section className={s.section} aria-labelledby={`${idPrefix}-directions`}>
      <div className={s.sectionHead}>
        <h3 id={`${idPrefix}-directions`} className={s.sectionTitle}>
          方向
        </h3>
        <span className={s.sectionHint}>一句话一条，最多 {MAX_DIRECTIONS} 条</span>
      </div>
      {mode === "company" && automatic.length ? (
        <div className={s.automatic}>
          <p className={s.automaticLabel}>按签发的本月目标与会议复议条件自动关注 · 只读</p>
          <ul>
            {automatic.slice(0, 3).map((text, index) => (
              <li key={`${index}:${text}`}>{text}</li>
            ))}
          </ul>
          {automatic.length > 3 ? (
            <details>
              <summary>另 {automatic.length - 3} 条</summary>
              <ul>
                {automatic.slice(3).map((text, index) => (
                  <li key={`${index}:${text}`}>{text}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
      {chipList({ list: "directions", label: "方向", draft, onDraft, errors, baseline: view.directions })}
      <div className={s.field} data-invalid={over || undefined} data-disabled={full || undefined}>
        {/* 多行框：手机上占位文字和长方向都能折行看全；回车仍是「加入」，不换行 */}
        <textarea
          ref={directionInput}
          rows={1}
          enterKeyHint="done"
          aria-label="写一条方向"
          aria-describedby={`${idPrefix}-direction-note`}
          placeholder={DIRECTION_PLACEHOLDER}
          value={draft.directionText}
          disabled={full}
          onChange={(event) => {
            const value = event.target.value.replace(/\s*\n\s*/g, " ");
            onDraft((current) => ({ ...current, directionText: value }));
          }}
          onKeyDown={(event) => enterOnly(event, () => onDraft(addDirection))}
          onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
            if (event.currentTarget.value.trim()) return; // 已经写了一半：照常粘贴，回车再加
            const lines = event.clipboardData.getData("text").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
            if (!lines.length || lines.some((line) => chars(line) > MAX_DIRECTION_CHARS)) return;
            event.preventDefault();
            onDraft((current) => lines.reduce((next, line) => addDirection({ ...next, directionText: line }), current));
          }}
        />
        <span className={s.counter} data-over={over || undefined} aria-hidden="true">
          {count}/{MAX_DIRECTION_CHARS}
        </span>
      </div>
      <p id={`${idPrefix}-direction-note`} className={s.fieldNote} data-tone={over ? "error" : undefined}>
        {full ? `最多 ${MAX_DIRECTIONS} 条方向；删掉一条才能再加` : over ? `每条最多 ${MAX_DIRECTION_CHARS} 个字，现在 ${count} 个` : draft.directionText.trim() ? "回车加入" : ""}
      </p>
      {suggestions.length ? (
        <div className={s.suggestions} role="group" aria-label="可能相关的方向">
          <span className={s.suggestionsLabel}>可能相关</span>
          {suggestions.map((item) => (
            <button
              key={item.text}
              type="button"
              className={s.suggestion}
              aria-label={`加上方向：${item.text}（来自${item.from}）`}
              // 点建议不动输入框里正在写的那句。
              onClick={() => onDraft((current) => ({ ...current, directions: addDirection({ ...current, directionText: item.text }).directions }))}
            >
              <Plus size={14} aria-hidden="true" />
              {item.text}
              <small>· {item.from}</small>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function sourcesSection({ mode, idPrefix, view, draft, onDraft, errors }: SectionProps) {
  const known = Object.fromEntries([...view.suggestions.sources, ...view.sources].map((source) => [source.value, source]));
  const full = draft.sources.length >= MAX_SOURCES;
  const typed = draft.sourceText.trim();
  const readable = typed ? splitSources(typed).every(looksLikeSource) : false;
  const visible = full ? [] : view.suggestions.sources.filter((item) => !draft.sources.includes(item.value));
  const groups = visible.reduce<{ note: string; items: RadarSource[] }[]>((all, item) => {
    const group = all.find((entry) => entry.note === item.note);
    if (group) group.items.push(item);
    else all.push({ note: item.note, items: [item] });
    return all;
  }, []);
  const unreadable = draft.sources.length > 0 && draft.sources.every((value) => known[value]?.kind === "unsupported");
  const note = !view.webSearch
    ? mode === "person"
      ? "全网检索暂未开通：现在只能读订阅源；只写方向、不填来源，不会有结果。"
      : "全网检索暂未开通：现在只读订阅源和公众号，方向用来从中筛选。"
    : mode === "person"
      ? "不填时，按你的方向在全网检索。"
      : "这里只收有订阅源的媒体；全网检索和公众号另行配置。";
  return (
    <section className={s.section} aria-labelledby={`${idPrefix}-sources`}>
      <div className={s.sectionHead}>
        <h3 id={`${idPrefix}-sources`} className={s.sectionTitle}>
          来源<span className={s.optional}>可不填</span>
        </h3>
        <span className={s.sectionHint}>最多 {MAX_SOURCES} 个</span>
      </div>
      <p className={s.sectionNote} data-tone={view.webSearch ? undefined : "warn"}>
        {note}
      </p>
      {chipList({ list: "sources", label: "来源", draft, onDraft, errors, baseline: view.sources.map((source) => source.value), known })}
      {unreadable ? (
        <p className={s.warning} role="status">
          这些来源暂时都读不了，雷达不会有结果
        </p>
      ) : null}
      <div className={s.field} data-disabled={full || undefined}>
        <input
          type="text"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="done"
          aria-label="加一个来源网址"
          aria-describedby={`${idPrefix}-source-note`}
          placeholder={SOURCE_PLACEHOLDER}
          value={draft.sourceText}
          disabled={full}
          onChange={(event) => {
            const value = event.target.value;
            onDraft((current) => ({ ...current, sourceText: value }));
          }}
          onKeyDown={(event) =>
            enterOnly(event, () => {
              const items = splitSources(draft.sourceText);
              if (items.length && items.every(looksLikeSource)) onDraft((current) => addSources(current, items));
            })
          }
          onPaste={(event: ClipboardEvent<HTMLInputElement>) => {
            if (event.currentTarget.value.trim()) return;
            const items = splitSources(event.clipboardData.getData("text"));
            if (!items.length || !items.every(looksLikeSource)) return; // 混着别的字：照常粘贴，看一眼再回车
            event.preventDefault();
            onDraft((current) => addSources(current, items));
          }}
        />
      </div>
      <p id={`${idPrefix}-source-note`} className={s.fieldNote}>
        {full ? `最多 ${MAX_SOURCES} 个来源；删掉一个才能再加` : typed ? (readable ? "回车加入" : "写成网址或域名，比如 ft.com") : ""}
      </p>
      {groups.length ? (
        <div className={s.suggestionGroups} role="group" aria-label="常用来源">
          <span className={s.suggestionsLabel}>常用来源</span>
          {groups.map((group) => (
            <div key={group.note} className={s.suggestionGroup}>
              <span className={s.groupNote}>{group.note}</span>
              <div className={s.suggestions}>
                {group.items.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    className={s.suggestion}
                    aria-label={`加上来源：${item.name ?? item.value}（${item.note}）`}
                    onClick={() => onDraft((current) => ({ ...current, sources: addSources(current, [item.value]).sources }))}
                  >
                    <Plus size={14} aria-hidden="true" />
                    {item.name ?? item.value}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** 已选的胶囊：实心天枢蓝、白字；点字可以改，× 删掉；服务端的问题和读法写在胶囊下一行。 */
function chipList({
  list,
  label,
  draft,
  onDraft,
  errors,
  baseline,
  known,
}: {
  list: List;
  label: string;
  draft: RadarDraft;
  onDraft: Update;
  errors: Record<string, string>;
  baseline: string[];
  known?: Record<string, RadarSource>;
}) {
  const items = draft[list];
  if (!items.length) return null;
  return (
    <ul className={s.chips} aria-label={`已加的${label}`}>
      {items.map((text, index) => {
        const error = errors[`${list}:${text}`];
        const setting = known?.[text];
        const note: ReactNode = error ?? (setting ? `${setting.name ? `${setting.name} · ` : ""}${setting.note}` : null);
        const editing = draft.editing?.list === list && draft.editing.index === index ? draft.editing : null;
        return (
          <li key={`${index}:${text}`} data-fresh={!baseline.includes(text) || undefined}>
            {editing ? (
              <div className={`${s.field} ${s.editField}`} data-invalid={(list === "directions" && chars(editing.text.trim()) > MAX_DIRECTION_CHARS) || undefined}>
                <input
                  type="text"
                  autoFocus
                  enterKeyHint="done"
                  aria-label={`修改${label}`}
                  value={editing.text}
                  onChange={(event) => {
                    const value = event.target.value;
                    onDraft((current) => (current.editing ? { ...current, editing: { ...current.editing, text: value } } : current));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      // 只取消这一次修改，不关掉外面的弹窗或工作区
                      event.preventDefault();
                      event.stopPropagation();
                      onDraft((current) => ({ ...current, editing: null }));
                      return;
                    }
                    enterOnly(event, () => onDraft(commitEdit));
                  }}
                  onBlur={() => onDraft(commitEdit)}
                />
                {list === "directions" ? (
                  <span className={s.counter} data-over={chars(editing.text.trim()) > MAX_DIRECTION_CHARS || undefined} aria-hidden="true">
                    {chars(editing.text.trim())}/{MAX_DIRECTION_CHARS}
                  </span>
                ) : null}
              </div>
            ) : (
              <span className={s.chip} data-invalid={error ? true : undefined}>
                <button
                  type="button"
                  className={s.chipText}
                  aria-label={`修改${label}：${text}`}
                  title="点一下修改"
                  onClick={() =>
                    onDraft((current) => {
                      // 先收起正在改的另一枚（它可能被删掉，下标会变），再按原文找到这一枚。
                      const committed = commitEdit(current);
                      const at = committed[list].indexOf(text);
                      return at < 0 ? committed : { ...committed, editing: { list, index: at, text } };
                    })
                  }
                >
                  {text}
                </button>
                <button type="button" className={s.chipRemove} aria-label={`删除${label}：${text}`} onClick={() => onDraft(removeAt(list, index))}>
                  <X size={15} aria-hidden="true" />
                </button>
              </span>
            )}
            {note && !editing ? (
              <span className={s.chipNote} data-tone={error ? "error" : undefined}>
                {note}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
