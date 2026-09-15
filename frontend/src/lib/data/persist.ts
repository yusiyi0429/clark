/**
 * 对象库的落盘。JSON 快照 + 原子写。
 *
 * 为什么不是 SQLite：store 已经是一个成型的对象图（24 个集合、互相引用）。
 * 拆成表要写 24 套读写加迁移，而实际对象量级是几十个议题。JSON 快照零 schema
 * 工作、store 的形状一个字不用改，等真需要多实例时换掉这个文件即可 —— 接口
 * 就这两个函数。
 *
 * 代价说清楚：单进程单写者。多副本部署时两个实例会互相覆盖。当前部署本来就是
 * 单副本（lib/asr/relay.ts 与 lib/stage/bus.ts 的进程内内存已经定了这个约束）。
 *
 * 指纹机制：快照里存一份「种子指纹」。种子文件一改，指纹就对不上，快照直接作废
 * 从种子重建 —— 否则改了种子却看不到变化，会排查很久。要保留旧快照设
 * TKOS_KEEP_SNAPSHOT=1。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DIR = process.env.TKOS_DATA_DIR || join(process.cwd(), ".data");
const FILE = join(DIR, "store.json");
const TMP = `${FILE}.tmp`;
const DEBOUNCE_MS = Number(process.env.TKOS_PERSIST_DEBOUNCE_MS ?? 800);

export const fingerprintOf = (value: unknown): string =>
  createHash("sha1").update(JSON.stringify(value)).digest("hex").slice(0, 16);

type Envelope = { fingerprint: string; savedAt: string; state: Record<string, unknown> };

/**
 * 种子已冻结 —— **上线那一刻之后，这台机器上的数据只由应用自己写**。
 *
 * 开发期「种子一改就重建」是对的：改了种子却看不到变化会排查很久。上线之后这条
 * 规则会反过来杀人：谁动一下种子文件（改个示例文案都算），下一次重启就把一号位
 * 真正录进去的议题、判断、决定**全部抹掉换回示例数据**，而日志里只有一行 warn。
 *
 * 所以这个开关不复用 `TKOS_KEEP_SNAPSHOT`（那是开发期「这一次先别重建」的临时
 * 手闸，名字也只说了「保留」）。这里要表达的是一条部署事实，而且要能被外面看见：
 * `/api/health` 报 `seedFrozen`，指纹对不上时再报一个 `seedDrift` —— 「线上跑的到底
 * 是真实数据还是示例数据」不该靠翻服务器日志来回答。
 */
export const seedFrozen = (): boolean => process.env.TKOS_SEED_FROZEN === "1";

/**
 * 快照里那份指纹和当前种子对不上。冻结之后这件事不再触发重建，但必须报出来。
 *
 * 三态，`null` 是「这个进程还没读过快照」：`/api/health` 无副作用、不碰 store，所以
 * 它可能比 store 的初始化先跑到。这时候报 `false` 是在说「查过了，没漂移」——
 * 一个假的否定，恰好否掉了这个字段唯一想说的那件事。
 */
let drift: boolean | null = null;
export const seedDrift = (): boolean | null => drift;

/**
 * 读回快照。指纹对不上、文件损坏、或根本没有 —— 都返回 null，调用方用种子。
 * 任何失败都不抛：起不来的服务比丢一次演示状态糟得多。
 */
export function loadSnapshot(fingerprint: string): Record<string, unknown> | null {
  // 落盘整个关掉、或者压根没有快照：查过了，没有漂移可言 —— 是 false，不是「不知道」。
  if (process.env.TKOS_PERSIST === "0") {
    drift = false;
    return null;
  }
  try {
    if (!existsSync(FILE)) {
      drift = false;
      return null;
    }
    const env = JSON.parse(readFileSync(FILE, "utf8")) as Envelope;
    drift = env.fingerprint !== fingerprint;
    if (drift && seedFrozen()) {
      /*
       * 冻结之后照旧快照跑，但要喊出来：种子被改过，而那次改动**不会生效**。
       * 不喊的话，「我改了种子怎么没变」和「线上数据被抹了」是同一个沉默。
       */
      console.warn(
        `[tkos:persist] 种子已冻结（TKOS_SEED_FROZEN=1），但种子文件被改过` +
          `（快照 ${env.fingerprint} ≠ 当前 ${fingerprint}）。照旧快照跑，这次种子改动不生效。` +
          `确实要换成新种子：先把 ${FILE} 挪走。`
      );
    }
    if (drift && !seedFrozen() && process.env.TKOS_KEEP_SNAPSHOT !== "1") {
      console.warn(
        `[tkos:persist] 种子已变（快照 ${env.fingerprint} ≠ 当前 ${fingerprint}），` +
          `丢弃 ${FILE} 从种子重建。要保留旧快照设 TKOS_KEEP_SNAPSHOT=1；` +
          `上线机器请设 TKOS_SEED_FROZEN=1（那之后永不重建）。`
      );
      return null;
    }
    console.log(`[tkos:persist] 从 ${FILE} 恢复（存于 ${env.savedAt}）`);
    return env.state;
  } catch (err) {
    console.warn(`[tkos:persist] 读取 ${FILE} 失败，改用种子：`, err);
    return null;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: (() => Envelope) | null = null;

function flush(): void {
  const build = pending;
  pending = null;
  timer = null;
  if (!build) return;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    // 先写临时文件再 rename —— 中途崩溃不会留下半个 JSON。
    writeFileSync(TMP, JSON.stringify(build()), "utf8");
    renameSync(TMP, FILE);
  } catch (err) {
    console.warn("[tkos:persist] 落盘失败：", err);
  }
}

/** 防抖落盘。写操作后调用；连续操作合并成一次写。 */
export function scheduleSave(build: () => Envelope): void {
  if (process.env.TKOS_PERSIST === "0") return;
  pending = build;
  if (timer) return;
  timer = setTimeout(flush, DEBOUNCE_MS);
  // 别让这个定时器把进程吊着不退出。
  if (typeof timer === "object" && timer && "unref" in timer) (timer as NodeJS.Timeout).unref();
}

/** 进程退出前把最后一次写落下去。 */
export function flushNow(): void {
  if (timer) clearTimeout(timer);
  flush();
}
