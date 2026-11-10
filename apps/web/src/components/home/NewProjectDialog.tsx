"use client";

/**
 * 新建项目的小弹窗和文件夹列表（设计 17.2 第 46 条）。
 * - 弹窗：项目名（必填，进来就聚焦，回车等于点「创建」）；文件夹（选填，这台电脑连着本机程序时才有这一块）；「取消」「创建」。
 *   没建成在弹窗里写「失败 · 重试」，弹窗不关。
 * - 文件夹列表（弹窗里和项目详情里是同一个）：每个一行——名字、淡色路径、行尾移除。有顺序，第一个是工作目录
 *   （子会话从这里开始、工作树也开在这里），有两个以上时第一行后面写淡色的「工作目录」。
 * - 「添加文件夹」由本机弹系统的选择框（POST /v1/folders/pick）；到上限（本机契约 LOCAL_PROJECT_FOLDER_LIMIT，老的本机程序是 1）就不出。
 */
import { useState } from "react";
import { Modal } from "@heroui/react";
import { X } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { FailedLine, failureOf, type Failure } from "@/components/work/DecisionBox";
import type { FolderRef } from "@/lib/home/projects";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { ICON } from "./StateIcon";
import h from "@/styles/home.module.css";

export function FolderList({ folders, onRemove }: { folders: readonly FolderRef[]; onRemove: (id: string) => void }) {
  if (!folders.length) return null;
  return (
    <ul className={h.folderList} data-testid="folder-list">
      {folders.map((folder, index) => (
        <li key={folder.id}>
          <span className={h.folderLabel}>{folder.label}</span>
          <span className={h.folderPath} title={folder.path}>{folder.path}</span>
          {index === 0 && folders.length > 1 ? <span className={h.menuFaint}>工作目录</span> : null}
          <button type="button" className={h.icon} aria-label={`移除 ${folder.label}`} title="移除" onClick={() => onRemove(folder.id)}><X {...ICON} /></button>
        </li>
      ))}
    </ul>
  );
}

/** 「添加文件夹」：本机弹系统的选择框，选了回这个文件夹（取消、没选上为 null）。 */
export function AddFolder({ onPicked }: { onPicked: (folder: FolderRef) => void }) {
  const local = useLocalRunner();
  const [busy, setBusy] = useState(false);
  const pick = () => {
    setBusy(true);
    void local.pickFolder().then((folder) => { if (folder) onPicked({ id: folder.id, path: folder.path, label: folder.label }); }).finally(() => setBusy(false));
  };
  return <HeroButton variant="tertiary" size="sm" isDisabled={busy} onPress={pick} data-testid="folder-add">添加文件夹</HeroButton>;
}

export function NewProjectDialog({ withFolders, limit, onCreate, onClose }: {
  /** 这台电脑连着本机程序（手机、没装的不出文件夹这一块）。 */
  withFolders: boolean;
  /** 一个项目最多绑几个文件夹。 */
  limit: number;
  /** 建项目、绑上选的文件夹、进项目页；没建成抛错。 */
  onCreate: (name: string, folderIds: string[]) => Promise<unknown>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [folders, setFolders] = useState<FolderRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Failure | null>(null);
  const trimmed = name.trim();
  const create = () => {
    if (!trimmed || busy) return;
    const run = () => {
      setFailed(null);
      setBusy(true);
      void onCreate(trimmed, folders.map((folder) => folder.id)).then(onClose, (error) => { setBusy(false); setFailed(failureOf(error, run)); });
    };
    run();
  };
  return (
    <Modal isOpen onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Backdrop className={h.dialogBackdrop} isDismissable>
        <Modal.Container size="sm">
          <Modal.Dialog className={h.dialog} aria-label="新建项目" data-testid="new-project">
            <h2 className={h.dialogTitle}>新建项目</h2>
            <input className={h.projectName} autoFocus aria-label="项目名" placeholder="项目名" maxLength={60} value={name} data-testid="project-name"
              onChange={(event) => setName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.key !== "Enter") return;
                event.preventDefault();
                create();
              }} />
            {withFolders ? (
              <section aria-label="文件夹" className={h.dialogBlock}>
                <p className={h.sectionTitle}>文件夹</p>
                <FolderList folders={folders} onRemove={(id) => setFolders((list) => list.filter((folder) => folder.id !== id))} />
                {folders.length < limit ? (
                  <div className={h.infoRow}><AddFolder onPicked={(folder) => setFolders((list) => (list.some((entry) => entry.id === folder.id) ? list : [...list, folder]))} /></div>
                ) : null}
              </section>
            ) : null}
            {failed ? <FailedLine {...failed} /> : null}
            <div className={h.dialogActions}>
              <HeroButton variant="tertiary" onPress={onClose}>取消</HeroButton>
              <HeroButton variant="primary" isDisabled={!trimmed || busy} onPress={create} data-testid="project-create">创建</HeroButton>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
