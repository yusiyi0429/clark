import type { MetadataRoute } from "next";

/** 手机上「添加到主屏幕」：全屏打开，顶栏和启动底色跟手持首页的深色画布一致。 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "天枢",
    short_name: "天枢",
    start_url: "/",
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
