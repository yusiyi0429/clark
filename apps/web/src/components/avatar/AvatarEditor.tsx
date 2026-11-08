"use client";

/**
 * 个人菜单 › 设置 › 换头像：选一张图 → 在圆框里拖动、缩放 → 确定，本机裁成 256×256 JPEG 再传；传过的可以删掉，回到单字。
 * 裁剪框自己写：只要固定圆框里的拖动加缩放，用 ts-design 的 Slider，不为此加依赖。
 * 状态和动作在 useAvatarCrop 里，新首页「头像和资料」页（components/home/pages）也用它，各自画样子。
 */

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Button, Slider } from "ts-design/primitives";
import { browserApi } from "@/lib/api/client";
import { PersonAvatar, setMyAvatarVersion, useAvatarVersion } from "./PersonAvatar";
import m from "@/styles/account-menu.module.css";
import e from "@/styles/avatar-editor.module.css";

/** 裁剪框边长（页面上）与导出边长。 */
export const AVATAR_BOX = 240;
const BOX = AVATAR_BOX;
const OUT = 256;
export const AVATAR_MAX_ZOOM = 3;

type Source = { image: HTMLImageElement; url: string };
type Offset = { x: number; y: number };

/** 图在框里显示的大小：zoom = 1 时短边正好铺满框。 */
const shown = (image: HTMLImageElement, zoom: number) => {
  const scale = (BOX / Math.min(image.naturalWidth, image.naturalHeight)) * zoom;
  return { width: image.naturalWidth * scale, height: image.naturalHeight * scale };
};

/** 拖动不能露出框外的空白。 */
const clamp = (offset: Offset, image: HTMLImageElement, zoom: number): Offset => {
  const { width, height } = shown(image, zoom);
  const limitX = (width - BOX) / 2, limitY = (height - BOX) / 2;
  return { x: Math.max(-limitX, Math.min(limitX, offset.x)), y: Math.max(-limitY, Math.min(limitY, offset.y)) };
};

function cropToDataUrl(image: HTMLImageElement, zoom: number, offset: Offset): string {
  const { width, height } = shown(image, zoom);
  const k = OUT / BOX;
  const canvas = document.createElement("canvas");
  canvas.width = OUT;
  canvas.height = OUT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, OUT, OUT);
  context.drawImage(image, OUT / 2 + (offset.x - width / 2) * k, OUT / 2 + (offset.y - height / 2) * k, width * k, height * k);
  return canvas.toDataURL("image/jpeg", 0.9);
}

/**
 * 换头像的状态和动作：选图（choose；隐藏的 input 是 chooser，调用方放进页面）、拖动（stage 的指针事件）、缩放、保存、删掉、放弃这张图（reset）。
 * onDone：存好以后。
 */
export function useAvatarCrop(personId: string | null, onDone: () => void) {
  const version = useAvatarVersion(personId);
  const [source, setSource] = useState<Source | null>(null);
  const [zoom, setZoomValue] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const drag = useRef<{ pointer: number; x: number; y: number; from: Offset } | null>(null);
  useEffect(() => () => { if (source) URL.revokeObjectURL(source.url); }, [source]);

  const pick = async (picked: File) => {
    setError("");
    const url = URL.createObjectURL(picked);
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      URL.revokeObjectURL(url);
      setError("这张图打不开，换一张 JPEG 或 PNG 试试。");
      return;
    }
    setZoomValue(1);
    setOffset({ x: 0, y: 0 });
    setSource({ image, url });
  };
  const save = async () => {
    if (!source || !personId) return;
    setBusy(true);
    setError("");
    try {
      const { data, error: failure } = await browserApi.PUT("/api/me/avatar", { body: { image: cropToDataUrl(source.image, zoom, offset) } });
      if (!data) throw new Error(failure?.message ?? "未保存，请重试。");
      setMyAvatarVersion(personId, data.version);
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "未保存，请重试。");
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!personId) return;
    setBusy(true);
    setError("");
    const { response } = await browserApi.DELETE("/api/me/avatar").catch(() => ({ response: null }));
    if (response?.ok) setMyAvatarVersion(personId, null);
    else setError("没删成，请重试。");
    setBusy(false);
  };
  const setZoom = (next: number) => {
    setZoomValue(next);
    if (source) setOffset((current) => clamp(current, source.image, next));
  };
  const press = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, from: offset };
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.pointer !== event.pointerId || !source) return;
    setOffset(clamp({ x: start.from.x + event.clientX - start.x, y: start.from.y + event.clientY - start.y }, source.image, zoom));
  };
  const release = () => { drag.current = null; };
  const chooser = (
    <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => {
      const picked = event.target.files?.[0];
      event.target.value = "";
      if (picked) void pick(picked);
    }} />
  );
  return {
    version, source, zoom, setZoom, offset, busy, error, save, remove, chooser,
    choose: () => file.current?.click(),
    /** 放弃这张图（新页存好以后也用它回到现在的头像）。 */
    reset: () => { setSource(null); setError(""); setBusy(false); },
    size: source ? shown(source.image, zoom) : null,
    stage: { onPointerDown: press, onPointerMove: move, onPointerUp: release, onPointerCancel: release },
  };
}

/** initial：没照片时圆里那个字（个人菜单的 avatarInitial）。 */
export function AvatarEditor({ personId, initial, onDone }: { personId: string | null; initial: string; onDone: () => void }) {
  const { version, source, zoom, setZoom, offset, busy, error, save, remove, chooser, choose, size, stage } = useAvatarCrop(personId, onDone);

  if (!source || !size) {
    return (
      <div className={m.form}>
        <PersonAvatar personId={personId} className={e.preview}>{initial}</PersonAvatar>
        {error ? <p role="alert" className={m.error}>{error}</p> : null}
        <div className={`${m.formActions} ${e.actions}`}>
          {version ? <Button variant="ghost" className={m.quietButton} isDisabled={busy} onPress={() => void remove()}>删掉照片</Button> : null}
          <Button variant="ghost" className={m.primary} isDisabled={busy || !personId} onPress={choose}>{version ? "换一张" : "选照片"}</Button>
        </div>
        {chooser}
      </div>
    );
  }

  return (
    <div className={m.form}>
      <div className={e.stage} style={{ width: BOX, height: BOX }} {...stage}>
        <img className={e.image} src={source.url} alt="" draggable={false}
          style={{ width: size.width, height: size.height, transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px)` }} />
        <span className={e.ring} aria-hidden="true" />
      </div>
      <Slider className={e.zoom} aria-label="缩放" minValue={1} maxValue={AVATAR_MAX_ZOOM} step={0.01} value={zoom} isDisabled={busy}
        onChange={(value) => setZoom(Array.isArray(value) ? value[0] : value)}>
        <Slider.Track>
          <Slider.Fill />
          <Slider.Thumb />
        </Slider.Track>
      </Slider>
      {error ? <p role="alert" className={m.error}>{error}</p> : null}
      <div className={`${m.formActions} ${e.actions}`}>
        <Button variant="ghost" className={m.quietButton} isDisabled={busy} onPress={choose}>重新选</Button>
        <Button variant="ghost" className={m.primary} isDisabled={busy} onPress={() => void save()}>{busy ? "保存中…" : "确定"}</Button>
      </div>
      {chooser}
    </div>
  );
}
