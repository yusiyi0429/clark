"use client";

import { useCallback, useState } from "react";
import { Button, Modal } from "@heroui/react";
import c from "@/styles/confirm-dialog.module.css";

/**
 * 应用内确认（代替 window.confirm）：HeroUI Modal + clark 弹层材质。
 * `ask(text)` 返回用户是否继续；Escape、点遮罩、取消都算不继续。
 */
export function useConfirm() {
  const [state, setState] = useState<{ text: string; confirmLabel: string; resolve: (ok: boolean) => void } | null>(null);
  const ask = useCallback(
    (text: string, confirmLabel = "继续") => new Promise<boolean>((resolve) => setState({ text, confirmLabel, resolve })),
    [],
  );
  const finish = (ok: boolean) => {
    state?.resolve(ok);
    setState(null);
  };
  const dialog = state ? (
    <Modal isOpen onOpenChange={(open) => (open ? undefined : finish(false))}>
      <Modal.Backdrop className={c.backdrop} isDismissable>
        <Modal.Container size="sm">
          <Modal.Dialog className={c.dialog} role="alertdialog" aria-label="请确认">
            <p className={c.text}>{state.text}</p>
            <div className={c.actions}>
              <Button variant="tertiary" onPress={() => finish(false)}>
                取消
              </Button>
              <Button variant="primary" onPress={() => finish(true)}>
                {state.confirmLabel}
              </Button>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  ) : null;
  return { ask, dialog };
}
