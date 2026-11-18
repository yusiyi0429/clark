"use client";

/**
 * 输入框下面那一行（照 Claude Code 桌面版）：左边是上下文（首页「发给」、项目和子会话的文件夹），右边是模型和权限档。首页、伙伴台、项目对话、子会话四处一样高、一样对齐。
 */
import { useContext, useState, type ReactNode } from "react";
import { Dropdown } from "@heroui/react";
import { Check, ChevronDown, Folder } from "lucide-react";
import { FailedLine } from "@/components/work/DecisionBox";
import { LocalContext, type LocalRunnerState } from "@/lib/local/LocalRunnerProvider";
import { LocalRunnerError } from "@/lib/local/runner";
import { showWorkspaceToast } from "@/lib/toast";
import { PICK_OTHER } from "./FolderAsk";
import { useHoverTip } from "./NameTip";
import { ICON } from "./StateIcon";
import h from "@/styles/home.module.css";

/** 只看不能点的一段字（模型），悬停出完整说法。 */
export const FootText = ({ children, title, testId }: { children: ReactNode; title?: string; testId?: string }) => (
  <span className={h.footText} title={title} data-testid={testId}><span className={h.wrap}>{children}</span></span>
);

/** 新建文件夹那一项。 */
export const CREATE_FOLDER = "新建文件夹";

/** 新建文件夹没成时就地写的一句：重名 409 写「已有同名文件夹」，名字不行照本机说的，别的「没建成」。 */
export function createFolderError(error: unknown): string {
  if (error instanceof LocalRunnerError && error.code === "conflict") return "已有同名文件夹";
  if (error instanceof LocalRunnerError && error.code === "validation") return error.message;
  return "没建成";
}

/**
 * 项目在这台电脑上还没绑文件夹时选一个（32 条）：按钮写「此电脑」；点开列这台电脑上的文件夹、「选择其他文件夹…」（本机弹选择框）、「新建文件夹…」（就地写名字，建在桌面）、「此电脑」（打勾）。
 * 选别的和新建都是本机一步绑到项目上，onPickOther / onCreate 不给就没有这两项。
 * 照 Claude Code「开始以后就不在输入框下面改」：只在这台电脑上项目还没绑文件夹时给；绑了以后调用方用 FolderText（不能换），换在项目详情的「文件夹」一节。
 */
export function FolderMenu({ folders, onPick, onPickOther, onCreate }: {
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
      <Dropdown.Trigger className={h.sendTo} aria-label="文件夹：此电脑" data-testid="footer-folder">
        <Folder {...ICON} /><b>此电脑</b><ChevronDown {...ICON} />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="top start" offset={8} className={h.pop}>
        <Dropdown.Menu aria-label="文件夹" className={h.menuList} onAction={(key) => act(String(key))}>
          {[...folders.map((folder) => item(folder.id, folder.label)),
            ...(onPickOther ? [item("other", PICK_OTHER)] : []),
            ...(onCreate ? [item("create", CREATE_FOLDER)] : []),
            item("none", "此电脑", true)]}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** 小圆环：画到 percent。 */
function Ring({ percent }: { percent: number }) {
  const r = 5.5, round = 2 * Math.PI * r;
  return (
    <svg className={h.usageRing} viewBox="0 0 14 14" aria-hidden>
      <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2" />
      <circle cx="7" cy="7" r={r} fill="none" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${((round * percent) / 100).toFixed(2)} ${round.toFixed(2)}`} />
    </svg>
  );
}

/** 子会话的上下文用了多少（17.2 第 42 条）：小圆环加百分比，样式同右栏用量那颗；到 80% 是警告色，悬停写「16.6 万 / 20 万」（站内统一的提示，不用原生 title）。 */
export function ContextRing({ percent, warn, tip }: { percent: number; warn: boolean; tip: string }) {
  const hover = useHoverTip(tip, "top");
  return (
    <>
    <span ref={hover.ref} className={h.footText} data-tone={warn ? "warning" : undefined} role="img" aria-label={`上下文 ${percent}%，${tip}`} data-testid="context-usage" {...hover.props}>
      <Ring percent={percent} />
      <span className={h.num}>{percent}%</span>
    </span>
    {hover.tip}
    </>
  );
}

/** 来源用到八成以上（第 73 条）：模型胶囊旁边一颗琥珀色的小圆环，画法同上下文那颗，不带字；悬停只写用了多少。 */
export function QuotaRing({ used }: { used: number }) {
  const hover = useHoverTip(`${used}%`, "top");
  return (
    <>
    <span ref={hover.ref} className={h.footText} data-tone="warning" role="img" aria-label={`用量 ${used}%`} data-testid="quota-ring" {...hover.props}>
      <Ring percent={used} />
    </span>
    {hover.tip}
    </>
  );
}

/** 知道路径时文件夹菜单里有哪几项（照 Claude Code 桌面版，本人 11/16 定）：这台电脑上登记过的才能「在资源管理器中显示」（按系统叫法），复制路径总有，项目对话才能添加。 */
export function folderActions({ reveal, add, userAgent }: { reveal: boolean; add: boolean; userAgent: string }): { id: "reveal" | "copy" | "add"; label: string }[] {
  const show = /Mac/i.test(userAgent) ? "在访达中显示" : /Win/i.test(userAgent) ? "在资源管理器中显示" : "在文件管理器中显示";
  return [...(reveal ? [{ id: "reveal" as const, label: show }] : []), { id: "copy", label: "复制路径" }, ...(add ? [{ id: "add" as const, label: "添加文件夹" }] : [])];
}

/** 这个路径是不是这台电脑的本机程序登记过的文件夹（连着本机时）。 */
export function registeredFolder(local: LocalRunnerState | null, path?: string) {
  return (path && local?.phase === "ready" && local.folders.find((folder) => folder.path === path)) || null;
}

/**
 * 在哪个文件夹里跑：子会话开着换不了地方；项目对话、派活单是项目在这台电脑上已经绑了（写工作目录那个）。悬停出完整说法（站内统一的提示）。
 * 知道路径（path）时点开一个菜单：在资源管理器中显示、复制路径、添加文件夹…（onAdd，只项目对话给）；没成就地写一句。
 */
export function FolderText({ name, title, path, onAdd }: { name: string; title: string; path?: string; onAdd?: () => Promise<unknown> }) {
  const hover = useHoverTip(title, "top");
  const local = useContext(LocalContext);
  const [failed, setFailed] = useState<string | null>(null);
  if (!path) return (
    <>
      <span ref={hover.ref} className={h.footText} data-testid="footer-folder" {...hover.props}><Folder {...ICON} /><span className={h.wrap}>{name}</span></span>
      {hover.tip}
    </>
  );
  const known = registeredFolder(local, path);
  const actions = folderActions({ reveal: !!known, add: !!onAdd, userAgent: typeof navigator === "undefined" ? "" : navigator.userAgent });
  const act = (key: string) => {
    setFailed(null);
    const fail = (note: string) => () => setFailed(note);
    if (key === "reveal" && known) void local?.runner.openFolder(known.id).catch(fail("没打开"));
    if (key === "copy") void navigator.clipboard.writeText(path).then(() => showWorkspaceToast({ text: "已复制" }), fail("没复制上"));
    if (key === "add") void onAdd?.().catch(fail("没加上"));
  };
  return (
    <>
      <span ref={hover.ref} {...hover.props}>
        <Dropdown>
          <Dropdown.Trigger className={h.sendTo} aria-label={`文件夹：${name}`} data-testid="footer-folder">
            <Folder {...ICON} /><b>{name}</b><ChevronDown {...ICON} />
          </Dropdown.Trigger>
          <Dropdown.Popover placement="top start" offset={8} className={h.pop}>
            <Dropdown.Menu aria-label="文件夹" className={h.menuList} onAction={(key) => act(String(key))}>
              {actions.map((entry) => <Dropdown.Item key={entry.id} id={entry.id} textValue={entry.label} className={h.menuItem}>{entry.label}</Dropdown.Item>)}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </span>
      {hover.tip}
      {failed ? <FailedLine inline note={failed} onRetry={() => undefined} /> : null}
    </>
  );
}
