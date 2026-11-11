import type { MetadataRoute } from "next";
import { THEME_COLOR } from "@/lib/appearanceScript";

/**
 * 手机上「添加到主屏幕」、电脑上 Chrome「安装天枢」：独立窗口打开。清单只能写一个颜色：顶栏和启动底色用深色那一套的底色，
 * 页面一加载就由 theme-color 换成当前外观的（lib/appearanceScript.ts）。
 * id 固定成 "/"：以后改 start_url 也还是同一个应用；scope 是整个站点，装好的窗口里点进任何页面都不跳回浏览器。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "天枢",
    short_name: "天枢",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // 托盘、开始菜单再点一次：已开着的应用窗口带到前面，不另开一个
    launch_handler: { client_mode: "focus-existing" },
    background_color: THEME_COLOR.dark,
    theme_color: THEME_COLOR.dark,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
