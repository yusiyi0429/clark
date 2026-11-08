"use client";

/**
 * 二级页还没由 W2 交（components/home/pages）时，先用现有的老组件顶着，内容和老个人菜单里的一样：
 * 头像和资料 = 换头像 + 个人资料；伙伴 = 伙伴形象；连接 = 插件页的本机程序和设备（「插件」改叫「连接」，设计 9.5）；偏好 = 外观、飞书推送、缺省预算（17.2）。
 */
import { avatarInitial, type Account } from "@/components/AccountMenu";
import { AvatarEditor } from "@/components/avatar/AvatarEditor";
import { BuddySettings } from "@/components/buddy/BuddySettings";
import { DevicesSection, LocalSection } from "@/components/local/PluginsPage";
import { PersonalProfileForm } from "@/components/PersonalProfileForm";
import type { PageKey } from "./view";
import { linkPerson } from "@/lib/local/link";
import { Preferences } from "./Preferences";

export function SecondaryFallback({ page, account }: { page: PageKey; account: Account }) {
  switch (page) {
    case "profile": return <><AvatarEditor personId={account.personId ?? null} initial={avatarInitial(account.displayName)} onDone={() => undefined} /><PersonalProfileForm /></>;
    case "buddy": return <BuddySettings />;
    case "connections": return <><LocalSection person={linkPerson(account)} handheld={false} /><DevicesSection person={linkPerson(account)} /></>;
    case "preferences": return <Preferences />;
  }
}
