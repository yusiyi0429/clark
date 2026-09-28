"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Search } from "lucide-react";
import type { TMissionEditInput } from "@warmap/contracts";
import type { Card } from "@/lib/api/client";
import { useCardAction } from "@/lib/useCardAction";
import { payloadOf, type MissionPayload } from "@/cards/payloads";
import type { PersonOption } from "@/lib/api/server";
import { MissionStatus } from "@/components/MissionStatus";
import m from "@/styles/mission-management.module.css";
import c from "@/styles/config.module.css";

export type MissionDraft = {
  code: string;
  period: string;
  title: string;
  ownerId: string;
  capabilityId: string;
  battlefieldIds: string[];
  outcome: string;
  why: string;
  successEvidence: string;
  milestones: string;
  dependencies: string;
  risk: string;
  boundaries: string;
};

export const MISSION_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 成功证据与关键里程碑都是「每行一项」；空行不产生空条目。 */
export function parseMissionLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function missionDraft(mission: MissionPayload): MissionDraft {
  return {
    code: mission.code,
    period: mission.period,
    title: mission.title,
    ownerId: mission.ownerId,
    capabilityId: mission.capabilityId,
    battlefieldIds: [...mission.battlefieldIds],
    outcome: mission.outcome,
    why: mission.why,
    successEvidence: mission.successEvidence.join("\n"),
    milestones: mission.milestones.join("\n"),
    dependencies: mission.dependencies,
    risk: mission.risk,
    boundaries: mission.boundaries,
  };
}

/**
 * 编辑只提交真正改动的字段（Action 要求至少一项）；source metadata 不在这里，保持不可从 Web 编辑。
 * 关系与文本校验在提交前给出可读错误，避免把非法输入交给后端。
 */
export function missionEditPatch(current: MissionDraft, draft: MissionDraft): { ok: true; patch: TMissionEditInput } | { ok: false; error: string } {
  const patch: TMissionEditInput = {};
  const code = draft.code.trim();
  const period = draft.period.trim();
  const title = draft.title.trim();
  const outcome = draft.outcome.trim();
  if (!code) return { ok: false, error: "编号不能为空" };
  if (!title) return { ok: false, error: "Mission 标题不能为空" };
  if (!MISSION_PERIOD_PATTERN.test(period)) return { ok: false, error: "周期需为 YYYY-MM（月份 01–12）" };
  if (!draft.ownerId) return { ok: false, error: "必须指定唯一 DRI" };
  if (!draft.capabilityId) return { ok: false, error: "必须选择主要能力域" };
  if (!outcome) return { ok: false, error: "Mission Outcome 不能为空" };

  if (code !== current.code) patch.code = code;
  if (period !== current.period) patch.period = period;
  if (title !== current.title) patch.title = title;
  if (draft.ownerId !== current.ownerId) patch.ownerId = draft.ownerId;
  if (draft.capabilityId !== current.capabilityId) patch.capabilityId = draft.capabilityId;
  if (draft.battlefieldIds.join(",") !== current.battlefieldIds.join(",")) patch.battlefieldIds = draft.battlefieldIds;
  if (outcome !== current.outcome) patch.outcome = outcome;
  if (draft.why !== current.why) patch.why = draft.why;
  const evidence = parseMissionLines(draft.successEvidence);
  if (evidence.join("\n") !== parseMissionLines(current.successEvidence).join("\n")) patch.successEvidence = evidence;
  const milestones = parseMissionLines(draft.milestones);
  if (milestones.join("\n") !== parseMissionLines(current.milestones).join("\n")) patch.milestones = milestones;
  if (draft.dependencies !== current.dependencies) patch.dependencies = draft.dependencies;
  if (draft.risk !== current.risk) patch.risk = draft.risk;
  if (draft.boundaries !== current.boundaries) patch.boundaries = draft.boundaries;
  return { ok: true, patch };
}

/**
 * Mission 配置页读 GET /api/cards/missions：编辑需要当前 version 与 opaque Action 锚，两者只在 Card 上。
 * 保存成功后重读投影，不维护 Web 侧的第二份列表状态。
 */
export function MissionManagementScreen({
  missions,
  battlefields,
  capabilities,
  people,
  initialMissionId,
}: {
  missions: Card[];
  battlefields: { id: string; name: string }[];
  capabilities: { id: string; code: string; name: string }[];
  people: PersonOption[];
  initialMissionId?: string;
}) {
  const router = useRouter();
  const action = useCardAction(() => undefined);
  const rows = useMemo(() => missions.map((card) => ({ card, payload: payloadOf<MissionPayload>(card) })), [missions]);
  // deep link 必须命中同一条 row：未命中时留空，绝不用 rows[0] 兜底，否则编辑器会显示首条内容并把首条差异写回目标 Mission。
  const linked = initialMissionId ? rows.find((item) => item.payload.missionId === initialMissionId) : undefined;
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(linked?.payload.missionId ?? (initialMissionId ? "" : rows[0]?.payload.missionId ?? ""));
  const [draft, setDraft] = useState<MissionDraft | null>(linked ? missionDraft(linked.payload) : null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error" | "conflict"; text: string } | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(({ payload }) =>
      [payload.code, payload.title, payload.ownerDisplayName].some((field) => field.toLowerCase().includes(needle)),
    );
  }, [rows, query]);

  const selected = rows.find((item) => item.payload.missionId === selectedId);
  const result = selected && draft ? missionEditPatch(missionDraft(selected.payload), draft) : null;
  const error = result && !result.ok ? result.error : null;
  const dirty = Boolean(result?.ok && Object.keys(result.patch).length);
  const status = message ?? (action.state.status === "conflict" || action.state.status === "error" ? { kind: action.state.status, text: action.state.message } : null);

  function openEdit(payload: MissionPayload) {
    setSelectedId(payload.missionId);
    setDraft(missionDraft(payload));
    setMessage(null);
    action.reset();
  }

  function toggleBattlefield(id: string) {
    if (!draft) return;
    setDraft({
      ...draft,
      battlefieldIds: draft.battlefieldIds.includes(id) ? draft.battlefieldIds.filter((item) => item !== id) : [...draft.battlefieldIds, id],
    });
  }

  /** 动作锚取当前 Card：跨标签页改过同一 Mission 时这里就是旧锚，后端 409 后重读投影。 */
  async function saveMission() {
    if (!selected || selected.payload.personalCard || !draft || !result?.ok || !dirty || busy) return;
    const descriptor = selected.card.actions.find((item) => item.actionType === "mission.edit");
    if (!descriptor) {
      setMessage({ kind: "error", text: "当前版本没有可用的编辑动作，请刷新后重试" });
      return;
    }
    setBusy(true);
    setMessage(null);
    const saved = await action.run(descriptor, result.patch);
    setBusy(false);
    router.refresh();
    if (saved) {
      setDraft(null);
      setMessage({ kind: "ok", text: "已保存新版本" });
    }
  }

  return (
    <main className={c.shell}>
      <nav className={c.topbar} aria-label="Mission 配置页导航">
        <button type="button" className={c.back} onClick={() => router.push("/config")}>
          返回配置
        </button>
        <span className={c.draft}>
          {selected?.payload.personalCard && selected.payload.personalCard.status !== "confirmed" ? "月度承诺 · 含待确认草稿" : "Organization Fact · CEO 确认"}
        </span>
      </nav>

      <header className={c.header}>
        <p className={c.eyebrow}>MISSION SETTINGS</p>
        <h1 className={c.title}>Mission 配置</h1>
        <p className={c.subtitle}>编辑 Mission 的结果承诺、责任人和组织关系。修改生成新版本，不覆盖历史来源。</p>
      </header>

      <div className={m.body}>
        <section className={m.listCard} aria-label="已登记 Mission">
          <h2 className={m.listTitle}>已登记 Mission</h2>
          <p className={m.listMeta}>{missions.length} 条 · 按周期与能力域排序</p>
          <label className={m.search}>
            <Search aria-hidden="true" />
            <input value={query} placeholder="按编号、标题或 DRI 搜索" aria-label="搜索 Mission" onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className={m.rows}>
            {visible.map(({ card, payload }) => (
              <button
                key={card.id}
                type="button"
                className={m.row}
                data-selected={payload.missionId === selectedId || undefined}
                aria-current={payload.missionId === selectedId || undefined}
                onClick={() => openEdit(payload)}
              >
                <span className={m.code}>{payload.code}</span>
                <span className={m.rowText}>
                  <span className={m.rowTitle}>{payload.title}</span>
                  <MissionStatus mission={payload} />
                  <span className={m.rowOwner}>{payload.ownerDisplayName || "待指派"}</span>
                </span>
                {payload.personalCard ? null : <Pencil className={m.edit} aria-hidden="true" />}
              </button>
            ))}
            {visible.length ? null : <p className={m.empty}>没有匹配的 Mission。</p>}
          </div>
        </section>

        <section className={m.editor} aria-label="Mission 编辑器">
          {selected?.payload.personalCard ? (
            <div className={m.fields}>
              <h2 className={m.editorTitle}>{selected.payload.title}</h2>
              <MissionStatus mission={selected.payload} />
              <p className={m.editorMeta} role="status">
                {selected.payload.personalCard.status === "confirmed"
                  ? "个人 Mission Card 已确定，不能在配置页单独修改；要改字段，请在任务卡上更正。"
                  : "此 Mission 属于个人 Mission Card，需在本轮制定中讨论并统一确认，不能在配置页单独修改。"}
              </p>
              <p className={m.source}>来源 · {selected.payload.sourceTitle}</p>
            </div>
          ) : selected && draft ? (
            <>
              <div className={m.editorHead}>
                <div>
                  <h2 className={m.editorTitle}>编辑 Mission</h2>
                  <p className={m.editorMeta}>
                    {selected.payload.code} · 当前版本 v{selected.card.version}
                  </p>
                </div>
                <span className={m.source}>来源 · {selected.payload.sourceTitle}</span>
              </div>

              <div className={m.fields}>
                <div className={m.fieldRow}>
                  <Field label="编号">
                    <input value={draft.code} maxLength={40} onChange={(event) => setDraft({ ...draft, code: event.target.value })} />
                  </Field>
                  <Field label="周期">
                    <input value={draft.period} placeholder="2026-09" onChange={(event) => setDraft({ ...draft, period: event.target.value })} />
                  </Field>
                  <Field label="唯一 DRI">
                    <select value={draft.ownerId} onChange={(event) => setDraft({ ...draft, ownerId: event.target.value })}>
                      <option value="">待指派</option>
                      {people.map((person) => (
                        <option key={person.personId} value={person.personId}>
                          {person.displayName}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>

                <Field label="Mission 标题">
                  <input value={draft.title} maxLength={200} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
                </Field>

                <div className={m.fieldRow} data-columns="three">
                  <Field label="主要能力域">
                    <select value={draft.capabilityId} onChange={(event) => setDraft({ ...draft, capabilityId: event.target.value })}>
                      <option value="">未选择</option>
                      {capabilities.map((item) => (
                        <option key={item.id} value={item.id}>
                          {`${item.code} ${item.name}`.trim()}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="关联战场">
                    <div className={m.choices}>
                      {battlefields.map((item) => {
                        const on = draft.battlefieldIds.includes(item.id);
                        return (
                          <button key={item.id} type="button" className={m.choice} aria-pressed={on} onClick={() => toggleBattlefield(item.id)}>
                            <span className={m.check} />
                            {item.name}
                          </button>
                        );
                      })}
                      {battlefields.length ? null : <span className={m.rowOwner}>没有已登记战场</span>}
                    </div>
                  </Field>
                  <Field label="月度计划">
                    <input value={draft.period} readOnly aria-label="月度计划周期" />
                  </Field>
                </div>

                <Field label="Mission Outcome">
                  <textarea value={draft.outcome} maxLength={4000} onChange={(event) => setDraft({ ...draft, outcome: event.target.value })} />
                </Field>

                <Field label="Why / 背景">
                  <textarea value={draft.why} maxLength={4000} onChange={(event) => setDraft({ ...draft, why: event.target.value })} />
                </Field>

                <div className={m.fieldRow} data-columns="two">
                  <Field label="成功证据（每行一项）">
                    <textarea value={draft.successEvidence} onChange={(event) => setDraft({ ...draft, successEvidence: event.target.value })} />
                  </Field>
                  <Field label="关键里程碑（每行一项）">
                    <textarea value={draft.milestones} onChange={(event) => setDraft({ ...draft, milestones: event.target.value })} />
                  </Field>
                </div>

                <div className={m.fieldRow} data-columns="two">
                  <Field label="关键依赖">
                    <textarea value={draft.dependencies} maxLength={4000} onChange={(event) => setDraft({ ...draft, dependencies: event.target.value })} />
                  </Field>
                  <Field label="最大风险">
                    <textarea value={draft.risk} maxLength={4000} onChange={(event) => setDraft({ ...draft, risk: event.target.value })} />
                  </Field>
                </div>

                <Field label="边界">
                  <textarea value={draft.boundaries} maxLength={4000} onChange={(event) => setDraft({ ...draft, boundaries: event.target.value })} />
                </Field>

                {error ? (
                  <p className={m.fieldError} role="alert">
                    {error}
                  </p>
                ) : null}
              </div>

              <div className={m.footer}>
                <p className={m.footerHint} data-kind={status?.kind} role="status">
                  {status?.text ?? "保存后 version +1；历史来源与旧版本保持可追溯。"}
                </p>
                <div className={m.actions}>
                  <button
                    type="button"
                    className={m.cancel}
                    onClick={() => {
                      setDraft(null);
                      setMessage(null);
                    }}
                  >
                    取消
                  </button>
                  <button type="button" className={m.save} onClick={saveMission} disabled={busy || !dirty}>
                    保存新版本
                  </button>
                </div>
              </div>
            </>
          ) : (
            <p className={m.empty}>选择左侧 Mission 后编辑结果承诺与关系。</p>
          )}
        </section>
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className={m.field}>
      <span>{label}</span>
      {children}
    </label>
  );
}
