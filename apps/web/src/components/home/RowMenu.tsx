"use client";

/**
 * 左栏行尾的「…」菜单（17.2 第 35 条，照 Claude Code 侧栏）：鼠标移到这一行、键盘聚焦进来时出现，盖在行尾的状态点上；手机上长按这一行打开同一个菜单。
 * 弹层用全站那一种。要等云端回话的项（归档、删除）点了菜单先不关：做完关上，没成就在那一项上写原因；删除先变成「确认删除？」，再点一次才删。
 */
import { useRef, useState } from "react";
import { Dropdown } from "@heroui/react";
import { Check, Ellipsis } from "lucide-react";
import { CloudError } from "@/lib/board/cloud";
import { ICON } from "./StateIcon";
import h from "@/styles/home.module.css";

export type RowMenuItem = {
  id: string;
  label: string;
  /** 灰着不能点（没有新回复时的「标为已读」）。 */
  disabled?: boolean;
  /** 删除：红字，先「确认删除？」再做。 */
  danger?: boolean;
  /** 开关项（「不给同事读」）：打开时行尾画勾。 */
  checked?: boolean;
  /** 要等回话的：菜单开着等，没成时就地写 failText(error)。 */
  run: () => Promise<unknown> | void;
  failText?: (error: unknown) => string;
};

/** 删除第一次点了变成的那句。 */
export const CONFIRM_DELETE = "确认删除？";

/** 云端 409 时照 code 写的话；不认识的用 fallback。 */
export function conflictText(error: unknown, known: Record<string, string | null>, fallback: string): string {
  if (error instanceof CloudError && error.code && error.code in known) return known[error.code] ?? error.message;
  return fallback;
}

/** 手机上长按这一行（500ms）打开菜单；长按过的那一下不当成点击。 */
export function useLongPress(onLong: () => void) {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const clear = () => { if (timer.current !== null) window.clearTimeout(timer.current); timer.current = null; };
  return {
    onPointerDown: (event: { pointerType: string }) => {
      fired.current = false;
      if (event.pointerType !== "touch") return;
      clear();
      timer.current = window.setTimeout(() => { fired.current = true; onLong(); }, 500);
    },
    onPointerUp: clear, onPointerLeave: clear, onPointerCancel: clear,
    onContextMenu: (event: { preventDefault: () => void }) => { if (timer.current !== null || fired.current) event.preventDefault(); },
    onClickCapture: (event: { preventDefault: () => void; stopPropagation: () => void }) => { if (fired.current) { fired.current = false; event.preventDefault(); event.stopPropagation(); } },
  };
}

export function RowMenu({ label, items, open, onOpenChange }: { label: string; items: RowMenuItem[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; text: string } | null>(null);
  const change = (next: boolean) => { if (!next) { setConfirming(false); setFailed(null); } onOpenChange(next); };
  const act = async (item: RowMenuItem) => {
    if (busy) return;
    if (item.danger && !confirming) { setConfirming(true); return; }
    if (!item.failText) { change(false); await item.run(); return; }
    setBusy(item.id);
    setFailed(null);
    try { await item.run(); change(false); }
    catch (error) { setFailed({ id: item.id, text: item.failText(error) }); setConfirming(false); }
    finally { setBusy(null); }
  };
  const text = (item: RowMenuItem) => (failed?.id === item.id ? failed.text : item.danger && confirming ? CONFIRM_DELETE : item.label);
  return (
    <span className={h.rowMore} data-open={open ? "" : undefined}>
      <Dropdown isOpen={open} onOpenChange={change}>
        <Dropdown.Trigger className={h.rowMoreButton} aria-label={`${label} 更多`} data-testid="row-more"><Ellipsis {...ICON} /></Dropdown.Trigger>
        <Dropdown.Popover placement="bottom end" offset={4} className={h.pop}>
          <Dropdown.Menu aria-label={`${label} 菜单`} className={h.menuList} disabledKeys={items.filter((item) => item.disabled || busy === item.id).map((item) => item.id)}
            onAction={(key) => { const item = items.find((entry) => entry.id === key); if (item) void act(item); }}>
            {items.map((item) => (
              <Dropdown.Item key={item.id} id={item.id} textValue={text(item)} className={h.menuItem} shouldCloseOnSelect={false}
                data-danger={item.danger ? "" : undefined} data-failed={failed?.id === item.id ? "" : undefined} data-testid={`row-menu-${item.id}`}>
                <span className={h.grow}>{text(item)}</span>{item.checked ? <Check {...ICON} aria-hidden /> : null}
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </span>
  );
}
