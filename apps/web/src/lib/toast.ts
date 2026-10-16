/**
 * 工作面底部的一行提示（成功、已撤回之类）。组件不必拿到 WorkspaceApi，派一个窗口事件即可；
 * 带 action 时提示里多一颗按钮（「撤销」），停留时间也长一些。
 */
export type ToastAction = { label: string; run: () => void | Promise<void> };
export type ToastDetail = { text: string; action?: ToastAction };

export const TOAST_EVENT = "workspace-toast";
/** 普通提示停 4 秒；带「撤销」的停 5 秒，和左栏会后事项的撤回窗口一致。 */
export const toastDuration = (toast: ToastDetail) => (toast.action ? 5000 : 4000);

export function showWorkspaceToast(detail: ToastDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ToastDetail>(TOAST_EVENT, { detail }));
}

/** 撤销之类发生在别的页面（比如已离开信号页、回到列表）：让外壳刷新当前路由的服务端数据。 */
export const REFRESH_EVENT = "workspace-refresh";
export function refreshWorkspace(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(REFRESH_EVENT));
}
