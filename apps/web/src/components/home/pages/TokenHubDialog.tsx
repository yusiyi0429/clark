"use client";

/**
 * 连 TokenHub 的小弹窗（设计 17.2 第 51 条），样子照新建项目那个（同一种弹层、字号间距）：
 * 标题；「API Key」密码框（进来就聚焦，行尾小眼睛看明文，回车等于点「连接」）；「取消」「连接」。
 * Key 只交给本机程序（127.0.0.1），不经过云端；没连上弹窗不关，框下一行写原因。
 */
import { useState } from "react";
import { Modal } from "@heroui/react";
import { Eye, EyeOff } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { LocalRunnerError } from "@/lib/local/runner";
import { ICON } from "../StateIcon";
import h from "@/styles/home.module.css";
import p from "@/styles/home-pages.module.css";

/** 没连上的原因：本机验 Key 的三种照写，别的照本机程序回的。 */
export function tokenHubFailure(error: unknown): string {
  if (error instanceof LocalRunnerError) {
    if (error.code === "tokenhub_key_rejected") return "Key 不对";
    if (error.code === "tokenhub_unreachable") return "连不上 TokenHub";
    if (error.code === "tokenhub_no_models") return "这个 Key 没有能用的模型";
    if (error.code === "network") return "连不上本机程序";
  }
  return (error instanceof Error && error.message) || "没连上";
}

export function TokenHubDialog({ onConnect, onClose }: { onConnect: (apiKey: string) => Promise<unknown>; onClose: () => void }) {
  const [key, setKey] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const value = key.trim();
  const connect = () => {
    if (!value || busy) return;
    setBusy(true);
    setFailed(null);
    void onConnect(value).then(onClose, (error: unknown) => { setBusy(false); setFailed(tokenHubFailure(error)); });
  };
  return (
    <Modal isOpen onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Backdrop className={h.dialogBackdrop} isDismissable>
        <Modal.Container size="sm">
          <Modal.Dialog className={h.dialog} aria-label="连接 TokenHub" data-testid="tokenhub-dialog">
            <h2 className={h.dialogTitle}>连接 TokenHub</h2>
            <div className={p.keyBlock}>
              <div className={p.keyField}>
                <input className={h.projectName} autoFocus type={shown ? "text" : "password"} aria-label="API Key" placeholder="API Key" maxLength={400}
                  autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true" value={key} aria-invalid={failed ? true : undefined} data-testid="tokenhub-key"
                  onChange={(event) => { setKey(event.currentTarget.value); setFailed(null); }}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.key !== "Enter") return;
                    event.preventDefault();
                    connect();
                  }} />
                <button type="button" className={`${h.icon} ${p.keyEye}`} aria-label={shown ? "隐藏" : "显示"} aria-pressed={shown} title={shown ? "隐藏" : "显示"}
                  onClick={() => setShown((on) => !on)}>{shown ? <EyeOff {...ICON} /> : <Eye {...ICON} />}</button>
              </div>
              {failed ? <p className={p.error} role="alert" data-testid="tokenhub-error">{failed}</p> : null}
            </div>
            <div className={h.dialogActions}>
              <HeroButton variant="tertiary" onPress={onClose}>取消</HeroButton>
              <HeroButton variant="primary" isDisabled={!value || busy} onPress={connect} data-testid="tokenhub-connect">连接</HeroButton>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
