"use client";

/**
 * 技能（「连接和技能」页的「技能」标签，设计 §17.2 第 22 条：「岗位」改叫「技能」，去掉「岗位包」）。代码里的 roles、family 不动，只改给人看的字。
 * - 我的：最上面是「待你确认」（别人的卡提的技能修改：哪个技能、改哪一段、哪张卡、为什么；「看改动」展开改前改后；「采纳」写回、「不要」丢掉），
 *   下面是我的技能卡（图标、名字、职责第一句、来源「预设 / 自己写的」、右上角 ✓），点卡进详情。
 * - 可添加：全部预设，按通用、研发、战略和内容分组；加过的 ✓，没加的 +，点 + 就地添加。
 * - 详情：名称、职责 / 做法 / 验收口径（Markdown，点一下改，「预览」回去）、工具（多选）、模型档位（三段）、修改记录（点开看原因和每项改前改后）。
 *   有改动才出「取消 / 保存」；保存只带改了的字段和版本号，别人先改过（409）就重读。
 * 成功不弹 toast，看得到的变化就是反馈；没成在原处写「失败 · 重试」。不写说明句。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import { ChevronLeft, ChevronRight, ClipboardCheck, Hammer, MessageSquareWarning } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { SegmentedSwitch } from "@/components/SegmentedSwitch";
import { FailedLine, failureOf, type Failure } from "@/components/work/DecisionBox";
import { CloudError } from "@/lib/board/cloud";
import { REMARK_PLUGINS } from "@/lib/markdown";
import {
  CHANGE_LABEL, FAMILY_LABEL, FIELDS, FIELD_LABEL, KIND_LABEL, TIERS, TIER_LABEL, TOOLS, TOOL_LABEL,
  addPreset, decideProposal, listProposals, listRevisions, listRoles, patchRole,
  type ModelTier, type PatchRoleRequest, type RoleFamily, type RoleKind, type RoleListResponse, type RoleProposalView, type RoleRevisionView, type RoleView,
} from "@/lib/team/roles";
import type { SecondaryPageProps } from "./index";
import { AddButton, Added, Card, CardGrid, ICON, Loading, Row, Section, relative } from "./parts";
import p from "@/styles/home-pages.module.css";

const roleLine = (role: Pick<RoleView, "family" | "kind">) => `${FAMILY_LABEL[role.family]} · ${KIND_LABEL[role.kind]}`;
const cardHref = (id: string) => `/me/work/cards/${encodeURIComponent(id)}`;
const TIER_SEGMENTS = TIERS.map((tier) => ({ id: tier, label: TIER_LABEL[tier] }));
const KIND_ICON: Record<RoleKind, ReactNode> = { worker: <Hammer {...ICON} />, reviewer: <ClipboardCheck {...ICON} />, critic: <MessageSquareWarning {...ICON} /> };

/** 卡上那一行：职责的第一句（跳过标题行，去掉 Markdown 记号）。 */
export function dutyLine(md: string): string {
  const line = md.split("\n").filter((text) => !/^\s*#/.test(text)).map((text) => text.replace(/^\s*(?:>|[-*+]|\d+[.、)])\s*/, "").replace(/[*_`~]|\[([^\]]*)\]\([^)]*\)/g, "$1").trim()).find(Boolean) ?? "";
  const end = line.search(/[。！？!?；;]|\.(?:\s|$)/);
  return end >= 0 ? line.slice(0, end + 1) : line;
}

export type SkillsView = "mine" | "add";

export function RolesPage({ go, view = "mine", selected = null, onSelect }: SecondaryPageProps & { view?: SkillsView; selected?: string | null; onSelect: (id: string | null) => void }) {
  const [data, setData] = useState<RoleListResponse | null>(null);
  const [proposals, setProposals] = useState<RoleProposalView[]>([]);
  const [loadFailed, setLoadFailed] = useState<Failure | null>(null);
  const load = useCallback(async () => {
    setLoadFailed(null);
    try {
      const [roles, open] = await Promise.all([listRoles(), listProposals()]);
      setData(roles);
      setProposals(open);
    } catch (error) {
      setLoadFailed(failureOf(error, () => void load()));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const roles = useMemo(() => data?.roles ?? [], [data]);
  const role = roles.find((entry) => entry.id === selected) ?? null;

  if (loadFailed && !data) return <FailedLine {...loadFailed} />;
  if (!data) return <Loading />;
  if (role) {
    const saved = (next: RoleView) => setData((current) => current && { ...current, roles: current.roles.map((entry) => (entry.id === next.id ? next : entry)) });
    return <RoleDetail key={`${role.id}-${role.version}`} role={role} onBack={() => onSelect(null)} onSaved={saved} onConflict={() => void load()} />;
  }
  if (view === "add") return <Presets presets={data.presets} onAdded={() => void load()} />;
  return (
    <>
      {proposals.length ? <Proposals proposals={proposals} go={go} onDecided={() => void load()} /> : null}
      {roles.length ? (
        <CardGrid label="我的技能" testId="roles-list">
          {roles.map((entry) => (
            <Card key={entry.id} testId="role-card" icon={KIND_ICON[entry.kind]} name={entry.name} line={dutyLine(entry.dutiesMd) || null}
              source={entry.presetKey ? "预设" : "自己写的"} corner={<Added />} label={entry.name} onOpen={() => onSelect(entry.id)} />
          ))}
        </CardGrid>
      ) : <p className={p.empty}>还没有技能</p>}
    </>
  );
}

/* ---------------- 可添加：全部预设，按家族分组 ---------------- */

function Presets({ presets, onAdded }: { presets: RoleListResponse["presets"]; onAdded: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ key: string; failure: Failure } | null>(null);
  const families = (Object.keys(FAMILY_LABEL) as RoleFamily[])
    .map((family) => ({ family, presets: presets.filter((entry) => entry.family === family) }))
    .filter((group) => group.presets.length);
  const add = async (key: string) => {
    setBusy(key);
    setFailed(null);
    try { await addPreset(key); onAdded(); }
    catch (error) { setFailed({ key, failure: failureOf(error, () => void add(key)) }); }
    finally { setBusy(null); }
  };
  return (
    <>
      {families.map((group) => (
        <Section key={group.family} title={FAMILY_LABEL[group.family]} testId={`presets-${group.family}`}>
          <CardGrid label={FAMILY_LABEL[group.family]}>
            {group.presets.map((preset) => (
              <Card key={preset.presetKey} testId="preset-card" icon={KIND_ICON[preset.kind]} name={preset.name} line={dutyLine(preset.dutiesMd) || null} source="预设"
                corner={preset.added ? <Added />
                  : failed?.key === preset.presetKey ? <FailedLine inline {...failed.failure} />
                  : <AddButton label={`添加 ${preset.name}`} disabled={busy !== null} onPress={() => void add(preset.presetKey)} />} />
            ))}
          </CardGrid>
        </Section>
      ))}
    </>
  );
}

/* ---------------- 待你确认 ---------------- */

export function Proposals({ proposals, go, onDecided }: { proposals: RoleProposalView[]; go: (href: string) => void; onDecided: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; failure: Failure } | null>(null);
  const decide = async (proposal: RoleProposalView, decision: "accept" | "dismiss") => {
    setBusy(proposal.id);
    setFailed(null);
    try { await decideProposal(proposal.id, decision); onDecided(); }
    catch (error) { setFailed({ id: proposal.id, failure: failureOf(error, () => void decide(proposal, decision)) }); }
    finally { setBusy(null); }
  };
  return (
    <Section title={`待你确认 ${proposals.length}`} testId="role-proposals">
      <ul className={p.rows}>
        {proposals.map((proposal) => (
          <Row key={proposal.id} testId="role-proposal" name={proposal.role.name} tag={FIELD_LABEL[proposal.field]}
            sub={<a className={p.link} href={cardHref(proposal.card.id)} onClick={(event) => { event.preventDefault(); go(cardHref(proposal.card.id)); }}>{proposal.card.title}</a>}
            action={failed?.id === proposal.id ? <FailedLine inline {...failed.failure} /> : <>
              <HeroButton variant="ghost" size="sm" aria-expanded={open === proposal.id} onPress={() => setOpen(open === proposal.id ? null : proposal.id)}>{open === proposal.id ? "收起" : "看改动"}</HeroButton>
              <HeroButton variant="tertiary" size="sm" isDisabled={busy === proposal.id} onPress={() => void decide(proposal, "dismiss")}>不要</HeroButton>
              <HeroButton variant="secondary" size="sm" isDisabled={busy === proposal.id} onPress={() => void decide(proposal, "accept")}>采纳</HeroButton>
            </>}>
            <p className={p.note}>{proposal.why}</p>
            {open === proposal.id ? <Diff before={proposal.currentText} after={proposal.proposedText} /> : null}
          </Row>
        ))}
      </ul>
    </Section>
  );
}

/** 改前改后并排（手机上上下排）：删掉的行淡红底、新加的行淡绿底（按行比，不做逐字）。 */
export function Diff({ before, after }: { before: string; after: string }) {
  const left = before.split("\n");
  const right = after.split("\n");
  const set = (lines: string[]) => new Set(lines.map((line) => line.trim()));
  const inAfter = set(right);
  const inBefore = set(left);
  const side = (label: string, text: string, lines: string[], other: Set<string>, mark: "del" | "add") => (
    <div className={p.diffSide}>
      <span className={p.diffLabel}>{label}</span>
      <pre className={p.diffLines}>{text ? lines.map((line, index) => <span key={index} data-change={line.trim() && !other.has(line.trim()) ? mark : undefined}>{line}</span>) : <span className={p.diffLabel}>（空）</span>}</pre>
    </div>
  );
  return <div className={p.diff}>{side("改前", before, left, inAfter, "del")}{side("改后", after, right, inBefore, "add")}</div>;
}

/* ---------------- 一个技能的详情 ---------------- */

type Draft = Pick<RoleView, "name" | "dutiesMd" | "practiceMd" | "acceptanceMd" | "tools" | "modelTier">;
const draftOf = (role: RoleView): Draft => ({ name: role.name, dutiesMd: role.dutiesMd, practiceMd: role.practiceMd, acceptanceMd: role.acceptanceMd, tools: role.tools, modelTier: role.modelTier });

/** 只带改了的字段；没改返回 null。 */
export function changedFields(role: RoleView, draft: Draft): PatchRoleRequest | null {
  const body: PatchRoleRequest = { version: role.version };
  if (draft.name.trim() !== role.name) body.name = draft.name.trim();
  for (const field of FIELDS) if (draft[field] !== role[field]) body[field] = draft[field];
  if ([...draft.tools].sort().join() !== [...role.tools].sort().join()) body.tools = TOOLS.filter((tool) => draft.tools.includes(tool));
  if (draft.modelTier !== role.modelTier) body.modelTier = draft.modelTier;
  return Object.keys(body).length > 1 ? body : null;
}

function RoleDetail({ role, onBack, onSaved, onConflict }: { role: RoleView; onBack: () => void; onSaved: (role: RoleView) => void; onConflict: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(role));
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<Failure | null>(null);
  const [revisions, setRevisions] = useState<RoleRevisionView[]>([]);
  useEffect(() => { void listRevisions(role.id).then(setRevisions).catch(() => undefined); }, [role.id, role.version]);
  const body = changedFields(role, draft);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const save = async () => {
    if (!body || saving || !draft.name.trim()) return;
    setSaving(true);
    setFailed(null);
    try {
      const next = await patchRole(role.id, body);
      setEditing(null);
      onSaved(next);
    } catch (error) {
      if (error instanceof CloudError && error.status === 409) onConflict();
      else setFailed(failureOf(error, () => void save()));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={p.stack} data-testid="role-detail">
      <div className={p.back}><HeroButton variant="ghost" size="sm" onPress={onBack}><ChevronLeft {...ICON} aria-hidden />全部技能</HeroButton></div>
      <Section title="名称">
        <div className={p.field}>
          <input className={p.input} value={draft.name} maxLength={20} aria-label="技能名称" onChange={(event) => set("name", event.target.value)} />
          <span className={p.rowSub}>{roleLine(role)} · 第 {role.version} 版</span>
        </div>
      </Section>
      {FIELDS.map((field) => (
        <Section key={field} title={FIELD_LABEL[field]}
          aside={editing === field ? <HeroButton variant="ghost" size="sm" onPress={() => setEditing(null)}>预览</HeroButton> : null}>
          {editing === field ? (
            <textarea className={p.textarea} autoFocus value={draft[field]} maxLength={8000} aria-label={FIELD_LABEL[field]}
              rows={Math.min(18, Math.max(5, draft[field].split("\n").length + 1))} onChange={(event) => set(field, event.target.value)} />
          ) : (
            <div className={p.markdown} role="button" tabIndex={0} data-empty={!draft[field] || undefined} aria-label={`编辑${FIELD_LABEL[field]}`}
              onClick={(event) => { if (!(event.target as HTMLElement).closest("a")) setEditing(field); }}
              onKeyDown={(event) => { if (event.key === "Enter") setEditing(field); }}>
              {draft[field] ? <Markdown remarkPlugins={REMARK_PLUGINS}>{draft[field]}</Markdown> : "还没写"}
            </div>
          )}
        </Section>
      ))}
      <Section title="工具">
        <div className={p.choices}>
          {TOOLS.map((tool) => {
            const on = draft.tools.includes(tool);
            return <button key={tool} type="button" role="checkbox" aria-checked={on} className={p.choice} onClick={() => set("tools", on ? draft.tools.filter((entry) => entry !== tool) : [...draft.tools, tool])}>{TOOL_LABEL[tool]}</button>;
          })}
        </div>
      </Section>
      <Section title="模型档位">
        <div className={p.field}><SegmentedSwitch label="模型档位" segments={TIER_SEGMENTS} selected={draft.modelTier} onSelect={(tier: ModelTier) => set("modelTier", tier)} /></div>
      </Section>
      {revisions.length ? <Revisions revisions={revisions} /> : null}
      {body || failed ? (
        <div className={p.saveBar}>
          {failed ? <FailedLine inline {...failed} /> : null}
          <span className={p.grow} />
          <HeroButton variant="ghost" size="sm" onPress={() => { setDraft(draftOf(role)); setEditing(null); setFailed(null); }}>取消</HeroButton>
          <HeroButton variant="primary" size="sm" isDisabled={saving || !body || !draft.name.trim()} onPress={() => void save()}>保存</HeroButton>
        </div>
      ) : null}
    </div>
  );
}

function Revisions({ revisions }: { revisions: RoleRevisionView[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const now = Date.now();
  return (
    <Section title="修改记录" testId="role-revisions">
      <ul className={p.rows}>
        {revisions.map((revision) => (
          <li key={revision.version}>
            <button type="button" className={`${p.row} ${p.rowButton}`} aria-expanded={open === revision.version} onClick={() => setOpen(open === revision.version ? null : revision.version)}>
              <span className={p.rowText}>
                <span className={p.rowName}>
                  <span>第 {revision.version} 版 · {revision.changes.map((change) => CHANGE_LABEL[change.field]).join("、")}</span>
                  {revision.source === "proposal" ? <span className={p.chip}>采纳的修改</span> : null}
                </span>
                <span className={p.rowSub}>{revision.createdBy.name} · {relative(revision.createdAt, now)}</span>
              </span>
              <ChevronRight {...ICON} className={p.rowChevron} data-open={open === revision.version ? "" : undefined} aria-hidden />
            </button>
            {open === revision.version ? (
              <div className={p.under}>
                {revision.reason ? <p className={p.note}>{revision.reason}</p> : null}
                {revision.changes.map((change) => (
                  <div key={change.field} className={p.change}>
                    <span className={p.diffLabel}>{CHANGE_LABEL[change.field]}</span>
                    <Diff before={change.before} after={change.after} />
                  </div>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}
