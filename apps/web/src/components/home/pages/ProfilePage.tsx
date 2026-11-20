"use client";

/**
 * 头像和资料（个人菜单第一项，设计 9.4、5.4.6）：两块。
 * - 头像：现在的头像 96，「选照片 / 换一张」（次按钮）、「删掉照片」（弱按钮）；选了图在圆框里拖动、缩放，「保存」（主按钮）、「重新选」「取消」（弱按钮）。
 *   选图、裁剪、上传、删掉都是 useAvatarCrop（老菜单的换头像弹窗同一套）。
 * - 资料：名字（只看，登录 ID · 角色）；性别（可选），离开输入框时存，存好写「已保存」2 秒；没存上原处「失败 · 重试」。
 * - 加我好友、新好友默认开放（同事伙伴设计第 3 节）：FriendSettingsSections。
 * 不写说明句（「仅本人可查看」之类）。
 */
import { useEffect, useRef, useState } from "react";
import type { components } from "@/lib/api/schema";
import { avatarInitial } from "@/components/AccountMenu";
import { AVATAR_BOX, AVATAR_MAX_ZOOM, useAvatarCrop } from "@/components/avatar/AvatarEditor";
import { PersonAvatar } from "@/components/avatar/PersonAvatar";
import { HeroButton } from "@/components/HeroButton";
import { FailedLine } from "@/components/work/DecisionBox";
import { browserApi } from "@/lib/api/client";
import { FriendSettingsSections } from "../FriendSheet";
import type { SecondaryPageProps } from "./index";
import { Loading, Row, Section, useMe, type Me } from "./parts";
import p from "@/styles/home-pages.module.css";

type Profile = components["schemas"]["PersonalProfileView"];

export function ProfilePage(_props: SecondaryPageProps) {
  const me = useMe();
  if (!me) return <Loading />;
  return <><AvatarSection me={me} /><ProfileSection me={me} /><FriendSettingsSections /></>;
}

function AvatarSection({ me }: { me: Me }) {
  const crop = useAvatarCrop(me.personId, () => crop.reset());
  const { version, source, size, busy, error } = crop;
  return (
    <Section title="头像" testId="avatar-section">
      {source && size ? (
        <div className={p.crop}>
          <div className={p.cropStage} style={{ width: AVATAR_BOX, height: AVATAR_BOX }} {...crop.stage}>
            <img className={p.cropImage} src={source.url} alt="" draggable={false}
              style={{ width: size.width, height: size.height, transform: `translate(-50%, -50%) translate(${crop.offset.x}px, ${crop.offset.y}px)` }} />
            <span className={p.cropRing} aria-hidden />
          </div>
          <input type="range" className={p.zoom} aria-label="缩放" min={1} max={AVATAR_MAX_ZOOM} step={0.01} value={crop.zoom} disabled={busy}
            onChange={(event) => crop.setZoom(Number(event.target.value))} />
          {error ? <p className={p.error} role="alert">{error}</p> : null}
          <div className={p.avatarActs}>
            <HeroButton variant="primary" size="sm" isDisabled={busy} onPress={() => void crop.save()}>保存</HeroButton>
            <HeroButton variant="ghost" size="sm" isDisabled={busy} onPress={crop.choose}>重新选</HeroButton>
            <HeroButton variant="ghost" size="sm" isDisabled={busy} onPress={crop.reset}>取消</HeroButton>
          </div>
        </div>
      ) : (
        <div className={p.avatarRow}>
          <PersonAvatar personId={me.personId} className={p.avatar}>{avatarInitial(me.displayName)}</PersonAvatar>
          <div className={p.avatarActs}>
            <HeroButton variant="tertiary" size="sm" isDisabled={busy || !me.personId} onPress={crop.choose}>{version ? "换一张" : "选照片"}</HeroButton>
            {version ? <HeroButton variant="ghost" size="sm" isDisabled={busy} onPress={() => void crop.remove()}>删掉照片</HeroButton> : null}
          </div>
          {error ? <p className={p.error} role="alert">{error}</p> : null}
        </div>
      )}
      {crop.chooser}
    </Section>
  );
}

function ProfileSection({ me }: { me: Me }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [gender, setGender] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const timer = useRef(0);
  const load = () => {
    setFailed(null);
    void browserApi.GET("/api/me/profile").then(({ data, error }) => {
      if (data) { setProfile(data); setGender(data.gender ?? ""); }
      else setFailed(error?.message ?? "");
    }).catch((cause: unknown) => setFailed(cause instanceof Error ? cause.message : ""));
  };
  useEffect(load, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const save = async () => {
    if (!profile || saving || (gender.trim() || null) === (profile.gender ?? null)) return;
    setSaving(true); setSaveFailed(null); setSaved(false);
    try {
      const { data, error } = await browserApi.PATCH("/api/me/profile", { body: { gender: gender.trim() || null } });
      if (!data) throw new Error(error?.message ?? "");
      setProfile(data); setGender(data.gender ?? ""); setSaved(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setSaved(false), 2000);
    } catch (cause) { setSaveFailed(cause instanceof Error ? cause.message : ""); }
    finally { setSaving(false); }
  };
  const subtitle = [me.loginId, me.role === "ceo" ? "CEO" : "成员"].filter(Boolean).join(" · ");
  return (
    <Section title="资料" testId="profile-section">
      <ul className={p.rows}><Row name={me.displayName} sub={subtitle || undefined} /></ul>
      {failed !== null ? <FailedLine reason={failed} onRetry={load} /> : !profile ? <Loading /> : (
        <div className={p.field}>
          <label htmlFor="profile-gender"><span>性别</span></label>
          <input id="profile-gender" className={p.input} type="text" value={gender} maxLength={40} disabled={saving} placeholder="可留空"
            onChange={(event) => { setGender(event.target.value); setSaved(false); }}
            onBlur={() => void save()} onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) (event.target as HTMLInputElement).blur(); }} />
          {saveFailed !== null ? <FailedLine reason={saveFailed} onRetry={() => void save()} /> : saved ? <span className={p.saved} role="status">已保存</span> : null}
        </div>
      )}
    </Section>
  );
}
