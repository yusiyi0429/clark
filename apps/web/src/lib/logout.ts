/** 退出登录：清掉会话后回锁屏（replace，不留当前页历史）。接口失败也回锁屏，下次进入时会话校验会再拦一次。 */
export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
  window.location.replace("/access");
}
