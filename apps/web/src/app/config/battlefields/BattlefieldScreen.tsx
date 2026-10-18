"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronLeft, ChevronRight, Flag, Pencil, Plus, Target, Trash2 } from "lucide-react";
import type { TMissionAnchor, TBattlefieldManagementResponse } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import type { PersonOption } from "@/lib/api/server";
import { Select } from "@/components/ui/Select";
import b from "@/styles/battlefield-management.module.css";
// 顶栏与页头复用配置页同一套设计常量（UpgradeDesign.pen 两页共享 Top Navigation 与 Page Header）。
import c from "@/styles/config.module.css";

type Issue = TBattlefieldManagementResponse["issues"][number];
type Battlefield = TBattlefieldManagementResponse["battlefields"][number];
type Status = { kind: "ok" | "error"; message: string } | null;

/** 编辑草稿：编号/顺序以文本编辑，战略锚点以「编号 标题」逐行文本编辑，存储仍是结构化值。 */
export type BattlefieldDraft = { code: string; sortOrder: string; name: string; ownerId: string; sixMonthOutcome: string; missionAnchors: string; participantIds: string[] };

export function formatMissionAnchors(missionAnchors: TMissionAnchor[]): string {
  return missionAnchors.map((mission) => `${mission.code} ${mission.title}`).join("\n");
}

export type MissionAnchorParse = { ok: true; missionAnchors: TMissionAnchor[] } | { ok: false; error: string };

/**
 * 「编号 空格 标题」逐行解析：空文本合法；缺编号、缺标题或编号重复返回错误，不静默丢行。
 */
export function parseMissionAnchors(text: string): MissionAnchorParse {
  const missionAnchors: TMissionAnchor[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    const split = line.indexOf(" ");
    if (split < 0) return { ok: false, error: `第 ${index + 1} 行缺少编号或标题：每行需为「编号 空格 标题」` };
    const code = line.slice(0, split).trim();
    const title = line.slice(split + 1).trim();
    if (!code) return { ok: false, error: `第 ${index + 1} 行缺少编号` };
    if (!title) return { ok: false, error: `第 ${index + 1} 行缺少标题` };
    if (seen.has(code)) return { ok: false, error: `第 ${index + 1} 行编号 ${code} 重复` };
    seen.add(code);
    missionAnchors.push({ code, title });
  }
  return { ok: true, missionAnchors };
}

export function battlefieldDraft(item: Battlefield): BattlefieldDraft {
  return { code: item.code, sortOrder: String(item.sortOrder), name: item.name, ownerId: item.ownerId, sixMonthOutcome: item.sixMonthOutcome, missionAnchors: formatMissionAnchors(item.missionAnchors), participantIds: item.participantIds };
}

const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

/** 编辑弹层只提交真正改动的字段：未动的负责人（可能是空串）不重写，避免被当成新值。 */
export type BattlefieldPatch = {
  code?: string;
  sortOrder?: number;
  name?: string;
  ownerId?: string;
  sixMonthOutcome?: string;
  missionAnchors?: TMissionAnchor[];
  participantIds?: string[];
};

export function battlefieldEditPatch(
  current: BattlefieldDraft,
  draft: BattlefieldDraft,
): { ok: true; patch: BattlefieldPatch } | { ok: false; error: string } {
  const patch: BattlefieldPatch = {};
  const name = draft.name.trim();
  const code = draft.code.trim();
  if (name && name !== current.name) patch.name = name;
  if (code && code !== current.code) patch.code = code;
  const sortOrder = Number(draft.sortOrder);
  if (draft.sortOrder.trim() !== "" && Number.isInteger(sortOrder) && draft.sortOrder !== current.sortOrder) patch.sortOrder = sortOrder;
  if (draft.ownerId !== current.ownerId) patch.ownerId = draft.ownerId;
  if (draft.sixMonthOutcome !== current.sixMonthOutcome) patch.sixMonthOutcome = draft.sixMonthOutcome;
  if (draft.missionAnchors !== current.missionAnchors) {
    const parsed = parseMissionAnchors(draft.missionAnchors);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    patch.missionAnchors = parsed.missionAnchors;
  }
  // 推算出的名单没动过就不保存，下次起草仍按上月 Mission 推算。
  if (!sameIds(draft.participantIds, current.participantIds)) patch.participantIds = draft.participantIds;
  return { ok: true, patch };
}

/** 期限只显示月日（设计：期限 09-30）；缺 decisionBy 时显示待校准。 */
function dueLabel(issue: Issue) {
  return issue.decisionBy ? `期限 ${issue.decisionBy.slice(5, 10)}` : "待校准";
}

/** 归属标注取归一化集合：空集合是未归属，多战场用、连接。 */
function ownerLabel(issue: Issue, names: Map<string, string>) {
  const owned = issue.battlefieldIds.map((id) => names.get(id)).filter((name): name is string => Boolean(name));
  return owned.length ? owned.join("、") : "未归属";
}

/**
 * 战场管理页只消费 GET /api/config/battlefields 一次投影：
 * 左侧选战场并删除，右侧看关联议题、增删议题归属，写完用 router.refresh 重读投影。
 * 带 battlefieldId 进入（签发页「改参与者」）时直接展开这个战场的编辑。
 */
export function BattlefieldScreen({ battlefields, issues, people, initialBattlefieldId }: TBattlefieldManagementResponse & { people: PersonOption[]; initialBattlefieldId?: string }) {
  const router = useRouter();
  const initial = battlefields.find((item) => item.id === initialBattlefieldId);
  const [selectedId, setSelectedId] = useState(initial?.id ?? battlefields[0]?.id ?? "");
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(Boolean(initial));
  const [draft, setDraft] = useState<BattlefieldDraft>(initial ? battlefieldDraft(initial) : { code: "", sortOrder: "", name: "", ownerId: "", sixMonthOutcome: "", missionAnchors: "", participantIds: [] });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Record<"list" | "pick", Status>>({ list: null, pick: null });

  const names = new Map(battlefields.map((item) => [item.id, item.name]));
  const selected = battlefields.find((item) => item.id === selectedId) ?? battlefields[0];
  const missionParse = parseMissionAnchors(draft.missionAnchors);
  const missionError = missionParse.ok ? null : missionParse.error;
  const related = selected ? issues.filter((issue) => issue.battlefieldIds.includes(selected.id)) : [];
  // CEO 不拿任务卡，名单里不出现。
  const candidates = people.filter((person) => !person.roles.includes("ceo"));
  const report = (slot: "list" | "pick", value: Status) => setStatus((prev) => ({ ...prev, [slot]: value }));

  /** 401 回登录入口；成功重读服务端投影，失败把后端 message 原样落到对应页脚。 */
  async function settle(slot: "list" | "pick", response: { status: number; ok: boolean }, error: unknown, ok: string): Promise<boolean> {
    if (response.status === 401) {
      router.push("/access?next=/config/battlefields");
      return false;
    }
    if (response.ok) {
      report(slot, { kind: "ok", message: ok });
      router.refresh();
      return true;
    }
    const message = (error as { message?: string } | undefined)?.message ?? `操作失败（${response.status}）`;
    report(slot, { kind: "error", message });
    return false;
  }

  /** 编辑弹层回填当前注册表行；id 不变，改名或改编号撞到其他行由后端 409 拒绝。 */
  function openEdit(item: Battlefield) {
    setSelectedId(item.id);
    setConfirming(false);
    setDraft(battlefieldDraft(item));
    setEditing(true);
  }

  async function saveBattlefield() {
    if (!selected || busy) return;
    const result = battlefieldEditPatch(battlefieldDraft(selected), draft);
    if (!result.ok) {
      report("list", { kind: "error", message: result.error });
      return;
    }
    const patch = result.patch;
    if (!Object.keys(patch).length) {
      setEditing(false);
      return;
    }
    setBusy(true);
    const { response, error } = await browserApi.PATCH("/api/config/battlefields/{id}", {
      params: { path: { id: selected.id } },
      body: patch,
    });
    setBusy(false);
    if (await settle("list", response, error, "已保存")) setEditing(false);
  }

  async function removeBattlefield() {
    if (!selected || busy) return;
    setBusy(true);
    const { response, error } = await browserApi.DELETE("/api/config/battlefields/{id}", { params: { path: { id: selected.id } } });
    setBusy(false);
    setConfirming(false);
    await settle("list", response, error, "已删除");
  }

  /** 勾选态即归属态：已关联则移出，未关联则加入（同一归一化集合）。 */
  async function toggleIssue(issue: Issue) {
    if (!selected || busy) return;
    const member = issue.battlefieldIds.includes(selected.id);
    setBusy(true);
    const { response, error } = member
      ? await browserApi.DELETE("/api/config/battlefields/{id}/issues/{issueId}", { params: { path: { id: selected.id, issueId: issue.id } } })
      : await browserApi.POST("/api/config/battlefields/{id}/issues", { params: { path: { id: selected.id } }, body: { issueId: issue.id } });
    setBusy(false);
    await settle("pick", response, error, member ? "已移出战场" : "已加入战场");
  }

  return (
    <main className={c.shell}>
      <nav className={c.topbar} aria-label="战场管理页导航">
        <button type="button" className={c.back} onClick={() => router.push("/")}>
          <ChevronLeft aria-hidden="true" /> 返回首页
        </button>
      </nav>

      <header className={c.header}>
        <p className={c.eyebrow}>BATTLEFIELD</p>
        <h1 className={c.title}>战场管理</h1>
      </header>

      <div className={b.body}>
        <div className={b.left}>
          <section className={b.listCard}>
            <CardHead title="战场" desc={`${battlefields.length} 个战场`} icon={<Flag aria-hidden="true" />} />
            <div className={b.rows}>
              {battlefields.map((item) => (
                <div key={item.id} className={b.row} data-selected={item.id === selected?.id || undefined}>
                  <button
                    type="button"
                    className={b.rowMain}
                    aria-current={item.id === selected?.id || undefined}
                    onClick={() => {
                      setSelectedId(item.id);
                      setConfirming(false);
                      setEditing(false);
                    }}
                  >
                    <span className={b.dot} />
                    <span className={b.rowText}>
                      <span className={b.rowTitle}>{item.name}</span>
                      <span className={b.rowMeta}>负责人 {item.ownerDisplayName || "待指派"} · {item.pendingIssueCount} 个议题</span>
                    </span>
                  </button>
                  <button type="button" className={b.rowIcon} aria-label={`编辑${item.name}`} onClick={() => openEdit(item)}>
                    <Pencil aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={b.rowIcon}
                    aria-label={`删除${item.name}`}
                    onClick={() => {
                      setSelectedId(item.id);
                      setConfirming(true);
                      setEditing(false);
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
            {confirming && selected ? (
              <div className={b.confirm} role="dialog" aria-label="删除该战场？">
                <p className={b.confirmTitle}>删除该战场？</p>
                <p className={b.confirmBody}>删除后战场下的议题会解除关联，议题本身不会被删除。</p>
                <span className={b.confirmActions}>
                  <button type="button" className={b.cancel} onClick={() => setConfirming(false)}>
                    取消
                  </button>
                  <button type="button" className={b.danger} onClick={removeBattlefield} disabled={busy}>
                    删除
                  </button>
                </span>
              </div>
            ) : null}
            {editing && selected ? (
              <div className={`${b.confirm} ${b.wide}`} role="dialog" aria-label="编辑战场">
                <p className={b.confirmTitle}>编辑战场</p>
                <label className={b.field}>
                  <span>显示编号 / 顺序</span>
                  <span className={b.pair}>
                    <input value={draft.code} maxLength={40} onChange={(event) => setDraft({ ...draft, code: event.target.value })} />
                    <input type="number" min={0} max={9999} aria-label="排序" value={draft.sortOrder} onChange={(event) => setDraft({ ...draft, sortOrder: event.target.value })} />
                  </span>
                </label>
                <label className={b.field}>
                  <span>战场名称</span>
                  <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
                </label>
                <label className={b.field}>
                  <span>负责人</span>
                  <Select aria-label="负责人" value={draft.ownerId} onChange={(ownerId) => setDraft({ ...draft, ownerId })}
                    options={[{ value: "", label: "待指派" }, ...people.map((person) => ({ value: person.personId, label: person.displayName }))]} />
                </label>
                <label className={b.field}>
                  <span>长期目标 · 六个月</span>
                  <textarea value={draft.sixMonthOutcome} onChange={(event) => setDraft({ ...draft, sixMonthOutcome: event.target.value })} />
                </label>
                <label className={b.field}>
                  <span>战略锚点（每行：编号 + 标题）</span>
                  <textarea value={draft.missionAnchors} onChange={(event) => setDraft({ ...draft, missionAnchors: event.target.value })} />
                  {missionError ? <span className={b.fieldError} role="alert">{missionError}</span> : null}
                </label>
                <div className={b.field} role="group" aria-labelledby="battlefield-participants">
                  <span id="battlefield-participants">
                    参与者
                    {selected.participantsDerived && sameIds(draft.participantIds, selected.participantIds) ? <em className={b.fieldNote}>按上月 Mission 推算</em> : null}
                  </span>
                  <div className={b.choices}>
                    {candidates.map((person) => (
                      <label key={person.personId} className={b.choice}>
                        <input
                          type="checkbox"
                          checked={draft.participantIds.includes(person.personId)}
                          onChange={(event) => {
                            const chosen = new Set(draft.participantIds);
                            if (event.target.checked) chosen.add(person.personId);
                            else chosen.delete(person.personId);
                            setDraft({ ...draft, participantIds: candidates.filter((item) => chosen.has(item.personId)).map((item) => item.personId) });
                          }}
                        />
                        {person.displayName}
                      </label>
                    ))}
                  </div>
                </div>
                <span className={b.confirmActions}>
                  <button type="button" className={b.cancel} onClick={() => setEditing(false)}>
                    取消
                  </button>
                  <button type="button" className={b.save} onClick={saveBattlefield} disabled={busy || !draft.name.trim() || Boolean(missionError)}>
                    保存
                  </button>
                </span>
              </div>
            ) : null}
            <CardFooter status={status.list}>
              <DoneButton onClick={() => router.push("/config")} />
            </CardFooter>
          </section>
        </div>

        <div className={b.right}>
          <section className={b.relatedCard}>
            <CardHead title="关联议题" desc={selected ? `${selected.name} · ${related.length} 个议题` : "暂无战场"} icon={<Target aria-hidden="true" />} tone="issue" />
            <div className={b.rows}>
              {related.map((issue) => (
                <button key={issue.id} type="button" className={b.issueRow} onClick={() => router.push(`/issues/${issue.id}`)}>
                  <span className={b.dot} data-urgency={issue.urgencyLevel} />
                  <span className={b.rowText}>
                    <span className={b.rowTitle}>{issue.title}</span>
                    <span className={b.rowMeta}>{ownerLabel(issue, names)} · {dueLabel(issue)}</span>
                  </span>
                  <ChevronRight aria-hidden="true" className={b.chevron} />
                </button>
              ))}
            </div>
          </section>

          <section className={b.pickCard}>
            <CardHead title="添加议题" icon={<Plus aria-hidden="true" />} tone="add" />
            <div className={b.pickBody}>
              <p className={b.pickerLabel}>已有议题（{issues.length}）</p>
              <div className={b.rows}>
                {issues.map((issue) => {
                  const member = Boolean(selected && issue.battlefieldIds.includes(selected.id));
                  return (
                    <button key={issue.id} type="button" className={b.pickRow} data-member={member || undefined} disabled={!selected || busy} onClick={() => toggleIssue(issue)}>
                      <span className={b.check} data-member={member || undefined} />
                      <span className={b.rowText}>
                        <span className={b.rowTitle}>{issue.title}</span>
                        <span className={b.rowMeta}>{ownerLabel(issue, names)} · {dueLabel(issue)}</span>
                      </span>
                      <Plus aria-hidden="true" className={b.plus} />
                    </button>
                  );
                })}
              </div>
            </div>
            <CardFooter status={status.pick}>
              <DoneButton onClick={() => router.push("/config")} />
            </CardFooter>
          </section>
        </div>
      </div>
    </main>
  );
}

function CardHead({ title, desc, icon, tone }: { title: string; desc?: string; icon: ReactNode; tone?: "issue" | "add" }) {
  return (
    <>
      <div className={c.cardHead}>
        <h2>{title}</h2>
        {desc ? <p>{desc}</p> : null}
      </div>
      <span className={b.iconChip} data-tone={tone}>
        {icon}
      </span>
    </>
  );
}

function CardFooter({ status, children }: { status?: Status; children?: ReactNode }) {
  return (
    <div className={b.cardFooter}>
      <span className={b.footerHint} data-kind={status?.kind} role="status">
        {status?.message}
      </span>
      {children}
    </div>
  );
}

function DoneButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={b.primary} onClick={onClick}>
      完成
      <ArrowRight aria-hidden="true" />
    </button>
  );
}
