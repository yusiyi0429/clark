"use client";

import { useMemo, useState } from "react";
import { Button } from "@heroui/react";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { ArrowRight, ChevronRight } from "lucide-react";
import type { MissionPayload } from "@/cards/payloads";
import type { Card } from "@/lib/api/client";
import { MissionStatus } from "@/components/MissionStatus";
import m from "@/styles/mission-overview.module.css";
import w from "@/styles/app-shell.module.css";

export type MissionFilters = { period: string; battlefieldId: string; capabilityId: string; ownerId: string };

const NO_CARDS: Card[] = [];

/** 周期倒序：默认作用域是最新周期，统计与行都只描述这个周期。 */
export function missionPeriods(missions: MissionPayload[]): string[] {
  return [...new Set(missions.map((item) => item.period))].sort().reverse();
}

/** 统计只数真实关系：DRI/战场/能力域都从当前集合去重，不保存汇总。 */
export function missionStats(missions: MissionPayload[]) {
  return {
    missions: missions.length,
    owners: new Set(missions.map((item) => item.ownerId)).size,
    battlefields: new Set(missions.flatMap((item) => item.battlefieldIds)).size,
    capabilities: new Set(missions.map((item) => item.capabilityId)).size,
  };
}

export function filterMissions(missions: MissionPayload[], filters: MissionFilters): MissionPayload[] {
  return missions.filter(
    (item) =>
      (!filters.period || item.period === filters.period) &&
      (!filters.battlefieldId || item.battlefieldIds.includes(filters.battlefieldId)) &&
      (!filters.capabilityId || item.capabilityId === filters.capabilityId) &&
      (!filters.ownerId || item.ownerId === filters.ownerId),
  );
}

/** 覆盖全部已登记战场时显示「全战场」，与 Pen 的 07-* 行一致。 */
export function battlefieldScope(item: MissionPayload, allBattlefieldIds: string[]): string {
  const coversAll = allBattlefieldIds.length > 0 && allBattlefieldIds.every((id) => item.battlefieldIds.includes(id));
  return coversAll ? "全战场" : item.battlefieldNames.join(" · ");
}

/** 能力域显示名：Mission 引用了没登记的能力域时（来源文档里的原值），标出来而不是留空。 */
export function capabilityLabel(item: MissionPayload): string {
  return `${item.capabilityCode} ${item.capabilityName}`.trim() || (item.capabilityId ? `${item.capabilityId}（未登记）` : "未挂能力域");
}

type Option = { id: string; label: string };

function optionsOf(missions: MissionPayload[], pick: (item: MissionPayload) => Option): Option[] {
  const items = new Map<string, Option>();
  for (const mission of missions) {
    const option = pick(mission);
    if (option.id) items.set(option.id, option);
  }
  return [...items.values()].sort((a, b) => a.label.localeCompare(b.label, "zh-Hans-CN"));
}

/**
 * Mission 总览只消费 GET /api/config/missions 与战场注册表：
 * 筛选与统计都在内存里从同一份投影派生，不落第二份事实。
 */
export function MissionOverviewScreen({
  missions,
  battlefields,
  initialFilters,
}: {
  missions: MissionPayload[];
  battlefields: { id: string; name: string }[];
  initialFilters?: { battlefieldId?: string; capabilityId?: string };
}) {
  const { navigate, close } = useWorkspace();
  useRegisterDetail({ scope: "global", label: "Mission 总览", mark: null, cards: NO_CARDS });
  const periods = useMemo(() => missionPeriods(missions), [missions]);
  const latest = periods[0] ?? "";
  const [filters, setFilters] = useState<MissionFilters>({
    period: latest,
    battlefieldId: initialFilters?.battlefieldId ?? "",
    capabilityId: initialFilters?.capabilityId ?? "",
    ownerId: "",
  });

  const capabilityOptions = useMemo(
    () => optionsOf(missions, (item) => ({ id: item.capabilityId, label: capabilityLabel(item) })),
    [missions],
  );
  const ownerOptions = useMemo(
    () => optionsOf(missions, (item) => ({ id: item.ownerId, label: item.ownerDisplayName || "待指派" })),
    [missions],
  );

  const filtered = filterMissions(missions, filters);
  const stats = missionStats(filtered);
  const battlefieldIds = battlefields.map((item) => item.id);
  const pick = (patch: Partial<MissionFilters>) => setFilters((prev) => ({ ...prev, ...patch }));
  const statLabel = filters.period === latest ? "本月 Mission" : `${filters.period} Mission`;

  return (
    <DetailFrame
      title="Mission 总览"
      subtitle="月度承诺"
      onBack={close}
      actions={
        <Button size="sm" variant="secondary" onPress={() => navigate("/config/missions")}>
          管理 Mission
        </Button>
      }
    >
      <div className={w.expandedScroll}>
        <div className={m.content}>
          <div className={m.summary} data-testid="mission-summary">
            <Stat value={stats.missions} label={statLabel} />
            <Stat value={stats.owners} label="负责人" tone="owner" />
            <Stat value={stats.battlefields} label="关联战场" tone="battlefield" />
            <Stat value={stats.capabilities} label="主要能力域" tone="capability" />
          </div>

          <div className={m.body}>
            <section className={m.filters} aria-label="Mission 筛选">
              <h2>筛选</h2>
              <FilterGroup label="周期" options={periods.map((period) => ({ id: period, label: period }))} value={filters.period} onPick={(period) => pick({ period })} />
              <FilterGroup
                label="战场"
                all="全部战场"
                options={battlefields.map((item) => ({ id: item.id, label: item.name }))}
                value={filters.battlefieldId}
                onPick={(battlefieldId) => pick({ battlefieldId })}
              />
              <FilterGroup label="能力域" all="全部能力域" options={capabilityOptions} value={filters.capabilityId} onPick={(capabilityId) => pick({ capabilityId })} />
              <FilterGroup label="负责人" all="全部负责人" options={ownerOptions} value={filters.ownerId} onPick={(ownerId) => pick({ ownerId })} />
            </section>

            <section className={m.listCard} aria-label="Mission 列表">
              <div className={m.listHead}>
                <div>
                  <h2 className={m.listTitle}>本月 Mission</h2>
                  <p className={m.listMeta}>{filtered.length} 条</p>
                </div>
                <span className={m.scope}>{filters.period || latest}</span>
              </div>
              <div className={m.rows}>
                {filtered.map((item) => (
                  <button key={item.missionId} type="button" className={m.row} onClick={() => navigate(`/missions/${item.missionId}`)}>
                    <span className={m.code}>{item.code}</span>
                    <span className={m.rowText}>
                      <span className={m.rowTitle}>{item.title}</span>
                      <MissionStatus mission={item} />
                      <span className={m.rowMeta}>
                        {item.ownerDisplayName || "待指派"} · {capabilityLabel(item)} · {battlefieldScope(item, battlefieldIds) || "未关联战场"}
                      </span>
                      {item.placeholder ? <span className={m.rowMeta}>来源 · {item.sourceTitle}</span> : null}
                    </span>
                    <ChevronRight className={m.arrow} aria-hidden="true" />
                  </button>
                ))}
                {filtered.length ? null : <p className={m.empty}>当前筛选没有 Mission。</p>}
              </div>
              <div className={m.footer}>
                <span className={m.footerHint}>共 {filtered.length} 条 Mission</span>
                <button type="button" className={m.primary} onClick={() => navigate("/config/missions")}>
                  编辑 Mission 配置
                  <ArrowRight aria-hidden="true" />
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </DetailFrame>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: string }) {
  return (
    <div className={m.stat}>
      <span className={m.statValue} data-tone={tone}>
        {value}
      </span>
      <span className={m.statLabel}>{label}</span>
    </div>
  );
}

function FilterGroup({
  label,
  all,
  options,
  value,
  onPick,
}: {
  label: string;
  all?: string;
  options: Option[];
  value: string;
  onPick: (id: string) => void;
}) {
  return (
    <div className={m.filterGroup}>
      <p className={m.filterLabel}>{label}</p>
      {all ? <FilterRow label={all} on={value === ""} onClick={() => onPick("")} /> : null}
      {options.map((option) => (
        <FilterRow key={option.id} label={option.label} on={value === option.id} onClick={() => onPick(option.id)} />
      ))}
    </div>
  );
}

function FilterRow({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={m.filterRow} aria-pressed={on} onClick={onClick}>
      <span className={m.check} data-on={on || undefined} />
      {label}
    </button>
  );
}
