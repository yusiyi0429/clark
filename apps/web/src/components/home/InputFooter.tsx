"use client";

/**
 * 输入框下面那一行（照 Claude Code 桌面版）：左边是上下文（首页「发给」、项目和子会话的文件夹），右边是模型和权限档。首页、伙伴台、项目对话、子会话四处一样高、一样对齐。
 */
import { useState, type ReactNode } from "react";
import { Dropdown } from "@heroui/react";
import { Check, ChevronDown, Folder } from "lucide-react";
import { FailedLine } from "@/components/work/DecisionBox";
import { LocalRunnerError } from "@/lib/local/runner";
import { PICK_OTHER } from "./FolderAsk";
import { ICON } from "./StateIcon";
import h from "@/styles/home.module.css";

/** 只看不能点的一段字（模型），悬停出完整说法。 */
export const FootText = ({ children, title, testId }: { children: ReactNode; title?: string; testId?: string }) => (
  <span className={h.footText} title={title} data-testid={testId}><span className={h.ellipsis}>{children}</span></span>
);

/** 新建文件夹那一项。 */
export const CREATE_FOLDER = "新建文件夹…";

/** 新建文件夹没成时就地写的一句：重名 409 写「已有同名文件夹」，名字不行照本机说的，别的「没建成」。 */
export function createFolderError(error: unknown): string {
  if (error instanceof LocalRunnerError && error.code === "conflict") return "已有同名文件夹";
  if (error instanceof LocalRunnerError && error.code === "validation") return error.message;
  return "没建成";
}

/**
 * 项目绑的文件夹（32 条）：点开列这台电脑上的文件夹（当前那个打勾）、「选择其他文件夹…」（本机弹选择框）、「新建文件夹…」（就地写名字，建在桌面）、「不绑」。
 * 选别的和新建都是本机一步绑到项目上，onPickOther / onCreate 不给就没有这两项。
 */
export function FolderMenu({ value, currentId, folders, onPick, onPickOther, onCreate }: {
  value: string | null;
  currentId?: string | null;
  folders: readonly { id: string; label: string }[];
  onPick: (folderId: string | null) => void;
  onPickOther?: () => Promise<unknown>;
  onCreate?: (name: string) => Promise<unknown>;
}) {
  const [naming, setNaming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async (name: string) => {
    if (!onCreate || busy) return;
    if (!name.trim()) { setNaming(false); setError(null); return; }
    setBusy(true);
    try { await onCreate(name.trim()); setNaming(false); setError(null); }
    catch (failure) { setError(createFolderError(failure)); }
    finally { setBusy(false); }
  };
  const act = (key: string) => {
    if (key === "other") void onPickOther?.();
    else if (key === "create") { setNaming(true); setError(null); }
    else onPick(key === "none" ? null : key);
  };
  if (naming) return (
    <span className={h.footText}>
      <Folder {...ICON} />
      <input className={`${h.projectName} ${h.folderName}`} autoFocus aria-label="文件夹名" placeholder="文件夹名" maxLength={120} disabled={busy} data-testid="folder-name"
        onChange={() => setError(null)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") { event.preventDefault(); void create(event.currentTarget.value); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setNaming(false); setError(null); }
        }}
        onBlur={(event) => { if (!error) void create(event.currentTarget.value); }} />
      {error ? <FailedLine inline note={error} onRetry={() => undefined} /> : null}
    </span>
  );
  const item = (id: string, label: string, checked = false) => (
    <Dropdown.Item key={id} id={id} textValue={label} className={h.menuItem}><span className={h.grow}>{label}</span>{checked ? <Check {...ICON} /> : null}</Dropdown.Item>
  );
  return (
    <Dropdown>
      <Dropdown.Trigger className={h.sendTo} aria-label={`文件夹：${value ?? "不绑"}`} data-testid="footer-folder">
        <Folder {...ICON} /><b>{value ?? "不绑"}</b><ChevronDown {...ICON} />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="top start" offset={8} className={h.pop}>
        <Dropdown.Menu aria-label="文件夹" className={h.menuList} onAction={(key) => act(String(key))}>
          {[...folders.map((folder) => item(folder.id, folder.label, folder.id === currentId)),
            ...(onPickOther ? [item("other", PICK_OTHER)] : []),
            ...(onCreate ? [item("create", CREATE_FOLDER)] : []),
            item("none", "不绑", !value)]}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** 子会话的上下文用了多少（17.2 第 42 条）：小圆环加百分比，样式同右栏用量那颗；到 80% 是警告色，悬停写「16.6 万 / 20 万」。 */
export function ContextRing({ percent, warn, tip }: { percent: number; warn: boolean; tip: string }) {
  const r = 5.5, round = 2 * Math.PI * r;
  return (
    <span className={h.footText} data-tone={warn ? "warning" : undefined} title={tip} role="img" aria-label={`上下文 ${percent}%，${tip}`} data-testid="context-usage">
      <svg className={h.usageRing} viewBox="0 0 14 14" aria-hidden>
        <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2" />
        <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${((round * percent) / 100).toFixed(2)} ${round.toFixed(2)}`} />
      </svg>
      <span className={h.num}>{percent}%</span>
    </span>
  );
}

/** 子会话在哪个文件夹里跑（只看：开着的会话换不了地方），悬停出完整路径。 */
export const FolderText = ({ name, title }: { name: string; title: string }) => (
  <span className={h.footText} title={title} data-testid="footer-folder"><Folder {...ICON} /><span className={h.ellipsis}>{name}</span></span>
);
