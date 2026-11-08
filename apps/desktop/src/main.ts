import { app, BrowserWindow, session, shell } from "electron";
import { allowInWindow, grantPermission, isTianshu, openExternally, type Policy } from "./policy";

/**
 * 天枢桌面版的壳（设计稿 17.5 / 17.7）：一个窗口开线上天枢，窗口里只停天枢和飞书登录授权页，别的链接交给系统浏览器。
 * 线上网页拿不到 Node：不开 nodeIntegration、开 contextIsolation 和 sandbox、不挂 preload。本机能力只经 127.0.0.1 那套（Origin、口令、本机确认）。
 * 本机程序、托盘、开机自启、自动更新在后面几天接上。
 */

/** 天枢的来源。开发时可用 TIANSHU_DESKTOP_ORIGIN 指到别的环境（只认 https，和本机程序的 Origin 白名单对得上才连得上本机）。 */
const ORIGIN = (() => {
  const raw = process.env.TIANSHU_DESKTOP_ORIGIN ?? "https://tk.tokenkingos.com";
  const u = new URL(raw);
  if (u.protocol !== "https:") throw new Error("TIANSHU_DESKTOP_ORIGIN 只能是 https");
  return u.origin;
})();
const policy: Policy = { origin: ORIGIN };
/** 登录状态单独存一份（不和浏览器共用），重启后还在。 */
const PARTITION = "persist:tianshu";

let win: BrowserWindow | null = null;

/** 连不上天枢时显示的页（本地的，不带脚本以外的东西）；「重试」回到天枢首页。 */
function offlinePage(reason: string): string {
  const html = `<!doctype html><meta charset="utf-8"><title>天枢</title>
<body style="font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#333">
<div style="text-align:center"><p>连不上天枢</p><p style="color:#888;font-size:13px">${reason.replace(/[<>&]/g, "")}</p>
<button onclick="location.href='${ORIGIN}/'" style="padding:6px 18px">重试</button></div>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function guard(ses: Electron.Session) {
  // 网页靠 UA 里的 TianshuDesktop/<版本> 认出是在桌面版里（不再提示装本机程序）；不给网页挂任何桥
  ses.setUserAgent(`${ses.getUserAgent()} TianshuDesktop/${app.getVersion()}`);
  // 权限：只给天枢页面本地网络访问，别的一律不给（Electron 默认是全给）
  ses.setPermissionRequestHandler((_wc, permission, done, details) => done(grantPermission(policy, permission, details.requestingUrl ?? "")));
  ses.setPermissionCheckHandler((_wc, permission, origin) => grantPermission(policy, permission, origin));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 380, title: "天枢", autoHideMenuBar: true,
    webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const wc = win.webContents;
  // 窗口里只停天枢和飞书登录授权页；别的交给系统浏览器
  const onNavigate = (e: Electron.Event, url: string) => {
    if (url.startsWith("data:text/html") || allowInWindow(policy, url)) return;
    e.preventDefault();
    if (openExternally(url)) void shell.openExternal(url);
  };
  wc.on("will-navigate", onNavigate);
  wc.on("will-redirect", onNavigate);
  // 新窗口一律不开：天枢的页面在本窗口打开，别的交给系统浏览器
  wc.setWindowOpenHandler(({ url }) => {
    if (isTianshu(policy, url)) void wc.loadURL(url);
    else if (openExternally(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    // -3 是被下一次跳转取消，不算连不上
    if (isMainFrame && code !== -3 && isTianshu(policy, url)) void wc.loadURL(offlinePage(desc));
  });
  void wc.loadURL(`${ORIGIN}/`);
}

// 单实例：再打开一次只是把窗口叫出来
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.whenReady().then(() => {
    guard(session.fromPartition(PARTITION));
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
