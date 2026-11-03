"use client";

/**
 * 本人给左边通知栏选的背景（个人菜单 › 设置 › 通知栏背景）：存在服务端、跟着人走。
 * 这台电脑上另记一份上次的选择，打开页面先用它，免得每次先闪一下雾蓝；保存后发 `rail-background-changed`，
 * 同一页里的通知栏和设置面板跟着重读。
 */

import { useEffect, useState, type CSSProperties } from "react";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";

export type RailBackground = components["schemas"]["RailBackground"];
export type RailBackgroundChoice = RailBackground["choice"];
type SaveBody = components["schemas"]["SaveRailBackgroundRequest"];

const CHANGED = "rail-background-changed";
const STORED = "tianshu.rail-background";
/** 上传前缩到的长边：通知栏最高一千来像素，两倍屏也够用。 */
const MAX_EDGE = 2000;

function readStored(): RailBackground | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORED) ?? "null") as RailBackground | null;
    return value && typeof value.choice === "string" ? value : null;
  } catch { return null; }
}

function store(value: RailBackground) {
  try { window.localStorage.setItem(STORED, JSON.stringify(value)); } catch { /* 记不下就每次从服务端读 */ }
}

const railImageUrl = (version: string) => `/api/me/rail-background/image?v=${encodeURIComponent(version)}`;

/** 通知栏（或小样）上要带的：哪张预设；选了「我的图」时再带上图片地址。雾蓝是默认样子，不带属性。 */
export function railBackgroundProps(value: RailBackground | null): { "data-rail-bg"?: RailBackgroundChoice; style?: CSSProperties } {
  if (!value || value.choice === "mist") return {};
  if (value.choice !== "custom") return { "data-rail-bg": value.choice };
  if (!value.imageVersion) return {};
  return { "data-rail-bg": "custom", style: { "--rail-photo": `url("${railImageUrl(value.imageVersion)}")` } as CSSProperties };
}

export function useRailBackground(): RailBackground | null {
  const [value, setValue] = useState<RailBackground | null>(null);
  useEffect(() => {
    let active = true;
    const stored = readStored();
    if (stored) setValue(stored);
    const load = () => {
      void browserApi.GET("/api/me/rail-background").then(({ data }) => {
        if (!active || !data) return;
        store(data);
        setValue(data);
      }).catch(() => undefined);
    };
    load();
    window.addEventListener(CHANGED, load);
    return () => { active = false; window.removeEventListener(CHANGED, load); };
  }, []);
  return value;
}

export async function saveRailBackground(body: SaveBody): Promise<RailBackground> {
  const { data, error } = await browserApi.PUT("/api/me/rail-background", { body });
  if (!data) throw new Error(error?.message ?? "未保存，请重试。");
  store(data);
  window.dispatchEvent(new Event(CHANGED));
  return data;
}

/** 本机先缩到长边 2000 像素以内、转成 JPEG 再传：手机照片动辄几 MB，通知栏用不了那么大。读不出来的图（比如 HEIC）抛错。 */
export async function shrinkImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}
