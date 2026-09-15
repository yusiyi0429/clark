/**
 * 座位 —— 验完口令之后，这个人坐在哪一侧。
 *
 * ## 它不是权限
 *
 * 这一版一把共享口令开两个空间（`src/proxy.ts` 里一号位那把口令一过就放行，对路径
 * 不做判断）。所以座位答的是「你现在坐在哪个位置上」，不是「你有没有资格」——
 * 坐在秘书位上的人只要知道 `/` 这个地址，照样进得去一号位那一侧。
 *
 * 把这句话写在这里，是因为下一个人看到一个叫 `seat` 的 cookie 时最自然的假设恰好
 * 是反的。真要立边界时的落点不在这个文件：给秘书发独立口令、人表里加一个
 * `role: "secretary"` 的人、`METHOD_SCOPE` 加一档、`api/data/route.ts` 那句
 * `scope !== actor.role` 改成按角色集合判。
 *
 * ## 为什么 httpOnly
 *
 * 屏幕上没有任何一处需要在浏览器里读它：一号位那一侧的页面全在 `(tkos)` 下、秘书
 * 那一侧全在 `/sec` 下，**路由本身就蕴含了座位**。所以它只在服务端被读一次
 * （`/access` 那一页拿它把滑块拨到上次的位置），拿不到 JS 那一侧去。
 */

export const SEAT_COOKIE_NAME = "tkos_seat";

/** 一个月。它只是个偏好，过期了重新选一次就是，不必和口令那 12 小时同寿。 */
export const SEAT_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export type Seat = "ceo" | "sec";

/**
 * 把任意一个值收敛成座位。**入参一律不可信** —— 它来自 cookie 和 POST body。
 *
 * 不做大小写宽容、不 trim：这个值是我们自己写进 cookie、自己从滑块发出去的，
 * 两头都只会是那两个字符串。宽容会让「读到了一个我们没写过的值」这件事悄悄消失，
 * 而那件事本身就是信号。
 */
export function seatFrom(candidate: unknown): Seat {
  return candidate === "sec" ? "sec" : "ceo";
}

/** 这个座位验完口令之后落到哪一页。 */
export function landingFor(seat: Seat): string {
  return seat === "sec" ? "/sec" : "/";
}
