"use client";

/**
 * 岗位页（/me/team，V2 设计第 19.6 节）：左边本人的岗位，右边一个岗位的职责、做法、验收口径（Markdown）、工具和模型档位，保存即生效，
 * 下面是修改记录；顶上是待你确认的岗位修改（采纳、不要，能看改前改后）；「从岗位包添加」加一份预设的副本。
 * 手机上先列表，点进去是详情。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Markdown from "react-markdown";
import { ChevronLeft, Plus } from "lucide-react";
import { MenuDialog } from "@/components/AccountMenu";
import { HeroButton } from "@/components/HeroButton";
import { useHandheld } from "@/components/ui/useHandheld";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { CloudError } from "@/lib/board/cloud";
import { REMARK_PLUGINS } from "@/lib/markdown";
import { showWorkspaceToast } from "@/lib/toast";
import {
  FAMILY_LABEL, FIELDS, FIELD_KEY, FIELD_LABEL, KIND_LABEL, TIERS, TIER_LABEL, TOOLS, TOOL_LABEL,
  addPreset, decideProposal, listProposals, listRevisions, listRoles, patchRole, rolesStubbed, seedStubProposal,
  type PatchRoleRequest, type RoleChange, type RoleFamily, type RoleListResponse, type RoleProposalView, type RoleRevisionView, type RoleView,
} from "@/lib/team/roles";
import s from "@/styles/v2-team.module.css";

const failText = (error: unknown) => (error instanceof Error ? error.message : "没成功，请重试");
const roleLine = (role: Pick<RoleView, "family" | "kind">) => `${FAMILY_LABEL[role.family]} · ${KIND_LABEL[role.kind]}`;
const CHANGE_LABEL: Record<RoleChange["field"], string> = { ...FIELD_LABEL, name: "名称", tools: "工具", model_tier: "模型档位" };
const when = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function TeamPage() {
  const handheld = useHandheld();
  const local = useLocalRunner();
  const [data, setData] = useState<RoleListResponse | null>(null);
  const [proposals, setProposals] = useState<RoleProposalView[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(async () => {
    try {
      const list = await listRoles();
      if (rolesStubbed() && local.runner.kind === "mock") seedStubProposal();
      setData(list);
      setProposals(await listProposals());
    } catch (error) {
      showWorkspaceToast({ text: failText(error) });
    }
  }, [local.runner.kind]);
  useEffect(() => { void load(); }, [load]);
  const roles = useMemo(() => data?.roles ?? [], [data]);
  // 宽屏上默认打开第一个；手机上先看列表。
  useEffect(() => {
    if (!handheld && !selected && roles[0]) setSelected(roles[0].id);
  }, [handheld, selected, roles]);
  const role = roles.find((entry) => entry.id === selected) ?? null;

  const saved = (next: RoleView) => setData((current) => current && { ...current, roles: current.roles.map((entry) => (entry.id === next.id ? next : entry)) });
  const added = (next: RoleView) => {
    setAdding(false);
    setSelected(next.id);
    showWorkspaceToast({ text: `已添加「${next.name}」` });
    void load();
  };

  const list = roles.length ? (
    <nav className={s.list} aria-label="岗位">
      {roles.map((entry) => (
        <button key={entry.id} type="button" className={s.item} aria-current={entry.id === selected} onClick={() => setSelected(entry.id)}>
          <b>{entry.name}</b>
          <small>{roleLine(entry)}</small>
        </button>
      ))}
    </nav>
  ) : data ? (
    <div className={s.empty}>
      <span className={s.faint}>还没有岗位</span>
      <HeroButton variant="primary" size="sm" onPress={() => setAdding(true)}>从岗位包添加</HeroButton>
    </div>
  ) : null;

  return (
    <div className={s.page} data-testid="team-page">
      <div className={s.wrap}>
        <div className={s.top}>
          <h1>岗位</h1>
          <span className={s.grow} />
          {roles.length ? <HeroButton variant="secondary" size="sm" onPress={() => setAdding(true)}><Plus size={14} aria-hidden />从岗位包添加</HeroButton> : null}
        </div>
        {proposals.length ? <Proposals proposals={proposals} onDecided={() => void load()} /> : null}
        {handheld ? (role ? <RoleDetail key={`${role.id}-${role.version}`} role={role} onBack={() => setSelected(null)} onSaved={saved} onConflict={() => void load()} /> : list) : (
          <div className={s.body}>
            {list}
            {role ? <RoleDetail key={`${role.id}-${role.version}`} role={role} onSaved={saved} onConflict={() => void load()} /> : null}
          </div>
        )}
      </div>
      {adding && data ? <PresetDialog presets={data.presets} onClose={() => setAdding(false)} onAdded={added} /> : null}
    </div>
  );
}

/** 待你确认的岗位修改：哪个岗位、改哪一段、为什么；能展开看改前改后；采纳写回（版本 +1），不要就丢掉。 */
export function Proposals({ proposals, onDecided }: { proposals: RoleProposalView[]; onDecided: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (proposal: RoleProposalView, decision: "accept" | "dismiss") => {
    setBusy(proposal.id);
    try {
      await decideProposal(proposal.id, decision);
      showWorkspaceToast({ text: decision === "accept" ? `已写进「${proposal.roleName}」` : "已丢掉" });
      onDecided();
    } catch (error) {
      showWorkspaceToast({ text: failText(error) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className={s.proposals} aria-label="待你确认">
      <p className={s.lab}>待你确认<span className={s.count}>{proposals.length}</span></p>
      {proposals.map((proposal) => (
        <div key={proposal.id} className={s.proposal} data-testid="role-proposal">
          <div className={s.proposalHead}>
            <b>{proposal.roleName}</b>
            <span className={s.badge}>{FIELD_LABEL[proposal.field]}</span>
            {proposal.card ? <Link href={`/me/cards/${encodeURIComponent(proposal.card.id)}`} className={s.link}>{proposal.card.title}</Link> : null}
            <span className={s.grow} />
            <button type="button" className={s.textBtn} aria-expanded={open === proposal.id} onClick={() => setOpen(open === proposal.id ? null : proposal.id)}>{open === proposal.id ? "收起" : "看改动"}</button>
            <HeroButton variant="ghost" size="sm" isDisabled={busy === proposal.id} onPress={() => void decide(proposal, "dismiss")}>不要</HeroButton>
            <HeroButton variant="primary" size="sm" isDisabled={busy === proposal.id} onPress={() => void decide(proposal, "accept")}>采纳</HeroButton>
          </div>
          <p className={s.why}>{proposal.why}</p>
          {open === proposal.id ? <Diff before={proposal.currentText} after={proposal.proposedText} /> : null}
        </div>
      ))}
    </section>
  );
}

/** 改前改后并排：删掉的行标红、新加的行标绿（按行比，不做逐字）。 */
export function Diff({ before, after }: { before: string; after: string }) {
  const left = before.split("\n");
  const right = after.split("\n");
  const kept = (lines: string[]) => new Set(lines.map((line) => line.trim()));
  const inAfter = kept(right);
  const inBefore = kept(left);
  return (
    <div className={s.diff}>
      <div className={s.side}>
        <span className={s.faint}>改前</span>
        <pre className={s.lines}>{before ? left.map((line, index) => <span key={index} data-change={line.trim() && !inAfter.has(line.trim()) ? "del" : undefined}>{line}</span>) : <span className={s.faint}>（空）</span>}</pre>
      </div>
      <div className={s.side}>
        <span className={s.faint}>改后</span>
        <pre className={s.lines}>{after ? right.map((line, index) => <span key={index} data-change={line.trim() && !inBefore.has(line.trim()) ? "add" : undefined}>{line}</span>) : <span className={s.faint}>（空）</span>}</pre>
      </div>
    </div>
  );
}

type Draft = Pick<RoleView, "name" | "dutiesMd" | "practiceMd" | "acceptanceMd" | "tools" | "modelTier">;
const draftOf = (role: RoleView): Draft => ({ name: role.name, dutiesMd: role.dutiesMd, practiceMd: role.practiceMd, acceptanceMd: role.acceptanceMd, tools: role.tools, modelTier: role.modelTier });

/** 只带改了的字段；没改返回 null。 */
export function changedFields(role: RoleView, draft: Draft): PatchRoleRequest | null {
  const body: PatchRoleRequest = { version: role.version };
  if (draft.name.trim() !== role.name) body.name = draft.name.trim();
  for (const field of FIELDS) if (draft[FIELD_KEY[field]] !== role[FIELD_KEY[field]]) body[FIELD_KEY[field]] = draft[FIELD_KEY[field]];
  if ([...draft.tools].sort().join() !== [...role.tools].sort().join()) body.tools = TOOLS.filter((tool) => draft.tools.includes(tool));
  if (draft.modelTier !== role.modelTier) body.modelTier = draft.modelTier;
  return Object.keys(body).length > 1 ? body : null;
}

function RoleDetail({ role, onBack, onSaved, onConflict }: { role: RoleView; onBack?: () => void; onSaved: (role: RoleView) => void; onConflict: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(role));
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [revisions, setRevisions] = useState<RoleRevisionView[]>([]);
  const loadRevisions = useCallback(() => { void listRevisions(role.id).then(setRevisions).catch(() => undefined); }, [role.id]);
  useEffect(loadRevisions, [loadRevisions, role.version]);
  const body = changedFields(role, draft);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const save = async () => {
    if (!body || saving || !draft.name.trim()) return;
    setSaving(true);
    try {
      const next = await patchRole(role.id, body);
      setEditing(null);
      onSaved(next);
      showWorkspaceToast({ text: "已保存" });
    } catch (error) {
      showWorkspaceToast({ text: failText(error) });
      if (error instanceof CloudError && error.status === 409) onConflict();
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className={s.detail} data-testid="role-detail">
      {onBack ? <button type="button" className={s.back} onClick={onBack}><ChevronLeft size={14} aria-hidden />岗位</button> : null}
      <div className={s.detailHead}>
        <input className={s.name} value={draft.name} maxLength={20} aria-label="岗位名称" onChange={(event) => set("name", event.target.value)} />
        <span className={s.faint}>{roleLine(role)} · 第 {role.version} 版</span>
      </div>
      {FIELDS.map((field) => {
        const key = FIELD_KEY[field];
        return (
          <section key={field} className={s.section} aria-label={FIELD_LABEL[field]}>
            <div className={s.sectionHead}>
              <p className={s.lab}>{FIELD_LABEL[field]}</p>
              <span className={s.grow} />
              {editing === field ? <button type="button" className={s.textBtn} onClick={() => setEditing(null)}>预览</button> : null}
            </div>
            {editing === field ? (
              <textarea className={s.editor} autoFocus value={draft[key]} maxLength={8000} aria-label={FIELD_LABEL[field]} rows={Math.min(18, Math.max(5, draft[key].split("\n").length + 1))}
                onChange={(event) => set(key, event.target.value)} />
            ) : (
              <div className={s.md} role="button" tabIndex={0} data-empty={!draft[key] || undefined} aria-label={`编辑${FIELD_LABEL[field]}`}
                onClick={(event) => { if (!(event.target as HTMLElement).closest("a")) setEditing(field); }}
                onKeyDown={(event) => { if (event.key === "Enter") setEditing(field); }}>
                {draft[key] ? <Markdown remarkPlugins={REMARK_PLUGINS}>{draft[key]}</Markdown> : "还没写"}
              </div>
            )}
          </section>
        );
      })}
      <section className={s.section} aria-label="工具">
        <p className={s.lab}>工具</p>
        <div className={s.chips}>
          {TOOLS.map((tool) => {
            const on = draft.tools.includes(tool);
            return <button key={tool} type="button" role="checkbox" aria-checked={on} className={s.choice} onClick={() => set("tools", on ? draft.tools.filter((entry) => entry !== tool) : [...draft.tools, tool])}>{TOOL_LABEL[tool]}</button>;
          })}
        </div>
      </section>
      <section className={s.section} aria-label="模型档位">
        <p className={s.lab}>模型档位</p>
        <div className={s.chips} role="radiogroup" aria-label="模型档位">
          {TIERS.map((tier) => <button key={tier} type="button" role="radio" aria-checked={draft.modelTier === tier} className={s.choice} onClick={() => set("modelTier", tier)}>{TIER_LABEL[tier]}</button>)}
        </div>
      </section>
      {revisions.length ? <Revisions revisions={revisions} /> : null}
      {body ? (
        <div className={s.saveBar}>
          <HeroButton variant="ghost" size="sm" onPress={() => { setDraft(draftOf(role)); setEditing(null); }}>取消</HeroButton>
          <HeroButton variant="primary" size="sm" isDisabled={saving || !draft.name.trim()} onPress={() => void save()}>{saving ? "正在保存…" : "保存"}</HeroButton>
        </div>
      ) : null}
    </article>
  );
}

function Revisions({ revisions }: { revisions: RoleRevisionView[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section className={s.revisions} aria-label="修改记录">
      <p className={s.lab}>修改记录</p>
      {revisions.map((revision) => (
        <div key={revision.version} className={s.revision}>
          <button type="button" className={s.revisionLine} aria-expanded={open === revision.version} onClick={() => setOpen(open === revision.version ? null : revision.version)}>
            <span className={s.ver}>第 {revision.version} 版</span>
            <span>{revision.changes.map((change) => CHANGE_LABEL[change.field]).join("、")}</span>
            {revision.source === "proposal" ? <span className={s.badge}>采纳的修改</span> : null}
            {revision.card ? <span className={s.faint}>因为「{revision.card.title}」</span> : null}
            <span className={s.grow} />
            <span className={s.faint}>{revision.by.name} · {when(revision.at)}</span>
          </button>
          {open === revision.version ? (
            <div className={s.changes}>
              {revision.reason ? <p className={s.why}>{revision.reason}</p> : null}
              {revision.changes.map((change) => (
                <div key={change.field} className={s.side}>
                  <span className={s.faint}>{CHANGE_LABEL[change.field]}</span>
                  <Diff before={change.before} after={change.after} />
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function PresetDialog({ presets, onClose, onAdded }: { presets: RoleListResponse["presets"]; onClose: () => void; onAdded: (role: RoleView) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const families = (Object.keys(FAMILY_LABEL) as RoleFamily[]).map((family) => ({ family, presets: presets.filter((entry) => entry.family === family) })).filter((group) => group.presets.length);
  const add = async (key: string) => {
    setBusy(key);
    try { onAdded(await addPreset(key)); }
    catch (error) { showWorkspaceToast({ text: failText(error) }); setBusy(null); }
  };
  return (
    <MenuDialog title="从岗位包添加" onClose={onClose}>
      <div className={s.presets}>
        {families.map((group) => (
          <div key={group.family} className={s.family}>
            <p className={s.lab}>{FAMILY_LABEL[group.family]}</p>
            {group.presets.map((preset) => (
              <div key={preset.key} className={s.presetLine}>
                <b>{preset.name}</b>
                <span className={s.badge}>{KIND_LABEL[preset.kind]}</span>
                <span className={s.grow} />
                {preset.added ? <span className={s.faint}>已添加</span>
                  : <HeroButton variant="secondary" size="sm" isDisabled={busy !== null} onPress={() => void add(preset.key)}>添加</HeroButton>}
              </div>
            ))}
          </div>
        ))}
      </div>
    </MenuDialog>
  );
}
