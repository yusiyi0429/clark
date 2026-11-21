/**
 * 二级页和月份页的挂载表（W 定挂载点，W2 交组件；设计 12.1、12.2）。
 *
 * 约定：
 * - SECONDARY_PAGES[页]：头像和资料（profile）、伙伴（buddy）、连接和技能（connections、roles 两个键开同一页，分别落在「连接」「技能」标签）、对外资料（materials）、我的记忆（memory）、偏好（preferences）；
 * - MONTH_PAGE：月份页（10.4、10.5）；
 * - 组件只画展示区里的内容（页头以下）：页头（标题、返回）、右栏、左栏由外壳画；导航用 props.go，地址见 view.ts 的 pageHref / monthHref。
 * 外壳给的是文档类阅读尺（data-type-scale="doc"，正文列 600，区块之间 24），组件直接返回几块 Section。
 */
import type { ComponentType, ReactNode } from "react";
import type { PageKey } from "../view";
import { BuddyPage } from "./BuddyPage";
import { ConnectionsTabPage, SkillsTabPage } from "./CustomizePage";
import { MaterialsPage } from "./MaterialsPage";
import { MemoryPage } from "./MemoryPage";
import { MonthPage } from "./MonthPage";
import type { MonthExtras } from "./monthLive";
import { PreferencesPage } from "./PreferencesPage";
import { ProfilePage } from "./ProfilePage";

export type SecondaryPageProps = { go: (href: string) => void };
/** onHead：月份页在复盘期间换页头（标题「11 月复盘」、右边淡色小字和「与伙伴讨论」），null 换回默认。 */
export type MonthHead = { title: string; trail: ReactNode };
/** today：服务端的今天（YYYY-MM-DD，计划里的 today），判这个月在不在复盘；没有用这台电脑的钟。 */
/** extras：只有当月有（来自首页数据），见 monthLive.tsx。onChanged：就地改了验收时间点、去向以后，外壳刷新首页数据。 */
export type MonthPageProps = SecondaryPageProps & { period: string; today?: string | null; onHead?: (head: MonthHead | null) => void;
  extras?: (task: { taskId: string; missionId: string }) => MonthExtras; onChanged?: () => void };

export const SECONDARY_PAGES: Record<PageKey, ComponentType<SecondaryPageProps>> = {
  profile: ProfilePage,
  buddy: BuddyPage,
  connections: ConnectionsTabPage,
  roles: SkillsTabPage,
  materials: MaterialsPage,
  memory: MemoryPage,
  preferences: PreferencesPage,
};
export const MONTH_PAGE: ComponentType<MonthPageProps> | null = MonthPage;
