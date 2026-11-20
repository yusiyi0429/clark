"use client";

/**
 * 对外资料（个人菜单「对外资料」）：本人放给同事的伙伴读的，三块，没有说明文字。
 * - 说明：一个多行输入框，离开且内容变了就存。
 * - 文件：每份一行（文件名；大小 · 时间；删除），块标题右边「上传」，满 20 份禁用。
 * - 技能：本人每个技能一行开关，开着就是同事可用。
 * 查出像密钥的值时在出事的那一处下面逐条写第几行，输入框里的字留着、开关回到关；别的失败「失败 · 重试」；成功不弹提示。
 * MaterialsPage 管读、存、失败和密钥提示的状态，MaterialsView 只画。只管本人自己的东西。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { TSecretFinding } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { FailedLine, failureOf, type Failure } from "@/components/work/DecisionBox";
import { sizeText } from "@/lib/home/attachments";
import { MaterialSecrets, readMaterials, removeMaterial, saveNote, uploadMaterial, type Materials } from "@/lib/home/colleagueMaterials";
import { listRoles, setRoleSharing, type RoleView } from "@/lib/team/roles";
import type { SecondaryPageProps } from "./index";
import { Loading, Row, Section, SwitchRow, relative } from "./parts";
import p from "@/styles/home-pages.module.css";

export const MATERIAL_ACCEPT = ".md,.pdf,.docx";
const MAX_FILES = 20;

/** at：「note」说明、「file」文件、别的是技能 id。 */
type Findings = { at: "note" | "file" | string; items: TSecretFinding[] };

function FindingLines({ items, where }: { items: TSecretFinding[]; where: boolean }) {
  return (
    <div className={p.under}>
      {items.map((item, index) => (
        <p key={index} className={p.error}>{where ? `${item.where} ` : ""}第 {item.line} 行像密钥（{item.sample}）</p>
      ))}
    </div>
  );
}

export function MaterialsView({ materials, roles, note, busy, findings, failed, onNote, onSaveNote, onUpload, onRemove, onShare }: {
  materials: Materials;
  roles: RoleView[];
  note: string;
  busy: string | null;
  findings: Findings | null;
  failed: Failure | null;
  onNote: (text: string) => void;
  onSaveNote: () => void;
  onUpload: (file: File) => void;
  onRemove: (id: string) => void;
  onShare: (roleId: string, shared: boolean) => void;
}): ReactNode {
  const picker = useRef<HTMLInputElement>(null);
  const now = Date.now();
  const full = materials.files.length >= MAX_FILES;
  return (
    <>
      {failed ? <FailedLine reason={failed.reason} note={failed.note} onRetry={failed.onRetry} /> : null}
      <Section title="说明">
        <div className={p.field}>
          <textarea className={p.textarea} value={note} maxLength={20000} aria-label="说明" rows={5}
            onChange={(event) => onNote(event.target.value)} onBlur={onSaveNote} />
        </div>
        {findings?.at === "note" ? <FindingLines items={findings.items} where={false} /> : null}
      </Section>
      <Section title="文件" aside={(
        <>
          <input ref={picker} type="file" accept={MATERIAL_ACCEPT} hidden
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) onUpload(file); }} />
          <HeroButton variant="ghost" size="sm" isDisabled={full || busy === "file"} onPress={() => picker.current?.click()}>上传</HeroButton>
        </>
      )}>
        {materials.files.length ? (
          <ul className={p.rows}>
            {materials.files.map((file) => (
              <Row key={file.id} name={file.fileName} sub={[sizeText(file.size), relative(file.createdAt, now)].filter(Boolean).join(" · ")}
                action={<HeroButton variant="ghost" size="sm" isDisabled={busy === file.id} onPress={() => onRemove(file.id)}>删除</HeroButton>} />
            ))}
          </ul>
        ) : <p className={p.empty}>还没有文件</p>}
        {findings?.at === "file" ? <FindingLines items={findings.items} where /> : null}
      </Section>
      <Section title="技能">
        {roles.length ? (
          <ul className={p.rows}>
            {roles.map((role) => (
              <SwitchRow key={role.id} name={role.name} checked={role.shared === true} disabled={busy === role.id} onChange={(next) => onShare(role.id, next)} />
            ))}
          </ul>
        ) : <p className={p.empty}>还没有技能</p>}
        {findings && findings.at !== "note" && findings.at !== "file" && roles.some((role) => role.id === findings.at)
          ? <FindingLines items={findings.items} where /> : null}
      </Section>
    </>
  );
}

export function MaterialsPage(_props: SecondaryPageProps): ReactNode {
  const [materials, setMaterials] = useState<Materials | null>(null);
  const [roles, setRoles] = useState<RoleView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState<Failure | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [findings, setFindings] = useState<Findings | null>(null);
  const [failed, setFailed] = useState<Failure | null>(null);

  const load = useCallback(async () => {
    setLoadFailed(null);
    try {
      const [nextMaterials, list] = await Promise.all([readMaterials(), listRoles()]);
      setMaterials(nextMaterials);
      setNote(nextMaterials.note);
      setRoles(list.roles);
    } catch (error) { setLoadFailed(failureOf(error, () => void load())); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // 离开页面（后退、锁屏）时输入框不一定先失焦：卸载时说明和已存的不同就补存一次，结果没处可写，不提示。
  const latest = useRef<{ note: string; saved: string | null }>({ note: "", saved: null });
  useEffect(() => { latest.current = { note, saved: materials?.note ?? null }; });
  useEffect(() => () => {
    const { note: text, saved } = latest.current;
    if (saved !== null && text !== saved) void saveNote(text).catch(() => undefined);
  }, []);

  /** 一次动作：key 标在跑的那个，at 是出事时写在哪；像密钥的值写在原处，别的失败「失败 · 重试」。 */
  const run = async (key: string, at: string, action: () => Promise<void>, retry: () => void) => {
    setBusy(key);
    setFindings(null);
    setFailed(null);
    try { await action(); } catch (error) {
      if (error instanceof MaterialSecrets) setFindings({ at, items: error.findings });
      else setFailed(failureOf(error, retry));
    } finally { setBusy(null); }
  };
  const save = (text: string) => run("note", "note", async () => {
    const next = await saveNote(text);
    setMaterials(next);
    setNote((current) => (current === text ? next.note : current));
  }, () => void save(text));
  const upload = (file: File) => run("file", "file", async () => setMaterials(await uploadMaterial(file)), () => void upload(file));
  const remove = (id: string) => run(id, "file", async () => {
    await removeMaterial(id);
    setMaterials((current) => current && { ...current, files: current.files.filter((file) => file.id !== id) });
  }, () => void remove(id));
  const share = (roleId: string, shared: boolean) => run(roleId, roleId, async () => {
    const next = await setRoleSharing(roleId, shared);
    setRoles((current) => current?.map((role) => (role.id === roleId ? next : role)) ?? current);
  }, () => void share(roleId, shared));

  if (loadFailed) return <FailedLine reason={loadFailed.reason} note={loadFailed.note} onRetry={loadFailed.onRetry} />;
  if (!materials || !roles) return <Loading />;
  return (
    <MaterialsView materials={materials} roles={roles} note={note} busy={busy} findings={findings} failed={failed}
      onNote={setNote} onSaveNote={() => { if (note !== materials.note) void save(note); }}
      onUpload={(file) => void upload(file)} onRemove={(id) => void remove(id)} onShare={(roleId, shared) => void share(roleId, shared)} />
  );
}
