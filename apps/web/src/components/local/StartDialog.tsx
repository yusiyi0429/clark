"use client";

/**
 * 点「开始」：先选模型和文件夹（记住上一次），再开工（V2 设计第 11.2 节）。专题不用选文件夹（本机给它一个专用目录）。
 * 模型分订阅和 TokenHub（网关）两组；文件夹只能经本机弹出的选择框添加。
 */
import { useState } from "react";
import { FolderPlus } from "lucide-react";
import { MenuDialog } from "@/components/AccountMenu";
import { HeroButton } from "@/components/HeroButton";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { readLast, writeLast } from "@/lib/local/start";
import type { TLocalFolder, TLocalModelProfile } from "@/lib/local/runner";
import s from "@/styles/v2-local.module.css";

export function StartDialog({ title, needsFolder = true, onClose, onStart }: {
  title: string;
  needsFolder?: boolean;
  onClose: () => void;
  onStart: (model: TLocalModelProfile, folder: TLocalFolder | null) => Promise<void>;
}) {
  const local = useLocalRunner();
  const last = readLast();
  const [modelId, setModelId] = useState(() => local.models.find((model) => model.id === last.modelId)?.id ?? local.models.find((model) => model.isDefault)?.id ?? local.models[0]?.id ?? "");
  const [folderId, setFolderId] = useState(() => local.folders.find((folder) => folder.id === last.folderId)?.id ?? local.folders[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const model = local.models.find((entry) => entry.id === modelId) ?? null;
  const folder = local.folders.find((entry) => entry.id === folderId) ?? null;
  const groups = [
    { label: "订阅", models: local.models.filter((entry) => entry.source === "subscription") },
    { label: "TokenHub", models: local.models.filter((entry) => entry.source === "gateway") },
  ].filter((group) => group.models.length);

  const start = async () => {
    if (!model || (needsFolder && !folder) || busy) return;
    setBusy(true);
    setError(null);
    writeLast({ modelId: model.id, ...(folder ? { folderId: folder.id } : {}) });
    try {
      await onStart(model, folder);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "没开起来，请重试");
      setBusy(false);
    }
  };

  return (
    <MenuDialog title="开始" onClose={onClose}>
      <div className={s.start}>
        <p className={s.startTitle}>{title}</p>
        <div className={s.field} role="radiogroup" aria-label="模型">
          <span className={s.label}>模型</span>
          {groups.map((group) => (
            <div key={group.label} className={s.chipRow}>
              <small>{group.label}</small>
              {group.models.map((entry) => (
                <button key={entry.id} type="button" role="radio" aria-checked={entry.id === modelId} className={s.choice} onClick={() => setModelId(entry.id)}>{entry.label}</button>
              ))}
            </div>
          ))}
        </div>
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
