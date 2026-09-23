"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronLeft, Pencil } from "lucide-react";
import type { TBattlefieldManagementResponse, TCapabilityManagementResponse, TCapabilitySupportRef } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import g from "@/styles/capability-management.module.css";
// 顶栏与页头复用配置页同一套设计常量（UpgradeDesign.pen 三页共享 Top Navigation 与 Page Header）。
import c from "@/styles/config.module.css";

type Capability = TCapabilityManagementResponse["capabilities"][number];
type Battlefield = TBattlefieldManagementResponse["battlefields"][number];
type Status = { kind: "ok" | "error"; message: string } | null;

/** 编辑草稿：编号/顺序以文本编辑，主要支撑以勾选项集合编辑，存储仍是结构化联合数组。 */
export type CapabilityDraft = { code: string; sortOrder: string; name: string; group: string; sixMonthOutcome: string; supportRefs: TCapabilitySupportRef[] };

export function capabilityDraft(item: Capability): CapabilityDraft {
  return { code: item.code, sortOrder: String(item.sortOrder), name: item.name, group: item.group, sixMonthOutcome: item.sixMonthOutcome, supportRefs: item.supportRefs };
}

/** 主要支撑的规范键：全部战场 / bf:<id> / m:<code>，用于比较勾选集合。 */
export function supportKey(ref: TCapabilitySupportRef): string {
  if (ref.type === "all-battlefields") return "all";
  return ref.type === "battlefield" ? `bf:${ref.battlefieldId}` : `m:${ref.missionCode}`;
}

/** 编辑弹层只提交真正改动的字段；勾选顺序不影响语义，比较前先排序。 */
export function capabilityEditPatch(current: CapabilityDraft, draft: CapabilityDraft) {
  const patch: {
    code?: string;
    sortOrder?: number;
    name?: string;
    group?: string;
    sixMonthOutcome?: string;
    supportRefs?: TCapabilitySupportRef[];
  } = {};
  const name = draft.name.trim();
  const code = draft.code.trim();
  if (name && name !== current.name) patch.name = name;
  if (code && code !== current.code) patch.code = code;
  const sortOrder = Number(draft.sortOrder);
  if (draft.sortOrder.trim() !== "" && Number.isInteger(sortOrder) && draft.sortOrder !== current.sortOrder) patch.sortOrder = sortOrder;
  if (draft.group !== current.group) patch.group = draft.group;
  if (draft.sixMonthOutcome !== current.sixMonthOutcome) patch.sixMonthOutcome = draft.sixMonthOutcome;
  if (draft.supportRefs.map(supportKey).sort().join("|") !== current.supportRefs.map(supportKey).sort().join("|")) patch.supportRefs = draft.supportRefs;
  return patch;
}

/** 勾选清单：全部战场 + 每个已登记战场 + 每个战场战略锚点；同一锚点 code 只出现一次。 */
function supportOptions(battlefields: Battlefield[]): { key: string; label: string; ref: TCapabilitySupportRef }[] {
  const options = new Map<string, { key: string; label: string; ref: TCapabilitySupportRef }>();
  options.set("all", { key: "all", label: "全部战场", ref: { type: "all-battlefields" } });
  for (const battlefield of battlefields) {
    options.set(`bf:${battlefield.id}`, { key: `bf:${battlefield.id}`, label: battlefield.name, ref: { type: "battlefield", battlefieldId: battlefield.id } });
    for (const mission of battlefield.missionAnchors) {
      options.set(`m:${mission.code}`, { key: `m:${mission.code}`, label: `${mission.code} ${mission.title}`, ref: { type: "mission-anchor", missionCode: mission.code } });
    }
  }
  return [...options.values()];
}

/**
 * 能力管理页只消费 GET /api/config/capabilities 一次投影：点行内铅笔编辑注册表字段，
 * 写完用 router.refresh 重读投影；能力删除不在本期范围。
 */
export function CapabilityScreen({ capabilities, battlefields }: TCapabilityManagementResponse & { battlefields: Battlefield[] }) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CapabilityDraft>({ code: "", sortOrder: "", name: "", group: "", sixMonthOutcome: "", supportRefs: [] });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);
  const options = supportOptions(battlefields);

  function openEdit(item: Capability) {
    setDraft(capabilityDraft(item));
    setEditingId(item.id);
    setStatus(null);
  }

  function toggleSupport(option: { key: string; ref: TCapabilitySupportRef }) {
    const checked = draft.supportRefs.some((ref) => supportKey(ref) === option.key);
    setDraft({ ...draft, supportRefs: checked ? draft.supportRefs.filter((ref) => supportKey(ref) !== option.key) : [...draft.supportRefs, option.ref] });
  }

  /** 401 回登录入口；成功重读服务端投影并收起弹层，失败把后端 message 原样落到页脚。 */
  async function saveCapability() {
    const item = capabilities.find((capability) => capability.id === editingId);
    if (!item || busy) return;
    const patch = capabilityEditPatch(capabilityDraft(item), draft);
    if (!Object.keys(patch).length) {
      setEditingId(null);
      return;
    }
    setBusy(true);
    const { response, error } = await browserApi.PATCH("/api/config/capabilities/{id}", {
      params: { path: { id: item.id } },
      body: patch,
    });
    setBusy(false);
    if (response.status === 401) {
      router.push("/access?next=/config/capabilities");
      return;
    }
    if (response.ok) {
      setStatus({ kind: "ok", message: "已保存" });
      setEditingId(null);
      router.refresh();
      return;
    }
    setStatus({ kind: "error", message: (error as { message?: string } | undefined)?.message ?? `保存失败（${response.status}）` });
  }

  return (
    <main className={c.shell}>
      <nav className={c.topbar} aria-label="能力管理页导航">
        <button type="button" className={c.back} onClick={() => router.push("/config")}>
          <ChevronLeft aria-hidden="true" /> 返回配置
        </button>
        <span className={c.draft}>配置变更写入业务库并同步 Radar 监测范围</span>
      </nav>

      <header className={c.header}>
        <p className={c.eyebrow}>CAPABILITY</p>
        <h1 className={c.title}>能力管理</h1>
        <p className={c.subtitle}>编辑已登记的组织能力：编号、分组、六个月目标与主要支撑。修改后首页能力面板立即更新。</p>
      </header>

      <section className={g.card}>
        <div className={c.cardHead}>
          <h2>能力</h2>
          <p>{capabilities.length} 项已登记能力 · 点击编辑</p>
        </div>
        <div className={g.list}>
          {capabilities.map((item) => (
            <div key={item.id} className={g.row} data-editing={item.id === editingId || undefined}>
              <span className={g.dot} />
              <span className={g.rowText}>
                <span className={g.rowTitle}>
                  {item.code ? <span className={g.code}>{item.code}</span> : null}
                  {item.name}
                </span>
                <span className={g.rowMeta}>{item.group ? `${item.group} · ` : ""}{item.sixMonthOutcome}</span>
              </span>
              <button type="button" className={g.edit} aria-label={`编辑${item.name}`} onClick={() => openEdit(item)}>
                <Pencil aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
        {editingId ? (
          <div className={`${g.popover} ${g.wide}`} role="dialog" aria-label="编辑能力">
            <p className={g.popoverTitle}>编辑能力</p>
            <label className={g.field}>
              <span>显示编号 / 顺序</span>
              <span className={g.pair}>
                <input value={draft.code} maxLength={40} onChange={(event) => setDraft({ ...draft, code: event.target.value })} />
                <input type="number" min={0} max={9999} aria-label="排序" value={draft.sortOrder} onChange={(event) => setDraft({ ...draft, sortOrder: event.target.value })} />
              </span>
            </label>
            <label className={g.field}>
              <span>能力名称</span>
              <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            </label>
            <label className={g.field}>
              <span>所属分组（可选）</span>
              <input value={draft.group} onChange={(event) => setDraft({ ...draft, group: event.target.value })} />
            </label>
            <label className={g.field}>
              <span>六个月目标</span>
              <textarea value={draft.sixMonthOutcome} onChange={(event) => setDraft({ ...draft, sixMonthOutcome: event.target.value })} />
            </label>
            <div className={g.field}>
              <span>主要支撑（战略锚点 / 战场）</span>
              <div className={g.support} role="group" aria-label="主要支撑">
                {options.map((option) => (
                  <label key={option.key} className={g.supportRow}>
                    <input type="checkbox" checked={draft.supportRefs.some((ref) => supportKey(ref) === option.key)} onChange={() => toggleSupport(option)} />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <span className={g.actions}>
              <button type="button" className={g.cancel} onClick={() => setEditingId(null)}>
                取消
              </button>
              <button type="button" className={g.save} onClick={saveCapability} disabled={busy || !draft.name.trim()}>
                保存
              </button>
            </span>
          </div>
        ) : null}
        <div className={g.footer}>
          <span className={g.footerHint} data-kind={status?.kind} role="status">
            {status?.message ?? "修改后立即生效，影响首页分组与议题归属显示"}
          </span>
          <button type="button" className={c.primary} onClick={() => router.push("/config")}>
            完成
            <ArrowRight aria-hidden="true" />
          </button>
        </div>
      </section>
    </main>
  );
}
