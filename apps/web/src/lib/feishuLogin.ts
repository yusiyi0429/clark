import { browserApi } from "@/lib/api/client";

/** 飞书网页应用 JSSDK（提供 window.h5sdk 与 window.tt）。只在飞书客户端里加载。 */
const FEISHU_H5_SDK = "https://lf1-cdn-tos.bytegoofy.com/goofy/lark/op/h5-js-sdk-1.5.26.js";

type CodeCallbacks = { success: (res: { code: string }) => void; fail: (err: { errno?: number; errString?: string }) => void };
type FeishuWindow = Window & {
  h5sdk?: { ready: (callback: () => void) => void; error?: (callback: (err: unknown) => void) => void };
  tt?: {
    requestAccess?: (options: { appID: string; scopeList: string[] } & CodeCallbacks) => void;
    requestAuthCode?: (options: { appId: string } & CodeCallbacks) => void;
  };
};

export type FeishuLoginResult = { ok: true; role?: "ceo" | "member"; onboarded?: boolean } | { ok: false; message: string };

/** 飞书桌面端与移动端的 UA 都带 Lark 或 Feishu。 */
export function inFeishuClient(userAgent: string): boolean {
  return /\b(Lark|Feishu)\b/i.test(userAgent);
}

function loadSdk(): Promise<FeishuWindow> {
  const win = window as FeishuWindow;
  if (win.h5sdk) return Promise.resolve(win);
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = FEISHU_H5_SDK;
    script.async = true;
    script.onload = () => (win.h5sdk ? resolve(win) : reject(new Error("飞书 JSSDK 加载失败")));
    script.onerror = () => reject(new Error("飞书 JSSDK 加载失败"));
    document.head.appendChild(script);
  });
}

/** h5sdk.ready 之后调 requestAccess；客户端低于 V6.9.0（errno 103）或 JSSDK 太旧时退回 requestAuthCode。 */
export function requestFeishuCode(win: FeishuWindow, appId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    win.h5sdk!.ready(() => {
      const fallback = () => {
        if (!win.tt?.requestAuthCode) return reject(new Error("飞书版本过低，无法免登"));
        win.tt.requestAuthCode({ appId, success: (res) => resolve(res.code), fail: () => reject(new Error("飞书授权没有完成")) });
      };
      if (!win.tt?.requestAccess) return fallback();
      win.tt.requestAccess({
        appID: appId,
        scopeList: [],
        success: (res) => resolve(res.code),
        fail: (err) => (err.errno === 103 ? fallback() : reject(new Error("飞书授权没有完成"))),
      });
    });
  });
}

/** 在飞书客户端里打开天枢时自动登录（调用方先用 inFeishuClient 判断）；未配置飞书时返回 null，照常显示口令登录。 */
export async function feishuAutoLogin(): Promise<FeishuLoginResult | null> {
  const { data: config } = await browserApi.GET("/api/auth/feishu/config");
  if (!config?.enabled || !config.appId) return null;
  try {
    const code = await requestFeishuCode(await loadSdk(), config.appId);
    const { data, error } = await browserApi.POST("/api/auth/feishu/code", { body: { code } });
    if (data) return { ok: true, role: data.role, onboarded: data.onboarded };
    return { ok: false, message: (error as { message?: string } | undefined)?.message ?? "飞书免登失败" };
  } catch (cause) {
    return { ok: false, message: (cause as Error).message || "飞书免登失败" };
  }
}

/** 已登录的人连接飞书：整页跳到飞书授权页，授权完回到 next（一般是当前页），不换会话。 */
export function feishuConnectHref(next: string): string {
  return `/api/auth/feishu/start?${new URLSearchParams({ connect: "1", next })}`;
}

/** 本人的飞书连好了没有；读不到时按没接飞书算，不出「连接飞书」。 */
export async function readFeishuConnection(): Promise<{ enabled: boolean; connected: boolean }> {
  try {
    const { data } = await browserApi.GET("/api/me/feishu");
    return data ?? { enabled: false, connected: false };
  } catch {
    return { enabled: false, connected: false };
  }
}
