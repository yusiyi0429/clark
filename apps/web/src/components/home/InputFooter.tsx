"use client";

/**
 * 输入框下面那一行（照 Claude Code 桌面版）：左边是上下文（首页「发给」、项目和子会话的文件夹），右边是模型和权限档。首页、伙伴台、项目对话、子会话四处一样高、一样对齐。
 */
import type { ReactNode } from "react";
import { Dropdown } from "@heroui/react";
import { ChevronDown, Folder } from "lucide-react";
import { ICON } from "./StateIcon";
import h from "@/styles/home.module.css";

/** 只看不能点的一段字（模型），悬停出完整说法。 */
export const FootText = ({ children, title, testId }: { children: ReactNode; title?: string; testId?: string }) => (
  <span className={h.footText} title={title} data-testid={testId}><span className={h.ellipsis}>{children}</span></span>
);

/** 项目绑的文件夹：点开换成这台电脑上加过的别的文件夹，或不绑（同项目详情）。 */
export function FolderMenu({ value, folders, onPick }: { value: string | null; folders: readonly { id: string; label: string }[]; onPick: (folderId: string | null) => void }) {
  return (
    <Dropdown>
      <Dropdown.Trigger className={h.sendTo} aria-label={`文件夹：${value ?? "不绑"}`} data-testid="footer-folder">
        <Folder {...ICON} /><b>{value ?? "不绑"}</b><ChevronDown {...ICON} />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="top start" offset={8} className={h.pop}>
        <Dropdown.Menu aria-label="文件夹" className={h.menuList} onAction={(key) => onPick(key === "none" ? null : String(key))}>
          {[...folders.map((folder) => <Dropdown.Item key={folder.id} id={folder.id} textValue={folder.label} className={h.menuItem}>{folder.label}</Dropdown.Item>),
            <Dropdown.Item key="none" id="none" textValue="不绑" className={h.menuItem}>不绑</Dropdown.Item>]}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** 子会话在哪个文件夹里跑（只看：开着的会话换不了地方），悬停出完整路径。 */
export const FolderText = ({ name, title }: { name: string; title: string }) => (
  <span className={h.footText} title={title} data-testid="footer-folder"><Folder {...ICON} /><span className={h.ellipsis}>{name}</span></span>
);
