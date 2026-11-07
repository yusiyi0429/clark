/**
 * 二级页和月份页的挂载表（W 定挂载点，W2 交组件；设计 12.1、12.2）。
 *
 * 约定（W2 照这个交，合并时以 W2 的这个文件为准）：
 * - SECONDARY_PAGES[页]：头像和资料（profile）、伙伴（buddy）、连接（connections）、偏好（preferences）各一个组件；
 * - MONTH_PAGE：月份页（10.4、10.5）；
 * - 组件只画展示区里的内容（页头以下）：页头（标题、返回）、右栏、左栏由外壳画；导航用 props.go，地址见 view.ts 的 pageHref / monthHref。
 * 这里没有的页，外壳先放现有的老组件顶着（HomeShell 的 SecondaryFallback）。
 */
import type { ComponentType } from "react";
import type { PageKey } from "../view";

export type SecondaryPageProps = { go: (href: string) => void };
export type MonthPageProps = SecondaryPageProps & { period: string };

export const SECONDARY_PAGES: Partial<Record<PageKey, ComponentType<SecondaryPageProps>>> = {};
export const MONTH_PAGE: ComponentType<MonthPageProps> | null = null;
