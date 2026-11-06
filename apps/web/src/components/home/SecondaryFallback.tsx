"use client";

/**
 * 二级页还没由 W2 交（components/home/pages）时，先用现有的老组件顶着，内容和老个人菜单里的一样：
 * 头像和资料 = 换头像 + 个人资料；伙伴 = 伙伴形象；连接 = 插件页的本机程序和设备（「插件」改叫「连接」，设计 9.5）；偏好还没有内容，不画。
 */
import { avatarInitial, type Account } from "@/components/AccountMenu";
import { AvatarEditor } from "@/components/avatar/AvatarEditor";
import { BuddySettings } from "@/components/buddy/BuddySettings";
import { DevicesSection, LocalSection } from "@/components/local/PluginsPage";
import { PersonalProfileForm } from "@/components/PersonalProfileForm";
import type { PageKey } from "./view";

export function SecondaryFallback({ page, account }: { page: PageKey; account: Account }) {
  switch (page) {
    case "profile": return <><AvatarEditor personId={account.personId ?? null} initial={avatarInitial(account.displayName)} onDone={() => undefined} /><PersonalProfileForm /></>;
    case "buddy": return <BuddySettings onDone={() => undefined} />;
    case "connections": return <><LocalSection personName={account.displayName} handheld={false} /><DevicesSection personName={account.displayName} /></>;
    case "preferences": return null;
  }
}
