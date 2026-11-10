"use client";

/**
 * 输入框下面那一行（照 Claude Code 桌面版）：左边是上下文（首页「发给」、项目和子会话的文件夹），右边是模型和权限档。首页、伙伴台、项目对话、子会话四处一样高、一样对齐。
 */
import { useState, type ReactNode } from "react";
import { Dropdown, Header } from "@heroui/react";
import { Check, ChevronDown, Folder } from "lucide-react";
import { FailedLine } from "@/components/work/DecisionBox";
import { LocalRunnerError, type TLocalModelProfile } from "@/lib/local/runner";
import { HARNESS_NAME, effortText, profileModel, profileSource } from "@/lib/local/runModel";
import type { TLocalEffort } from "@warmap/contracts";
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

/** 思考程度那一组的键：自动是 effort:auto。 */
const EFFORT_KEY = "effort:";

/**
 * 子会话输入框下面的模型（32、36 条，天枢伙伴没有）：点开同派活单那个，按执行方分组、每行「模型 · 来源」，当前那个打勾；选了交给本机换（onPick）。
 * 模型能选思考程度时下面再一组「思考程度」：自动在前，只列这个模型支持的几档，选了 onEffort（null 是回到自动）。
 * 名字写 label（「Opus 5.5 · 高」；换了要等这一轮做完时是「当前 → 新」），悬停 title。
 */
export function SessionModelMenu({ label, title, models, value, onPick, efforts = [], effort = null, onEffort, disabled = [] }: {
  label: string; title?: string; models: readonly TLocalModelProfile[]; value: string | null; onPick: (id: string) => void;
  efforts?: readonly TLocalEffort[]; effort?: TLocalEffort | null; onEffort?: (effort: TLocalEffort | null) => void;
  /** 灰着不能选的模型（另一个执行方的，见 CROSS_AGENT_SWITCH）。 */
  disabled?: readonly string[];
}) {
  const choose = (key: string) => {
    if (!key.startsWith(EFFORT_KEY)) { if (key !== value) onPick(key); return; }
    const next = key.slice(EFFORT_KEY.length);
    const picked = next === "auto" ? null : next as TLocalEffort;
    if (picked !== effort) onEffort?.(picked);
  };
  const groups = (Object.keys(HARNESS_NAME) as (keyof typeof HARNESS_NAME)[]).map((agent) => ({ agent, list: models.filter((model) => model.agent === agent) })).filter((group) => group.list.length);
  return (
    <Dropdown>
      <Dropdown.Trigger className={h.sendTo} aria-label={`模型：${title ?? label}`} data-testid="session-model">
        <b title={title}>{label}</b><ChevronDown {...ICON} />
      </Dropdown.Trigger>
      <Dropdown.Popover placement="top end" offset={8} className={h.pop}>
        <Dropdown.Menu aria-label="模型" className={h.menuList} disabledKeys={disabled} onAction={(key) => choose(String(key))}>
          {groups.map((group) => (
            <Dropdown.Section key={group.agent} className={h.menuSection}>
              <Header className={h.menuHeader}>{HARNESS_NAME[group.agent]}</Header>
              {group.list.map((model) => (
                <Dropdown.Item key={model.id} id={model.id} textValue={`${profileModel(model)} ${profileSource(model)}`} className={h.menuItem} data-testid="session-model-option">
                  <span className={h.grow}>{profileModel(model)}<span className={h.menuFaint}> · {profileSource(model)}</span></span>{model.id === value ? <Check {...ICON} /> : null}
                </Dropdown.Item>
              ))}
            </Dropdown.Section>
          ))}
          {efforts.length && onEffort ? (
            <Dropdown.Section className={h.menuSection}>
              <Header className={h.menuHeader}>思考程度</Header>
              {[null, ...efforts].map((entry) => (
                <Dropdown.Item key={entry ?? "auto"} id={`${EFFORT_KEY}${entry ?? "auto"}`} textValue={effortText(entry)} className={h.menuItem} data-testid="session-effort-option">
                  <span className={h.grow}>{effortText(entry)}</span>{entry === effort ? <Check {...ICON} /> : null}
                </Dropdown.Item>
              ))}
            </Dropdown.Section>
          ) : null}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** 子会话在哪个文件夹里跑（只看：开着的会话换不了地方），悬停出完整路径。 */
export const FolderText = ({ name, title }: { name: string; title: string }) => (
  <span className={h.footText} title={title} data-testid="footer-folder"><Folder {...ICON} /><span className={h.ellipsis}>{name}</span></span>
);
