"use client";

import { useState, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { TianshuPortalTheme } from "ts-design";
import { Button, Popover } from "ts-design/primitives";
import t from "@/styles/material-tabs.module.css";
import c from "./meeting-card.module.css";

export type CardMenuItem = { label: string; icon: ReactNode; disabled?: boolean; danger?: boolean; onPick: () => void };

/** 会议卡上一项右侧的「⋯」：浮层菜单（议题页「更多」同一套材质），点一项就关。 */
export function CardItemMenu({ label, items, disabled }: { label: string; items: CardMenuItem[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button variant="ghost" className={c.more} aria-label={label} isDisabled={disabled}>
        <Ellipsis size={16} strokeWidth={1.8} aria-hidden />
      </Button>
      <Popover.Content placement="bottom end" offset={4} className={t.popover}>
        <TianshuPortalTheme>
          <Popover.Dialog aria-label={label} className={`${t.menu} ${c.menu}`}>
            {items.map((item) => (
              <Button key={item.label} variant="ghost" className={`${t.item} ${c.menuRow}`} data-danger={item.danger ? "" : undefined} isDisabled={item.disabled}
                onPress={() => { setOpen(false); item.onPick(); }}>
                {item.icon}<span className={t.label}>{item.label}</span>
              </Button>
            ))}
          </Popover.Dialog>
        </TianshuPortalTheme>
      </Popover.Content>
    </Popover>
  );
}
