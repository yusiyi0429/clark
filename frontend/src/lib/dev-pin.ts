/**
 * 开发期把几样东西**钉在进程上**，不让它们跟着模块重新求值一起换新。
 *
 * ## 这个文件为什么存在
 *
 * `next dev` 改一个服务端文件就重编译一次，而重编译**不保证**整张模块图一起换新：
 * 库那一份（`data/store.ts`）可能被换掉、任务表（`agent/tasks.ts`）留着，也可能反过来。
 * 两份文件各自的注释里都写着这件事，而它们各自的防法都是「认出来，然后停下」——
 * 认出来之后能做的只有把那一轮判成没跑完，因为**那一轮的产物落在被换掉的那个对象上**，
 * 新的这一份根本够不着。
 *
 * 2026-09-01 的 ISS-222 是这条路上最贵的一次：一轮 18 分钟的深研走到最后一步，报告写进
 * 了上一份 `store`，新的那一份看不见它；任务表恰好是留着的那一份，于是它翻成 `done`，
 * 而 `ensureDeepResearch` 只拦 `failed` —— 在上一轮刚跑完那一刻又起了一轮真花钱的深研。
 * 一号位看到的是「深研到最后一步又重新跑了」，而那份写完的报告一个字都没留下。
 *
 * 钉住之后这一整类事不再发生：换掉的只是代码，那几样状态还是同一个对象。
 *
 * ## 只在开发期
 *
 * 热重载只存在于 `next dev`，所以默认只在 `NODE_ENV === "development"` 时钉。生产上
 * 这个文件整个是空转（模块只求值一次，钉不钉都一样）；单测里也默认不钉 —— 那边靠
 * `vi.resetModules()` 拿一份干净的库，钉住会让「第二程」读到第一程的东西。
 *
 * `TKOS_DEV_PIN=1` / `=0` 显式开关，给那两种环境里要验这条路的测试用。
 *
 * ## 钉住的东西放在哪
 *
 * `globalThis.__tkosDevPins`，一张明写出来的表。不藏在闭包里是有意的：测试要能只摘掉
 * 其中一样（「库被换掉了、任务表留着」就是这么摆出来的），而藏起来的话那种组合根本
 * 摆不出来 —— 于是最贵的那条路上永远没有测试。
 */

const on = (): boolean =>
  process.env.TKOS_DEV_PIN === "1" ||
  (process.env.TKOS_DEV_PIN !== "0" && process.env.NODE_ENV === "development");

type Pins = Map<string, unknown>;

const holder = globalThis as typeof globalThis & { __tkosDevPins?: Pins };

const pins = (): Pins => (holder.__tkosDevPins ??= new Map());

/** 上一程钉住的那一份。没有（或者这一程不钉）就是 `null` —— 调用方按「头一程」走。 */
export function readPin<T>(key: string): T | null {
  if (!on()) return null;
  return (pins().get(key) as T | undefined) ?? null;
}

/** 钉住这一份，并**原样返回它** —— 调用方那一行就是 `const x = readPin(k) ?? writePin(k, make())`。 */
export function writePin<T>(key: string, value: T): T {
  if (on()) pins().set(key, value);
  return value;
}
