"use client";

/**
 * 新骨架（V2 设计第 11.1、19.6 节，原型 v8.4）：左边一条图标栏（对话、本月、岗位、插件，最下面是头像菜单），右边一次放一页。
 * 959 及以下没有图标栏，底部三个标签：伙伴、本月、我（岗位从「我」进）。分界和现在的手持、工作台一致。
 * 老首页 /me 不动，新骨架的页面都在这里面；本机程序的连接整个骨架共用一份。
 */
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Check, CircleUserRound, MessageCircle, PanelsTopLeft, Shapes, Smile, UsersRound } from "lucide-react";
import { AccountMenu, type Account } from "@/components/AccountMenu";
import { LocalRunnerProvider } from "@/lib/local/LocalRunnerProvider";
import { TOAST_EVENT, toastDuration, type ToastDetail } from "@/lib/toast";
import s from "@/styles/v2-shell.module.css";

export type V2Section = "chat" | "month" | "team" | "plugins";

export function sectionOf(pathname: string): V2Section {
  if (pathname.startsWith("/me/plugins")) return "plugins";
  if (pathname.startsWith("/me/team")) return "team";
  if (pathname.startsWith("/me/month") || pathname.startsWith("/me/cards")) return "month";
  return "chat";
}

const RAIL: { section: V2Section; href: string; label: string; icon: typeof MessageCircle }[] = [
  { section: "chat", href: "/me/chat", label: "对话", icon: MessageCircle },
  { section: "month", href: "/me/month", label: "本月", icon: PanelsTopLeft },
  { section: "team", href: "/me/team", label: "岗位", icon: UsersRound },
  { section: "plugins", href: "/me/plugins", label: "插件", icon: Shapes },
];
const TABS: { section: V2Section; href: string; label: string; icon: typeof MessageCircle }[] = [
  { section: "chat", href: "/me/chat", label: "伙伴", icon: Smile },
  { section: "month", href: "/me/month", label: "本月", icon: PanelsTopLeft },
  { section: "plugins", href: "/me/plugins", label: "我", icon: CircleUserRound },
];

export function V2Shell({ account, children }: { account: Account; children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const section = sectionOf(pathname);
  return (
    <LocalRunnerProvider>
      <div className={s.app} data-section={section} data-testid="v2-shell">
        <nav className={s.rail} aria-label="导航">
          {RAIL.map((item) => (
            <Link key={item.section} href={item.href} className={s.railItem} aria-current={section === item.section ? "page" : undefined} aria-label={item.label} title={item.label}>
              <item.icon size={19} strokeWidth={1.8} aria-hidden />
            </Link>
          ))}
          <span className={s.grow} />
          <div className={s.me}><AccountMenu account={account} compact onNavigate={(href) => router.push(href)} /></div>
        </nav>
        <main className={s.main}>{children}</main>
        <nav className={s.tabs} aria-label="切换">
          {TABS.map((item) => (
            <Link key={item.section} href={item.href} className={s.tab} aria-current={section === item.section || (item.section === "plugins" && section === "team") ? "page" : undefined}>
              <item.icon size={21} strokeWidth={1.7} aria-hidden />{item.label}
            </Link>
          ))}
        </nav>
        <ShellToast />
      </div>
    </LocalRunnerProvider>
  );
}

/** 底部一行提示：和老工作台同一个事件（showWorkspaceToast），样子照它。 */
export function ShellToast() {
  const [toast, setToast] = useState<ToastDetail | null>(null);
  useEffect(() => {
    const shown = (event: Event) => {
      const detail = (event as CustomEvent<ToastDetail>).detail;
      if (detail?.text) setToast(detail);
    };
    window.addEventListener(TOAST_EVENT, shown);
    return () => window.removeEventListener(TOAST_EVENT, shown);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toastDuration(toast));
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  return (
    <div className={s.toast} role="status">
      <Check size={15} aria-hidden />
      <span>{toast.text}</span>
      {toast.action ? <button type="button" className={s.toastAction} onClick={() => { const action = toast.action; setToast(null); void action?.run(); }}>{toast.action.label}</button> : null}
    </div>
  );
}
