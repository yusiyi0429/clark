import type { MetadataRoute } from "next";

/**
 * 手机上「添加到主屏幕」、电脑上 Chrome「安装天枢」：独立窗口打开，顶栏和启动底色跟手持首页的深色画布一致。
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
    background_color: "#141c30",
    theme_color: "#1b2543",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
