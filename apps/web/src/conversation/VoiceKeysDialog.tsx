"use client";

/**
 * 语音快捷键面板（样稿 voice-keys-v4）：第一次点「对话天枢」时弹一次；以后从输入条上的小键盘图标、个人菜单「设置 › 语音输入」打开。
 * 顶上一段循环小动画：按 Ulanzi VibeKey（竖条、顶上收音孔、只露出第一颗语音键）→ 右下角「对话天枢」展开成输入框 → 说的话落进来。
 * 两行照抄微信输入法设置页的名字：按住说话 / 启动语音输入。点一行就等着录（绿圈「按一下对话器上的键」），按一下对话器上平时说话用的键就录好，
 * 这一行变成醒目的「已识别」（10/28：不显示具体是哪颗键）；有一行识别了，底部就说以后按对话器上的对话键就能唤醒。
 * 打开时等着录的是第一行还没录过的那一行。录好马上存（voiceKeys.ts）。
 * 「稍后再弄」「完成」一样大，都关掉面板、记下弹过了。Esc、Tab 留给面板自己；单按回车 / 空格是按按钮，不录。
 */
import { useEffect, useState } from "react";
import { Check, Mic, MessageCircle } from "lucide-react";
import { Button, Modal } from "ts-design/primitives";
import { useStableCallback } from "./stableCallback";
import { gestureCode, readVoiceKeys, saveVoiceKeys, type VoiceKeys, type VoiceMode } from "./voiceKeys";
import v from "@/styles/voice-keys.module.css";

const ROWS: [VoiceMode, string][] = [["hold", "按住说话"], ["tap", "启动语音输入"]];
const PASS_THROUGH = new Set(["Escape", "Tab"]);
const PRESS_KEYS = new Set(["Enter", "NumpadEnter", "Space"]);

/** 本人在这里录过的（微信的默认键不算识别过）。 */
const firstEmpty = (keys: VoiceKeys): VoiceMode | null => ROWS.find(([mode]) => !keys[mode]?.length)?.[0] ?? null;

/** 等着录时：从第一颗键按下到全部松开算一次，交出这次收到的键。 */
function useKeyCapture(live: VoiceMode | null, onCaptured: (codes: string[]) => void) {
  const captured = useStableCallback(onCaptured);
  useEffect(() => {
    if (!live) return;
    const down = new Set<string>();
    const seen = new Set<string>();
    const onDown = (event: KeyboardEvent) => {
      const code = gestureCode(event);
      if (PASS_THROUGH.has(event.key) || (down.size === 0 && code && PRESS_KEYS.has(code))) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || !code) return;
      if (down.size === 0) seen.clear();
      down.add(code);
      seen.add(code);
    };
    const onUp = (event: KeyboardEvent) => {
      const code = gestureCode(event);
      if (!code || !down.delete(code)) return;
      event.preventDefault();
      event.stopPropagation();
      if (down.size === 0) captured([...seen]);
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
    };
  }, [live, captured]);
}

/** 按 Ulanzi 上的语音键 → 输入框打开、字落进来（纯 CSS 循环；减少动态效果时停在最后一帧）。 */
function WakeDemo() {
  return (
    <div className={v.demo} aria-hidden="true">
      <div className={v.device}>
        <span className={v.grille}><i /><i /><i /><i /><i /><i /></span>
        <span className={v.key}><span className={v.button}><Mic size={12} strokeWidth={2} /></span></span>
      </div>
      <div className={v.screen}>
        <div className={v.bar}>
          <MessageCircle size={11} strokeWidth={2} />
          <span className={v.typed}>整理一下今天的会议要点</span>
          <span className={v.caret} />
        </div>
      </div>
    </div>
  );
}

export function VoiceKeysDialog({ onClose }: { onClose: () => void }) {
  const [keys, setKeys] = useState<VoiceKeys>(readVoiceKeys);
  const [live, setLive] = useState<VoiceMode | null>(() => firstEmpty(readVoiceKeys()));
  /** 刚识别的那一行：亮一下绿底。 */
  const [just, setJust] = useState<VoiceMode | null>(null);
  useKeyCapture(live, (codes) => {
    if (!live) return;
    const next = saveVoiceKeys({ [live]: codes });
    setKeys(next);
    setJust(live);
    setLive(firstEmpty(next));
  });
  const close = () => {
    saveVoiceKeys({ intro: true });
    onClose();
  };
  const known = (mode: VoiceMode) => Boolean(keys[mode]?.length);
  return (
    <Modal isOpen onOpenChange={(open) => { if (!open) close(); }}>
      <Modal.Backdrop className={v.backdrop} isDismissable>
        <Modal.Container size="sm">
          <Modal.Dialog className={v.panel} aria-label="语音快捷键" data-voice-keys>
            <WakeDemo />
            <div className={v.title}>
              <img src="/brand/wetype.png" alt="微信输入法" width={28} height={28} />
              <h2>连接微信输入法的语音快捷键</h2>
            </div>
            <p className={v.lead}>按一下对话器上平时用来说话的键，天枢就认住它</p>
            <div className={v.rows}>
              {ROWS.map(([mode, name]) => (
                <button key={mode} type="button" className={v.row} data-voice-key={mode} data-live={live === mode} data-known={live !== mode && known(mode)}
                  data-just={live !== mode && just === mode} onClick={() => setLive(mode)}>
                  <span>{name}</span>
                  {live === mode ? <em>按一下对话器上的键</em>
                    : known(mode) ? <strong className={v.ok}><Check size={16} strokeWidth={2.6} aria-hidden="true" />已识别</strong>
                    : <span className={v.empty}>点这里再按键</span>}
                </button>
              ))}
            </div>
            {known("hold") || known("tap") ? (
              <p className={v.ready} role="status"><Check size={18} strokeWidth={2.6} aria-hidden="true" />以后按对话器上的对话键，就能一键唤醒天枢</p>
            ) : null}
            <div className={v.foot}>
              <Button className={v.later} onPress={close}>稍后再弄</Button>
              <Button className={v.done} onPress={close}>完成</Button>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

/** 第一次点「对话天枢」时要不要弹面板：没弹过，而且不是触屏（手机上没有微信电脑版的语音键）。 */
export function voiceIntroDue(): boolean {
  return !readVoiceKeys().intro && !window.matchMedia("(pointer: coarse)").matches;
}
