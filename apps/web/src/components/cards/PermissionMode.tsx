"use client";

/**
 * 子会话输入框下面左侧的权限模式（设计 17.2 第 11 条，照 Claude Code 的 Mode 菜单）：写当前档，点开是菜单，每档一行名字加一行短副标题，
 * 「自动」标「推荐」，当前那档行尾打勾，数字键 1–5 直接选。弹层和「发给」同一种（Dropdown）。改的是这个子会话；计划批了转成「自动」时跟着变。
 * 这里指挥不了本机（手机上、在别的电脑上跑）时只写当前档，点不开。
 * 项目主管线下面的同一个选择（useProjectMode）改的是这个项目以后新开子会话的默认档（Project.permissionMode，PATCH 项目）；手机上点开是底部抽屉。
 */
import { createContext, useEffect, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Dropdown } from "@heroui/react";
import type { TLocalPermissionMode } from "@warmap/contracts";
import { AGENT_PERMISSION_MODES, PERMISSION_MODE_TEXT, RECOMMENDED_MODE } from "@/lib/local/permissionModes";
import type { LocalRunner, TLocalSessionSummary } from "@/lib/local/runner";
import type { SessionView } from "@/lib/local/sessionView";
import { showWorkspaceToast } from "@/lib/toast";
import { readProject, updateProject } from "@/lib/board/cloud";
import { ICON } from "@/components/home/StateIcon";
import h from "@/styles/home.module.css";

/** 数字键选第几档（1 起）；不是数字或超出范围为 null。 */
export function modeByKey(key: string, modes: readonly TLocalPermissionMode[]): TLocalPermissionMode | null {
  return /^[1-9]$/.test(key) ? modes[Number(key) - 1] ?? null : null;
}

function ModeText({ mode }: { mode: TLocalPermissionMode }) {
  const text = PERMISSION_MODE_TEXT[mode];
  return (
    <span className={h.modeText}>
      <span>{text.name}{mode === RECOMMENDED_MODE ? <span className={h.modeRec}>（推荐）</span> : null}</span>
      <small>{text.hint}</small>
    </span>
  );
}

export function PermissionModeMenu({ modes, value, disabled = false, sheet = false, onChange }: {
  modes: readonly TLocalPermissionMode[];
  value: TLocalPermissionMode;
  disabled?: boolean;
  /** 手机上：点开是底部抽屉。 */
  sheet?: boolean;
  onChange: (mode: TLocalPermissionMode) => void;
}) {
  if (sheet) return <PermissionModeSheet modes={modes} value={value} onChange={onChange} />;
  return <PermissionModeDropdown modes={modes} value={value} disabled={disabled} onChange={onChange} />;
}

function PermissionModeDropdown({ modes, value, disabled, onChange }: { modes: readonly TLocalPermissionMode[]; value: TLocalPermissionMode; disabled: boolean; onChange: (mode: TLocalPermissionMode) => void }) {
  const [open, setOpen] = useState(false);
  const pick = (mode: TLocalPermissionMode) => { setOpen(false); if (mode !== value) onChange(mode); };
  // 菜单开着时数字键直接选那一档。
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      const mode = modeByKey(event.key, modes);
      if (!mode || event.metaKey || event.ctrlKey || event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      if (mode !== value) onChange(mode);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, modes, value, onChange]);
  const current = PERMISSION_MODE_TEXT[value];
  return (
    <Dropdown isOpen={open} onOpenChange={setOpen}>
      <Dropdown.Trigger className={h.sendTo} isDisabled={disabled} aria-label={`权限模式：${current.name}`} data-testid="permission-mode">
        <b>{current.name}</b>{disabled ? null : <ChevronDown {...ICON} />}
      </Dropdown.Trigger>
      <Dropdown.Popover placement="top start" offset={8} className={h.pop}>
        <Dropdown.Menu aria-label="权限模式" className={h.menuList} onAction={(key) => pick(String(key) as TLocalPermissionMode)}>
          {modes.map((mode) => (
            <Dropdown.Item key={mode} id={mode} textValue={PERMISSION_MODE_TEXT[mode].name} className={h.menuItem} data-two-line="" data-current={mode === value ? "" : undefined}>
              <ModeText mode={mode} />
              {mode === value ? <Check {...ICON} /> : null}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** 手机上的同一个选择：点开是底部抽屉（同「后台任务」那个），点一档就选上收起；Esc、点空白处收起。 */
function PermissionModeSheet({ modes, value, onChange }: { modes: readonly TLocalPermissionMode[]; value: TLocalPermissionMode; onChange: (mode: TLocalPermissionMode) => void }) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const close = () => { setClosing(true); window.setTimeout(() => { setOpen(false); setClosing(false); }, 160); };
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open]);
  const pick = (mode: TLocalPermissionMode) => { close(); if (mode !== value) onChange(mode); };
  return (
    <>
      <button type="button" className={h.sendTo} aria-haspopup="dialog" aria-label={`权限模式：${PERMISSION_MODE_TEXT[value].name}`} onClick={() => setOpen(true)} data-testid="permission-mode">
        <b>{PERMISSION_MODE_TEXT[value].name}</b><ChevronDown {...ICON} />
      </button>
      {open ? (
        <div className={h.sheetBackdrop} data-closing={closing ? "" : undefined} onClick={close}>
          <div className={h.sheet} role="dialog" aria-modal="true" aria-label="权限模式" onClick={(event) => event.stopPropagation()} data-testid="permission-mode-sheet">
            <span className={h.grabber} aria-hidden />
            <div className={h.sheetList} role="radiogroup" aria-label="权限模式">
              {modes.map((mode) => (
                <button key={mode} type="button" role="radio" aria-checked={mode === value} className={h.menuItem} data-two-line="" data-current={mode === value ? "" : undefined}
                  autoFocus={mode === value} onClick={() => pick(mode)}>
                  <ModeText mode={mode} />
                  {mode === value ? <Check {...ICON} /> : null}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** 项目主管线下面那个选择现在的档（PipelineBody 给，派活单开工时带给本机）；不在项目里为 null。 */
export const ProjectModeContext = createContext<TLocalPermissionMode | null>(null);

/**
 * 项目新开子会话的默认档：打开项目时读一次（GET 项目详情），选了先变、PATCH 没成退回原来的、提示一句。没读到时为 null，不画。
 */
export function useProjectMode(projectId: string) {
  const [value, setValue] = useState<TLocalPermissionMode | null>(null);
  useEffect(() => {
    let alive = true;
    setValue(null);
    void readProject(projectId).then((detail) => { if (alive && detail) setValue(detail.project.permissionMode); }, () => undefined);
    return () => { alive = false; };
  }, [projectId]);
  if (!value) return null;
  const set = (mode: TLocalPermissionMode) => {
    const before = value;
    setValue(mode);
    void updateProject(projectId, { permissionMode: mode }).catch(() => { setValue(before); showWorkspaceToast({ text: "没改成" }); });
  };
  return { modes: AGENT_PERMISSION_MODES["claude-code"], value, set };
}

/**
 * 子会话现在的模式和换档：显示本人刚选的（还没等到本机回报时也先变），本机回报（事件或摘要）跟上了就以它为准；没换成退回原来的、提示一句。
 * 没有会话（还没开工）时为 null，不画。
 */
export function useSessionMode(runner: LocalRunner, session: TLocalSessionSummary | null, view: SessionView) {
  const [chosen, setChosen] = useState<TLocalPermissionMode | null>(null);
  const live = view.permissionMode ?? session?.permissionMode ?? RECOMMENDED_MODE;
  useEffect(() => { if (chosen && chosen === live) setChosen(null); }, [chosen, live]);
  if (!session) return null;
  const set = (mode: TLocalPermissionMode) => {
    setChosen(mode);
    void runner.setPermissionMode(session.id, mode).catch(() => { setChosen(null); showWorkspaceToast({ text: "没改成" }); });
  };
  return { modes: AGENT_PERMISSION_MODES[session.agent], value: chosen ?? live, set };
}
