"use client";

/**
 * 点「开始」：卡先选技能（默认拆卡时配的；代码里仍叫 role，22 条只改给人看的字），再选模型（默认按技能的档位，没有时记住上一次）和文件夹，再开工（V2 设计第 11.2、19.6 节）。
 * 专题不选技能、不用选文件夹（本机给它一个专用目录）。模型按执行方分组（Claude Code、Codex，21 条），每个写「模型 · 来源」；文件夹只能经本机弹出的选择框添加。
 */
import { useEffect, useState } from "react";
import { FolderPlus } from "lucide-react";
import { MenuDialog } from "@/components/AccountMenu";
import { HeroButton } from "@/components/HeroButton";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { readLast, writeLast } from "@/lib/local/start";
import { HARNESS_NAME, effortText, profileModel, profileSource } from "@/lib/local/runModel";
import type { TLocalEffort } from "@warmap/contracts";
import type { TLocalFolder, TLocalModelProfile } from "@/lib/local/runner";
import { TIER_LABEL, listRoles, modelForTier, type CardRole, type RoleView } from "@/lib/team/roles";
import s from "@/styles/v2-local.module.css";

export function StartDialog({ title, needsFolder = true, role: given, onClose, onStart }: {
  title: string;
  needsFolder?: boolean;
  /** 卡：拆卡时配的岗位（没配为 null）；不传表示不选岗位（专题）。 */
  role?: CardRole | null;
  onClose: () => void;
  onStart: (model: TLocalModelProfile, folder: TLocalFolder | null, role: RoleView | null, effort: TLocalEffort | null) => Promise<void>;
}) {
  const local = useLocalRunner();
  const last = readLast();
  const withRole = given !== undefined;
  const [roles, setRoles] = useState<RoleView[]>([]);
  const [roleId, setRoleId] = useState<string | null>(given?.id ?? null);
  const [modelId, setModelId] = useState(() => local.models.find((model) => model.id === last.modelId)?.id ?? local.models.find((model) => model.isDefault)?.id ?? local.models[0]?.id ?? "");
  const [folderId, setFolderId] = useState(() => local.folders.find((folder) => folder.id === last.folderId)?.id ?? local.folders[0]?.id ?? "");
  // 思考程度（36 条）：先选模型，再在这个模型支持的几档里选，「自动」在前；换了模型不支持的回到自动。
  const [effortPick, setEffort] = useState<TLocalEffort | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const model = local.models.find((entry) => entry.id === modelId) ?? null;
  const folder = local.folders.find((entry) => entry.id === folderId) ?? null;
  const role = roles.find((entry) => entry.id === roleId) ?? null;
  const efforts = model?.efforts ?? [];
  const effort = effortPick && efforts.includes(effortPick) ? effortPick : null;
  const groups = (Object.keys(HARNESS_NAME) as (keyof typeof HARNESS_NAME)[])
    .map((agent) => ({ label: HARNESS_NAME[agent], models: local.models.filter((entry) => entry.agent === agent) }))
    .filter((group) => group.models.length);

  const pickRole = (next: RoleView) => {
    setRoleId(next.id);
    const byTier = modelForTier(local.models, next.modelTier);
    if (byTier) setModelId(byTier.id);
  };
  // 岗位只列干活的；默认拆卡时配的，没配用第一个。模型跟着岗位的档位走。
  useEffect(() => {
    if (!withRole) return;
    let alive = true;
    void listRoles().then((data) => {
      if (!alive) return;
      const workers = data.roles.filter((entry) => entry.kind === "worker");
      setRoles(workers);
      const first = workers.find((entry) => entry.id === given?.id) ?? workers[0];
      if (first) pickRole(first);
    }).catch(() => undefined);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [withRole, given?.id]);

  const start = async () => {
    if (!model || (needsFolder && !folder) || busy) return;
    setBusy(true);
    setError(null);
    writeLast({ modelId: model.id, ...(folder ? { folderId: folder.id } : {}) });
    try {
      await onStart(model, folder, role, effort);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "没开起来，请重试");
      setBusy(false);
    }
  };

  return (
    <MenuDialog title="开始" onClose={onClose}>
      <div className={s.start}>
        <p className={s.startTitle}>{title}</p>
        {withRole && roles.length ? (
          <div className={s.field} role="radiogroup" aria-label="技能">
            <span className={s.label}>技能</span>
            <div className={s.chipRow}>
              {roles.map((entry) => (
                <button key={entry.id} type="button" role="radio" aria-checked={entry.id === roleId} className={s.choice} onClick={() => pickRole(entry)}>{entry.name}</button>
              ))}
            </div>
          </div>
        ) : null}
        <div className={s.field} role="radiogroup" aria-label="模型">
          <span className={s.label}>模型{role ? <small className={s.faint}> · 档位：{TIER_LABEL[role.modelTier]}</small> : null}</span>
          {groups.map((group) => (
            <div key={group.label} className={s.chipRow}>
              <small>{group.label}</small>
              {group.models.map((entry) => (
                <button key={entry.id} type="button" role="radio" aria-checked={entry.id === modelId} className={s.choice} onClick={() => setModelId(entry.id)}>{profileModel(entry)}<span className={s.faint}> · {profileSource(entry)}</span></button>
              ))}
            </div>
          ))}
        </div>
        {efforts.length ? (
          <div className={s.field} role="radiogroup" aria-label="思考程度">
            <span className={s.label}>思考程度</span>
            <div className={s.chipRow}>
              {[null, ...efforts].map((entry) => (
                <button key={entry ?? "auto"} type="button" role="radio" aria-checked={entry === effort} className={s.choice} onClick={() => setEffort(entry)}>{effortText(entry)}</button>
              ))}
            </div>
          </div>
        ) : null}
        {needsFolder ? (
          <div className={s.field}>
            <span className={s.label}>文件夹</span>
            <div className={s.chipRow}>
              {local.folders.map((entry) => (
                <button key={entry.id} type="button" role="radio" aria-checked={entry.id === folderId} className={s.choice} title={entry.path} onClick={() => setFolderId(entry.id)}>{entry.label}</button>
              ))}
              <button type="button" className={s.add} onClick={() => void local.pickFolder().then((picked) => { if (picked) setFolderId(picked.id); })}><FolderPlus size={14} aria-hidden />添加</button>
            </div>
            {folder ? <small className={s.path}>{folder.path}</small> : null}
            {local.error ? <small className={s.error} role="alert">{local.error}</small> : null}
          </div>
        ) : null}
        {error ? <p className={s.error} role="alert">{error}</p> : null}
        <div className={s.actions}>
          <HeroButton variant="ghost" size="sm" onPress={onClose}>取消</HeroButton>
          <HeroButton variant="primary" size="sm" onPress={() => void start()} isDisabled={!model || (needsFolder && !folder) || busy}>{busy ? "正在开始…" : "开始"}</HeroButton>
        </div>
      </div>
    </MenuDialog>
  );
}
