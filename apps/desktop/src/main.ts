import { app, BrowserWindow, dialog, Menu, nativeImage, session, shell, Tray } from "electron";
import { join } from "node:path";
import { allowInWindow, grantPermission, isTianshu, openExternally, type Policy } from "./policy";
import { RunnerHost, type TrayState } from "./runner";
import { dotBitmap, TRAY_COLORS, trayView, type TrayIcon } from "./trayView";
import { takeOverLegacy } from "./legacy";
import { Updates } from "./updates";

/**
 * 天枢桌面版的壳（设计稿 17.5 / 17.7）：一个窗口开线上天枢，窗口里只停天枢和飞书登录授权页，别的链接交给系统浏览器。
 * 线上网页拿不到 Node：不开 nodeIntegration、开 contextIsolation 和 sandbox、不挂 preload。本机能力只经 127.0.0.1 那套（Origin、口令、本机确认）。
 * 本机程序随包装好，由壳在 utilityProcess 里拉起；托盘、开机自启、单实例、自动更新由壳管；关窗口只是收进托盘。
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
/** 开机自启时带的参数：只进托盘，不弹窗口。 */
const HIDDEN_ARG = "--hidden";
/** 开机自启在注册表里的名字（HKCU\…\Run；卸载时按它删，见 resources/installer.nsh）。 */
const LOGIN_ITEM = "TianshuDesktop";
/** 本机程序：打包在 dist/runner 里；装好的版本从 asar 里解出来的那份跑（子进程读不了 asar）。 */
const RUNNER = join(__dirname, "runner", "hosted.cjs").replace(/app\.asar([\\/])/, "app.asar.unpacked$1");

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let trayState: TrayState | null = null;
let runnerError: string | null = null;
const updates = new Updates(() => refreshTray());
const runner = new RunnerHost(RUNNER, {
  tray: (s) => { trayState = s; runnerError = null; refreshTray(); },
  ready: () => { runnerError = null; refreshTray(); },
  failed: ({ code, message }) => {
    runnerError = code === "EADDRINUSE" ? "端口 47610 被别的程序占着" : message;
    refreshTray();
  },
  confirm: async (title, text) => {
    const opts = { type: "question" as const, title, message: text, buttons: ["是", "否"], defaultId: 1, cancelId: 1, noLink: true };
    const r = win && win.isVisible() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    return r.response === 0;
  },
  pickFolder: async () => {
    const opts = { title: "选一个给天枢用的文件夹", properties: ["openDirectory" as const] };
    const r = win && win.isVisible() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : r.filePaths[0] ?? null;
  },
});

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

function createWindow(show: boolean) {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 380, title: "天枢", autoHideMenuBar: true, show,
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
  // 关窗口只是收进托盘；托盘「退出」才真退
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
  });
  void wc.loadURL(`${ORIGIN}/`);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

const icons = new Map<TrayIcon, Electron.NativeImage>();
function icon(name: TrayIcon) {
  if (!icons.has(name)) icons.set(name, nativeImage.createFromBitmap(dotBitmap(TRAY_COLORS[name]), { width: 32, height: 32, scaleFactor: 2 }));
  return icons.get(name)!;
}

function refreshTray() {
  if (!tray) return;
  const v = trayView(trayState, runnerError);
  tray.setImage(icon(v.icon));
  tray.setToolTip(v.tooltip);
  // 新版本下好了：没有卡在跑时才能点「重启换新版本」（不打断正在跑的卡）
  const busy = (trayState?.running ?? 0) > 0;
  const update: Electron.MenuItemConstructorOptions[] = updates.downloaded
    ? [{ label: busy ? `新版本 ${updates.downloaded} 已下好，卡跑完再重启` : `重启换新版本 ${updates.downloaded}`, enabled: !busy, click: () => void quit(true) }, { type: "separator" }]
    : [];
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开天枢", click: showWindow },
    { label: v.pauseLabel, enabled: v.canPause, click: () => runner.menu(trayState?.paused ? "resume" : "pause") },
    { type: "separator" },
    ...update,
    { label: "退出", click: () => void quit() },
  ]));
}

/** 退出：本机程序先停掉会话进程再退；有下好的新版就顺手静默装上（relaunch：装完再打开，托盘「重启换新版本」走这条）。 */
async function quit(relaunch = false) {
  if (quitting) return;
  quitting = true;
  await runner.stop();
  tray?.destroy();
  if (updates.downloaded) updates.install(relaunch);
  else app.exit(0);
}

// 单实例：再打开一次只是把窗口叫出来
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(async () => {
    // 装好的桌面版才登记开机自启（开发时跑的是 electron.exe，不登记）；开机时只进托盘
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, args: [HIDDEN_ARG], name: LOGIN_ITEM });
    guard(session.fromPartition(PARTITION));
    tray = new Tray(icon("off"));
    tray.on("click", showWindow);
    refreshTray();
    createWindow(!process.argv.includes(HIDDEN_ARG));
    // 先接管脚本装的旧版（停掉它、删它的自启），再拉起随包的本机程序
    for (const line of await takeOverLegacy().catch(() => [])) console.log(`[桌面版] ${line}`);
    runner.start();
    if (app.isPackaged) updates.start(process.env.TIANSHU_DESKTOP_UPDATE_URL);
  });
  // 窗口收进托盘时不退出；退出只走托盘菜单
  app.on("window-all-closed", () => {});
  app.on("before-quit", (e) => {
    if (quitting) return;
    e.preventDefault();
    void quit();
  });
}
