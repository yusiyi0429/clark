/**
 * 壳的放行规则（不依赖 Electron，单测直接测）：
 * - 窗口里只能停在天枢和飞书登录授权的页面；别的链接（含飞书文档）一律用系统浏览器打开。
 * - 「本地网络访问」这类权限只给天枢自己的来源；别的权限一律不给（网页本来也用不到摄像头、定位这些）。
 */

/**
 * 飞书、Lark 的登录和授权页。11/08 实测 /api/auth/feishu/start 的跳转链：accounts.feishu.cn（authorize）→ passport.feishu.cn
 * → accounts.feishu.cn → login.feishu.cn（trap）→ accounts.feishu.cn 扫码页；授权页本身在 open.feishu.cn。Lark 照同样的几个。
 * 文档、知识库不在里面，走系统浏览器。
 */
const FEISHU_AUTH_HOSTS = [
  "accounts.feishu.cn", "passport.feishu.cn", "login.feishu.cn", "open.feishu.cn",
  "accounts.larksuite.com", "passport.larksuite.com", "login.larksuite.com", "open.larksuite.com",
];

export interface Policy {
  /** 天枢的来源，如 https://tk.tokenkingos.com。 */
  origin: string;
}

const parse = (url: string): URL | null => {
  try { return new URL(url); } catch { return null; }
};

/** 是不是天枢自己的页面。 */
export function isTianshu(p: Policy, url: string): boolean {
  return parse(url)?.origin === p.origin;
}

/** 窗口里能不能停在这个地址：天枢，或飞书登录授权页（只认 https）。 */
export function allowInWindow(p: Policy, url: string): boolean {
  const u = parse(url);
  if (!u) return false;
  if (u.origin === p.origin) return true;
  return u.protocol === "https:" && FEISHU_AUTH_HOSTS.includes(u.hostname);
}

/** 不能在窗口里开的，能不能交给系统浏览器：只交 http、https、mailto，别的协议（file:、自定义协议）不碰。 */
export function openExternally(url: string): boolean {
  const u = parse(url);
  return !!u && ["http:", "https:", "mailto:"].includes(u.protocol);
}

/**
 * 本地网络访问：只给天枢自己的页面。权限名是 11/08 在 Electron 45（Chromium 156）里实测看到的三个。
 * 实测这几个权限只影响网页查到的状态（navigator.permissions），不真拦请求：判「拒绝」时连 127.0.0.1 照样 200。
 * 挡别的页面靠本机程序自己的 Origin 白名单和口令；这里放行天枢，是让网页查状态时看到「已允许」、不出授权引导。
 * 检查时给的 origin 带结尾的斜杠（https://tk.tokenkingos.com/），按 URL 解析后比来源。
 */
const LOCAL_NETWORK = /^(local-network-access|local-network|loopback-network)$/;

export function grantPermission(p: Policy, permission: string, requestingUrl: string): boolean {
  return LOCAL_NETWORK.test(permission) && isTianshu(p, requestingUrl);
}
