"use client";

/** 个人菜单 › 设置 › 通知栏背景：点一张就换上（不用再按保存）；也可以上传自己的图，上传过的留在「我的图」里，换回预设也不丢。 */

import { useRef, useState } from "react";
import { ImagePlus } from "lucide-react";
import { railBackgroundProps, saveRailBackground, shrinkImage, useRailBackground, type RailBackgroundChoice } from "./useRailBackground";
import r from "@/styles/rail-background.module.css";

const PRESETS: { choice: Exclude<RailBackgroundChoice, "custom">; label: string }[] = [
  { choice: "mist", label: "雾蓝" },
  { choice: "dusk", label: "暮霞" },
  { choice: "pine", label: "松林" },
  { choice: "night", label: "夜航" },
  { choice: "sand", label: "暖沙" },
];

export function RailBackgroundSettings() {
  const current = useRailBackground();
  const [busy, setBusy] = useState<RailBackgroundChoice | "upload" | null>(null);
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const selected = current?.choice ?? "mist";
  const save = async (busyWith: RailBackgroundChoice | "upload", body: Parameters<typeof saveRailBackground>[0]) => {
    setBusy(busyWith);
    setError("");
    try {
      await saveRailBackground(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "未保存，请重试。");
    } finally {
      setBusy(null);
    }
  };
  const upload = async (picked: File) => {
    setBusy("upload");
    setError("");
    let image: string;
    try {
      image = await shrinkImage(picked);
    } catch {
      setBusy(null);
      setError("这张图打不开，换一张 JPEG 或 PNG 试试。");
      return;
    }
    await save("upload", { choice: "custom", image });
  };
  const option = (choice: RailBackgroundChoice, label: string) => (
    <label key={choice} className={r.option} data-selected={selected === choice || undefined} aria-disabled={busy !== null}>
      <input type="radio" name="rail-background" value={choice} checked={selected === choice} disabled={busy !== null}
        onChange={() => void save(choice, { choice })} />
      <span className={`${r.bg} ${r.swatch}`} {...railBackgroundProps({ choice, imageVersion: current?.imageVersion ?? null })} />
      {label}
    </label>
  );
  return (
    <div className={r.options} role="radiogroup" aria-label="通知栏背景">
      {PRESETS.map((preset) => option(preset.choice, preset.label))}
      {current?.imageVersion ? option("custom", "我的图") : null}
      <button type="button" className={`${r.option} ${r.upload}`} aria-disabled={busy !== null} onClick={() => { if (busy === null) file.current?.click(); }}>
        <span className={r.swatch}><ImagePlus size={20} aria-hidden="true" /></span>
        {busy === "upload" ? "上传中…" : current?.imageVersion ? "换一张图" : "上传图片"}
      </button>
      <input ref={file} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(event) => {
        const picked = event.target.files?.[0];
        event.target.value = "";
        if (picked) void upload(picked);
      }} />
      {error ? <p role="alert" className={r.error}>{error}</p> : null}
    </div>
  );
}
