/**
 * 新首页 /me/work 按人打开（V2 设计第 20.4 节，先给铭泽、创峰）：环境变量 TIANSHU_WORK_PEOPLE 写 personId，逗号隔开。
 * 没设时开发环境人人能开，正式环境谁都没有。只在服务端读。
 */
export function workEnabledFor(personId: string, env: Record<string, string | undefined> = process.env): boolean {
  const list = env.TIANSHU_WORK_PEOPLE;
  if (list === undefined) return env.NODE_ENV !== "production";
  return list.split(",").map((entry) => entry.trim()).filter(Boolean).includes(personId);
}
