"use client";

import { useEffect, useState } from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { X } from "lucide-react";
import { RELEASE, releaseSeenKey } from "@/lib/releaseNotes";
import { useSeenMarks } from "@/lib/useSeenMarks";
import { ReleaseArt } from "./ReleaseArt";
import s from "./whats-new.module.css";

/** 首页入场动画（约 640ms）之后再弹，不和解锁转场抢同一刻。 */
const OPEN_DELAY_MS = 700;

export function ReleaseNotesView({ onClose }: { onClose: () => void }) {
  return <Dialog className={s.card} aria-labelledby="release-title">
    <div className={s.copy}>
      <p className={s.label}>{RELEASE.label}</p>
      <Heading slot="title" id="release-title" className={s.title}>{RELEASE.title}</Heading>
      <ul className={s.items}>{RELEASE.items.map((item) => <li key={item}>{item}</li>)}</ul>
      <button type="button" className={s.primary} onClick={onClose} autoFocus>知道了</button>
    </div>
    <ReleaseArt />
    <button type="button" className={s.close} aria-label="关闭更新说明" onClick={onClose}><X size={16} aria-hidden /></button>
  </Dialog>;
}

/** 这一版的更新说明：所有人进工作台都弹一次，关掉即算看过（按人记，换设备不再弹）。 */
export function WhatsNewCard() {
  const { seen, mark } = useSeenMarks();
  const key = releaseSeenKey(RELEASE.id);
  const pending = seen !== null && !seen.has(key);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);
  const close = () => {
    setOpen(false);
    mark(key);
  };
  return <ModalOverlay className={s.overlay} isOpen={open} onOpenChange={(next) => { if (!next) close(); }}>
    <Modal className={s.modal}><ReleaseNotesView onClose={close} /></Modal>
  </ModalOverlay>;
}
