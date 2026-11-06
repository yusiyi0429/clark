/**
 * 二级页的键、标题和地址（新首页设计 9.4、5.4.6）。服务端页面也要读，所以不放在带客户端钩子的 view.ts 里。
 * 组件由 W2 交（components/home/pages），挂在展示区里。
 */
export const PAGE_KEYS = ["profile", "buddy", "connections", "preferences"] as const;
export type PageKey = (typeof PAGE_KEYS)[number];
export const PAGE_TITLE: Record<PageKey, string> = { profile: "头像和资料", buddy: "伙伴", connections: "连接", preferences: "偏好" };
export const pageHref = (page: PageKey) => `/me/work/settings/${page}`;
export const monthHref = (period: string) => `/me/work/month/${period}`;
export const isPage = (value: string | undefined): value is PageKey => !!value && (PAGE_KEYS as readonly string[]).includes(value);
