"use client";

/**
 * 右侧浮出的面板（首页约会议、等回复）：形状同通知栏——离屏幕四边一圈、大圆角；从右侧滑入并淡入，关时原路滑出淡出。
 * Esc、点面板外关闭、焦点圈在面板里、关后焦点回到按下的键，都由 react-aria 的 Modal 管。手持（≤959）四周留 8 铺满。
 */
import type { ReactNode } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import s from "./side-panel.module.css";

export function SidePanel({ open, onClose, label, children }: { open: boolean; onClose(): void; label: string; children: ReactNode }) {
  return (
    <ModalOverlay isOpen={open} onOpenChange={(next) => { if (!next) onClose(); }} isDismissable className={s.scrim}>
      <Modal className={s.panel}>
        <Dialog className={s.dialog} aria-label={label}>{children}</Dialog>
      </Modal>
    </ModalOverlay>
  );
}
