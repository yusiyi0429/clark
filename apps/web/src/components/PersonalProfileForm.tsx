"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "ts-design/primitives";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";
import s from "@/styles/account-menu.module.css";

type Profile = components["schemas"]["PersonalProfileView"];

export function PersonalProfileForm() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [gender, setGender] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    browserApi.GET("/api/me/profile").then(({ data, error: failure }) => {
      if (!active) return;
      if (data) { setProfile(data); setGender(data.gender ?? ""); }
      else setError(failure?.message ?? "资料暂时无法读取，请关闭后重试。");
    }).catch(() => { if (active) setError("资料暂时无法读取，请关闭后重试。"); });
    return () => { active = false; };
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!profile || busy) return;
    setBusy(true); setError(""); setSaved(false);
    try {
      const { data, error: failure } = await browserApi.PATCH("/api/me/profile", { body: { gender: gender.trim() || null } });
      if (!data) throw new Error(failure?.message ?? "未保存，请重试。");
      setProfile(data); setGender(data.gender ?? ""); setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "未保存，请重试。"); }
    finally { setBusy(false); }
  };
  return <form className={s.form} onSubmit={(event) => void submit(event)} aria-label="本人个人资料">
    <p>{profile?.displayName ?? "正在读取资料…"}</p>
    <label className={`${s.field} ${s.profileField}`}>性别（可选）
      <input type="text" value={gender} maxLength={40} disabled={!profile || busy} placeholder="自愿填写，可留空"
        onChange={(event) => { setGender(event.target.value); setSaved(false); }} aria-describedby="profile-visibility" />
    </label>
    <p id="profile-visibility" className={s.profileHint}>仅本人可查看和修改；清空后保存即可移除。</p>
    {error ? <p role="alert" className={s.error}>{error}</p> : null}
    {saved ? <p role="status" className={s.done}>已保存</p> : null}
    <div className={s.formActions}><Button type="submit" className={s.primary} isDisabled={!profile || busy}>{busy ? "保存中…" : "保存"}</Button></div>
  </form>;
}
