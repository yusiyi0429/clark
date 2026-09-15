import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 这一次请求是谁在调。
 *
 * `role` 只有两档，因为授权只有两档（spec §4.4 的可见性表）。不做角色继承、
 * 不做权限位 —— C-1 已定：只做够用的那一层。
 */
export type Actor = { personId: string; role: "ceo" | "dri" };

/**
 * 为什么是 AsyncLocalStorage 而不是把 actor 当参数传下去：`store.ts` 里 70 处
 * 调用点、40 处 useResource 的签名全靠「一个字不改」才成立（见 client.ts 文件头）。
 * 加一个首参会把这条链路上的每个方法、每个视图一起改掉。
 */
const storage = new AsyncLocalStorage<Actor>();

export function runAsActor<T>(actor: Actor, fn: () => T): T {
  return storage.run(actor, fn);
}

/**
 * 没有作用域时返回 null，**不在这里回落成一号位**。回落是产品判断（vitest、
 * 脚本、后台结算都没有请求身份），归 `store.ts` 的 `viewer()` 决定；这一层
 * 只如实说「这一次没有身份」。
 */
export function currentActor(): Actor | null {
  return storage.getStore() ?? null;
}
