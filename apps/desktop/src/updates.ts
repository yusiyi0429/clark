import { autoUpdater } from "electron-updater";

/**
 * 自动更新（设计稿 17.5）：从下载源（electron-builder 的 publish，generic）拉 latest.yml，后台下好新版；
 * 不自己换——等本人在托盘点「重启换新版本」（没有卡在跑时才能点），或下次退出时顺手装上。内部版不签名，不校验发布者。
 * TIANSHU_DESKTOP_UPDATE_URL 可换下载源（测试用本地的）。只在装好的版本里开。
 */
export class Updates {
  /** 下好的新版本号；没有为 null。 */
  downloaded: string | null = null;

  constructor(private readonly onChange: () => void) {}

  start(feedUrl?: string): void {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false; // 退出走壳自己的流程（先停本机程序），在那里装
    if (feedUrl) autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
    autoUpdater.on("update-downloaded", (info) => { this.downloaded = info.version; this.onChange(); });
    autoUpdater.on("error", (e) => console.log(`[桌面版] 检查更新没成：${e instanceof Error ? e.message : String(e)}`));
    const check = () => { autoUpdater.checkForUpdates().catch(() => undefined); };
    check();
    setInterval(check, 6 * 60 * 60 * 1000).unref();
  }

  /** 装上下好的新版（静默）；relaunch：装完再打开。调用前本机程序要已停。 */
  install(relaunch: boolean): void {
    autoUpdater.quitAndInstall(true, relaunch);
  }
}
