"use client";

/**
 * 左栏最底下的本人一行和个人菜单（新首页设计 9.4、5.4.2「本人行」、5.4.6「个人菜单」）：
 * - 这一行：头像 24 + 名字；连接要处理时（本机离线、额度用完、飞书授权失效）名字后面一个 6px 琥珀点。整行就是菜单的开关。
 * - 菜单从这一行向上弹出：头像和资料 · 伙伴 · 连接和技能 · 我的记忆 · 偏好 ·
 *   切换到 CEO 工作台（双角色）· 管理员（管理员）· 锁屏 · 退出登录；最后一行淡色版本号。菜单项不放图标；键盘交给 HeroUI 的菜单。
 * 锁屏（设计 19 节第 8 条）：天枢不自动锁，本人点了才锁；和退出登录走同一个接口、回登录页，这台电脑「认得你」的那份（lastLogin）不清。
 * 快捷键 Ctrl+Shift+L（Mac 上 Cmd+Shift+L），哪里都能按。
 * 头像和资料、伙伴、连接和技能、我的记忆、偏好是新首页里的二级页（连接和技能一项，老的 roles 页键也开它）；管理员还是老页面，点了离开新首页。
 * 「任务数据质量」不放进新首页的菜单（用户 11/08 定）：老菜单、/me/task-quality 页面和接口都留着，要用随时能放回来。
 * 雷达、定时任务不上（17.2）：不放进菜单（老页面的路由先不动）；「更多」里只剩一项，就不要「更多」这一层。
 */
import { useEffect, useState } from "react";
import { Dropdown } from "@heroui/react";
import { avatarInitial, useBuildVersion, type Account } from "@/components/AccountMenu";
import { PersonAvatar } from "@/components/avatar/PersonAvatar";
import { browserApi } from "@/lib/api/client";
import { logout } from "@/lib/logout";
import { PAGE_TITLE, pageHref, type PageKey, type View } from "./view";
import h from "@/styles/home.module.css";

type Extra = { switchView: boolean; admin: boolean };

/** 锁屏的快捷键：Ctrl+Shift+L（Mac 上 Cmd+Shift+L）；打字合成中不算。 */
export const isLockKey = (event: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "isComposing">) =>
  !event.isComposing && event.shiftKey && !event.altKey && (event.ctrlKey !== event.metaKey) && event.code === "KeyL";

export function PersonRow({ account, view, alert, go }: {
  account: Account;
  view: View;
  /** 连接要处理（本机离线、额度用完、飞书授权失效）。 */
  alert: boolean;
  go: (href: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [extra, setExtra] = useState<Extra>({ switchView: false, admin: false });
  const version = useBuildVersion();
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    void browserApi.GET("/api/auth/session").catch(() => null).then((session) => {
      const authed = session?.response.ok && session.data?.authenticated ? session.data : null;
      setExtra({ switchView: Boolean(authed?.canSwitchView), admin: Boolean(authed && "admin" in authed && authed.admin) });
    });
  };
  const switchView = async () => {
    const { response } = await browserApi.POST("/api/auth/view", { body: { view: "ceo" } });
    if (response.ok) window.location.assign("/");
  };
  const act = (key: string) => {
    if (key === "logout" || key === "lock") { void logout(); return; }
    if (key === "switch") { void switchView(); return; }
    if (key in PAGE_TITLE) { go(pageHref(key as PageKey)); return; }
    const out: Record<string, string> = { admin: "/me/admin" };
    if (out[key]) go(out[key]);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isLockKey(event)) { event.preventDefault(); void logout(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const current = view.kind === "page" ? (view.page === "roles" ? "connections" : view.page) : null;
  const subtitle = [account.loginId, account.role === "ceo" ? "CEO" : "成员"].filter(Boolean).join(" · ");
  // 名字明写成显示的文字：两个字的（伙伴、锁屏…）只靠内容算名字时，无障碍树里读不到。快捷键不进名字。
  const item = (id: string, label: string) => (
    <Dropdown.Item id={id} textValue={label} aria-label={label} className={h.menuItem} data-current={current === id ? "" : undefined}>{label}</Dropdown.Item>
  );
  return (
    <div className={h.me}>
      <Dropdown isOpen={open} onOpenChange={onOpenChange}>
        <Dropdown.Trigger className={h.meRow} aria-label={`${account.displayName}，打开个人菜单`} data-current={open || current ? "" : undefined} data-testid="person-row">
          <PersonAvatar personId={account.personId} className={h.meAvatar}>{avatarInitial(account.displayName)}</PersonAvatar>
          <span className={h.meName}>{account.displayName}</span>
          {alert ? <i className={h.warnDot} aria-label="连接要处理" role="img" /> : null}
        </Dropdown.Trigger>
        <Dropdown.Popover placement="top start" offset={8} className={h.pop}>
          <Dropdown.Menu aria-label="个人菜单" className={h.menuList} onAction={(key) => act(String(key))}>
            <Dropdown.Section className={h.menuSection}>
              <Dropdown.Item id="profile" textValue="头像和资料" className={h.menuWho} data-current={current === "profile" ? "" : undefined}>
                <PersonAvatar personId={account.personId} className={h.meAvatar}>{avatarInitial(account.displayName)}</PersonAvatar>
                <span className={h.menuWhoText}><b>{account.displayName}</b>{subtitle ? <small>{subtitle}</small> : null}</span>
              </Dropdown.Item>
              {item("buddy", "伙伴")}
              {item("connections", "连接和技能")}
              {item("memory", "我的记忆")}
              {item("preferences", "偏好")}
            </Dropdown.Section>
            {extra.switchView || extra.admin ? (
              <Dropdown.Section className={h.menuSection}>
                {extra.switchView ? item("switch", "切换到 CEO 工作台") : null}
                {extra.admin ? item("admin", "管理员") : null}
              </Dropdown.Section>
            ) : null}
            <Dropdown.Section className={h.menuSection}>
              {item("lock", "锁屏")}
              {item("logout", "退出登录")}
            </Dropdown.Section>
          </Dropdown.Menu>
          {version ? <p className={h.menuVersion}>{version}</p> : null}
        </Dropdown.Popover>
      </Dropdown>
    </div>
  );
}
