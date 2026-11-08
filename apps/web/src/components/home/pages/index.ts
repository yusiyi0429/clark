/**
 * 二级页和月份页的挂载表（W 定挂载点，W2 交组件；设计 12.1、12.2）。
 *
 * 约定：
 * - SECONDARY_PAGES[页]：头像和资料（profile）、伙伴（buddy）、连接（connections）、岗位（roles）、我的记忆（memory）、偏好（preferences）各一个组件；
 * - MONTH_PAGE：月份页（10.4、10.5）；
 * - 组件只画展示区里的内容（页头以下）：页头（标题、返回）、右栏、左栏由外壳画；导航用 props.go，地址见 view.ts 的 pageHref / monthHref。
 * 外壳给的是文档类阅读尺（data-type-scale="doc"，正文列 600，区块之间 24），组件直接返回几块 Section。
 */
import type { ComponentType } from "react";
import type { PageKey } from "../view";
import { BuddyPage } from "./BuddyPage";
import { ConnectionsPage } from "./ConnectionsPage";
import { MemoryPage } from "./MemoryPage";
import { MonthPage } from "./MonthPage";
import { PreferencesPage } from "./PreferencesPage";
import { ProfilePage } from "./ProfilePage";
import { RolesPage } from "./RolesPage";

export type SecondaryPageProps = { go: (href: string) => void };
export type MonthPageProps = SecondaryPageProps & { period: string };

export const SECONDARY_PAGES: Record<PageKey, ComponentType<SecondaryPageProps>> = {
  profile: ProfilePage,
  buddy: BuddyPage,
  connections: ConnectionsPage,
  roles: RolesPage,
  memory: MemoryPage,
  preferences: PreferencesPage,
};
export const MONTH_PAGE: ComponentType<MonthPageProps> | null = MonthPage;
