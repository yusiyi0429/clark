"use client";

import { ActionNoticeCard, type ActionNotice } from "@/components/ActionNoticeCard";

/** 卡里唯一一行：点了去 M2。M2 是另一个应用，整页跳过去（go 由调用方给，测试里换成记录）。 */
export function m2EntryNotices(go: (href: string) => void): ActionNotice[] {
  return [{ id: "m2-entry:open", title: "复盘与拆解", detail: "", onOpen: () => go("/m2/"), buttons: [] }];
}

/** 通知栏里去 M2（目标拆解与协作）的入口：M2 对当前登录人可用时出一张卡，不是待办，不出条数角标。 */
export function M2EntryNotice({ available }: { available: boolean }) {
  if (!available) return null;
  return <ActionNoticeCard id="m2-entry" title="目标拆解与协作" mark="monthly" counted={false}
    notices={m2EntryNotices((href) => window.location.assign(href))} onSettled={() => undefined} />;
}
