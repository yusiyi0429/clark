"use client";

import { useEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import { Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { RotateCcw } from "lucide-react";
import x from "./execution-tour.module.css";

export type TourStep = { title: string; body: string; duration: number; Scene: ComponentType };
type TourContent = { label: string; steps: readonly TourStep[]; finish: ReactNode };

/** 共用演示卡片：完整播放当前幕才能前进，全部看完才出现出口。 */
export function PagedTourView({ label, steps, finish }: TourContent) {
  const last = steps.length - 1;
  const [step, setStep] = useState(0);
  const [replay, setReplay] = useState(0);
  const [watched, setWatched] = useState(-1);
  const { title, body, duration, Scene } = steps[step];
  const ready = watched >= step;
  const finished = watched >= last;

  const dialog = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const stopEscape = (event: KeyboardEvent) => {
      // 禁止模态关闭之外，也要阻止 Esc 冒泡到工作区的「返回上一页」。
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
    };
    element?.addEventListener("keydown", stopEscape);
    return () => element?.removeEventListener("keydown", stopEscape);
  }, []);

  const host = useRef<HTMLDivElement>(null);
  // 跟随实际动画完成；后台暂停不会跳过演示，减少动态效果时立即可翻页。
  useEffect(() => {
    if (watched >= step || !host.current) return;
    let live = true;
    const finite = host.current.getAnimations?.({ subtree: true }).filter((animation) => animation.effect?.getTiming().iterations !== Infinity) ?? [];
    // 播放中切换「减少动态效果」会取消动画（finished 拒绝），也应抵达静止终态。
    Promise.allSettled(finite.map((animation) => animation.finished)).then(() => { if (live) setWatched((value) => Math.max(value, step)); });
    return () => { live = false; };
  }, [step, replay, watched]);

  const go = (next: number) => {
    if (next < 0 || next > last || (next > step && !ready)) return;
    setStep(next);
    setReplay(0);
  };
  const swipe = useRef<number | null>(null);
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") goRef.current(step + 1);
      if (event.key === "ArrowLeft") goRef.current(step - 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [step]);

  return <Dialog ref={dialog} className={x.card} aria-label={label}>
    <div
      className={x.stage}
      onPointerDown={(event) => { swipe.current = event.clientX; }}
      onPointerUp={(event) => {
        const start = swipe.current;
        swipe.current = null;
        if (start === null || event.pointerType === "mouse") return;
        const dx = event.clientX - start;
        if (Math.abs(dx) > 48) go(step + (dx < 0 ? 1 : -1));
      }}
    >
      <div key={`${step}-${replay}`} ref={host} className={x.sceneHost} aria-hidden="true"><Scene /></div>
      <button type="button" className={x.replay} onClick={() => setReplay((value) => value + 1)} aria-label="重播这一步"><RotateCcw size={14} aria-hidden />重播</button>
    </div>
    <div className={x.footer}>
      <div className={x.copy} aria-live="polite">
        <p className={x.count}>第 {step + 1} 步，共 {steps.length} 步</p>
        <Heading slot="title" className={x.title}>{title}</Heading>
        <p className={x.body}>{body}</p>
      </div>
      <div className={x.controls}>
        <div className={x.dots} aria-hidden="true">{steps.map((item, index) => <span key={item.title} data-current={index === step} data-past={index < step} />)}</div>
        <div className={x.buttons}>
          {step > 0 ? <button type="button" className={x.textButton} onClick={() => go(step - 1)}>上一步</button> : null}
          {step < last ? <button type="button" className={x.next} data-ready={ready} aria-disabled={!ready} onClick={() => go(step + 1)} style={{ "--dur": `${duration}ms` } as CSSProperties} key={`next-${step}-${replay}`}>
            <span className={x.nextFill} aria-hidden /><span className={x.nextLabel}>下一步</span>
          </button> : finished ? finish : <button type="button" className={x.next} data-ready="false" aria-disabled="true" style={{ "--dur": `${duration}ms` } as CSSProperties}><span className={x.nextFill} aria-hidden /><span className={x.nextLabel}>看完这一步</span></button>}
        </div>
      </div>
    </div>
  </Dialog>;
}

export function PagedTour({ isOpen, ...content }: TourContent & { isOpen: boolean }) {
  return <ModalOverlay className={x.overlay} isOpen={isOpen} isKeyboardDismissDisabled>
    <Modal className={x.modal}><PagedTourView {...content} /></Modal>
  </ModalOverlay>;
}
