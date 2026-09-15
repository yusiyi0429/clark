/**
 * 出口限速器。**所有出网调用共用的那一道闸。**
 *
 * ## 为什么按「出口」管，不按槽位、不按模型
 *
 * 限流池是上游那一头的东西：`alt`（claude-opus-5）和 `synth`（gpt-5.6）是两个槽位、两个
 * 家族，但它们走的是同一个网宿网关、同一把 `WANGSU_API_KEY` —— 上游数的是这一把 key 一分钟
 * 发了多少次，不管调用方管自己叫什么。按槽位分池的话，两个池各自都没超，合起来正好超一倍，
 * 而那件事在这一侧一个字都看不见。
 *
 * ## 它兜的是什么
 *
 * `complete.ts` 那条重发路**只补传输层**（连不上、fetch failed），4xx 一律不重发 —— 理由是
 * 「重发得到的是同一个答案，只是多付一次钱」。这句话对 400/401 成立，对 **429 不成立**：429
 * 说的不是「你要的东西不对」，是「位子没了」。所以在这个文件之前 429 等于失败，而失败落到
 * 链路上是两种静默降级：N3 抽取那一步读成「这一页抽不出来」（台账少几条证据），分节那一步
 * 读成「那一节没写成」（报告少一节）。两种在屏幕上都不像故障。
 *
 * 并发一开大，第一个坏掉的就是它。`sweep.ts` 的 `CHAIN_CONCURRENCY` 从前压在 2 上，注释写着
 * 「四条链全撒出去是二十个（并发抽取），撞上 429 之后重来一遍比排队慢」—— 这个文件存在的
 * 全部目的就是把那句话里的「排队」变成真的：**撞限时等一个位子，而不是失败**。
 *
 * ## 这几个默认值不是测出来的
 *
 * 是「不撞的下限」，保守猜的。各家控制台上的真值没人查过 —— 查到了就用下面那几个环境变量
 * 盖上，不必为此发一版。**撞了就调大，别改代码。**
 *
 *     TKOS_GATE_WANGSU=4/60     并发/每分钟；`0` = 那一项不限
 *     TKOS_GATE_ARK=12/300
 *     TKOS_GATE_DEEPSEEK=12/300
 *     TKOS_GATE_BOCHA=4/60
 *     TKOS_GATE_DOUBAO=4/60
 *
 * 解析不了（写成 `4`、`a/b`、负数）当没配，按默认值走，不抛 —— 一个笔误让每条出口一起停摆，
 * 代价比按保守值跑一轮大得多。
 *
 * ## 排队是先到先得，没有优先级
 *
 * 写手（一次几千 token 的出稿）和抽取（一页一次的小活）抢同一个池时先到先得。有优先级的
 * 版本以后再说 —— 现在加一个优先级字段等于替一个还不存在的需求先排好了顺序，而排错的
 * 表现是「出稿排在二十个抽取后面」，那要有实测才判得出来。
 *
 * ## 它是进程内的
 *
 * 单进程 `next dev` / 单机部署，进程内单例够用。**多实例部署时这一层要换成 Redis**：那时候
 * 每个实例各自按 4 并发放行，上游看到的是实例数乘以 4，而这个文件会一直报「没排队」。
 *
 * 钉在进程上（`dev-pin`）的理由和任务表一样：`next dev` 一次重编译可以只换掉这个模块，那时
 * 会出现两个限速器各放各的行 —— 合起来正好是限额的两倍，而两边各自都觉得自己没超。
 */
import { readPin, writePin } from "@/lib/dev-pin";

/**
 * 一个出口 = 一个限流池。**名字按出网的那一头取**，不按厂商取：`deepseek` 是官方直连那条
 * 回落（`slots.ts` 里那一支），它和方舟是两个账号、两个域名、两套配额，合成一个池会让
 * 「方舟满了」把直连那条也一起挡住。
 */
export type Outlet = "wangsu" | "ark" | "deepseek" | "bocha" | "doubao";

export type OutletLimit = {
  /** 同时在飞的请求数上限。`0` = 不限。 */
  concurrency: number;
  /** 每分钟请求数上限。`0` = 不限。 */
  perMinute: number;
};

/** 每分钟那道闸的窗口。滑动，不是固定窗 —— 见 `admissible`。 */
const WINDOW_MS = 60_000;

const DEFAULTS: Record<Outlet, OutletLimit> = {
  wangsu: { concurrency: 4, perMinute: 60 },
  ark: { concurrency: 12, perMinute: 300 },
  deepseek: { concurrency: 12, perMinute: 300 },
  bocha: { concurrency: 4, perMinute: 60 },
  doubao: { concurrency: 4, perMinute: 60 },
};

const ENV_OF: Record<Outlet, string> = {
  wangsu: "TKOS_GATE_WANGSU",
  ark: "TKOS_GATE_ARK",
  deepseek: "TKOS_GATE_DEEPSEEK",
  bocha: "TKOS_GATE_BOCHA",
  doubao: "TKOS_GATE_DOUBAO",
};

export const OUTLETS = Object.keys(DEFAULTS) as Outlet[];

/**
 * 上游回的 `Retry-After` 压进这个区间。
 *
 * 上限不是不信它，是这一轮有总时长（`a4/deadline.ts` 那 20 分钟）：一个 `Retry-After: 3600`
 * 照收的话，这一次调用会占着一个已经不属于它的余量睡一小时，而屏幕上写着「正在取证」。
 * 退避到点仍然 429 的那一次照旧抛 —— 那时候该做的是调大限额，不是等得更久。
 */
export const COOLDOWN_MIN_MS = 1_000;
export const COOLDOWN_MAX_MS = 60_000;

type Waiter = {
  admit: () => void;
  /** 中止时把自己从队里摘掉。摘不掉的表现是队头永远是一个没人接的位子。 */
  drop: (e: Error) => void;
  dead: boolean;
};

type Pool = {
  inFlight: number;
  queue: Waiter[];
  /** 最近这一分钟里每一次**放行**的时刻。滑动窗口就是这个数组。 */
  stamps: number[];
  /** 退避到几点（epoch ms）。`0` = 没在退避。 */
  coolUntil: number;
  timer: ReturnType<typeof setTimeout> | null;
};

type Gate = Record<Outlet, Pool>;

const makePool = (): Pool => ({ inFlight: 0, queue: [], stamps: [], coolUntil: 0, timer: null });

const gate: Gate =
  readPin<Gate>("model-gate") ??
  writePin("model-gate", Object.fromEntries(OUTLETS.map((o) => [o, makePool()])) as Gate);

/**
 * 这个出口此刻的限额。**在取用时读**，不在模块加载时定死 —— 定死的表现是 `.env` 改了、
 * 进程没重启的话仍然按旧数放行，而日志里看不出来。
 */
export function limitOf(outlet: Outlet): OutletLimit {
  const raw = (process.env[ENV_OF[outlet]] ?? "").trim();
  if (!raw) return DEFAULTS[outlet];
  const m = raw.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (!m) {
    console.warn(
      `[tkos:gate] ${ENV_OF[outlet]}=「${raw}」不认识，要的是「并发/每分钟」这种两个数，` +
        `例如 ${DEFAULTS[outlet].concurrency}/${DEFAULTS[outlet].perMinute}。这一项按默认值走。`,
    );
    return DEFAULTS[outlet];
  }
  return { concurrency: Number(m[1]), perMinute: Number(m[2]) };
}

/** 掉出窗口的那些时刻扔掉。滑动窗口的全部实现就是这一句。 */
const prune = (p: Pool, now: number): void => {
  const from = now - WINDOW_MS;
  let i = 0;
  while (i < p.stamps.length && p.stamps[i] <= from) i += 1;
  if (i) p.stamps.splice(0, i);
};

/**
 * 现在放得出下一个吗？放不出就回「等到几点再问」（`at: 0` = 等别人还位子，没有时刻可等）。
 *
 * 每分钟那道闸用**滑动**窗口而不是固定窗：固定窗在整点前后会放行两倍（上一格末尾发满、
 * 下一格开头再发满），而上游数的正是任意连续 60 秒。
 */
const admissible = (
  p: Pool,
  lim: OutletLimit,
  now: number,
): { ok: true } | { ok: false; at: number } => {
  if (now < p.coolUntil) return { ok: false, at: p.coolUntil };
  if (lim.concurrency > 0 && p.inFlight >= lim.concurrency) return { ok: false, at: 0 };
  prune(p, now);
  if (lim.perMinute > 0 && p.stamps.length >= lim.perMinute) {
    return { ok: false, at: p.stamps[p.stamps.length - lim.perMinute] + WINDOW_MS + 1 };
  }
  return { ok: true };
};

/**
 * 放行能放的那几个。
 *
 * `at: 0` 那一支（并发满了）**不挂定时器**：位子是 `release()` 还回来的，那一句会再叫一次
 * 这里。挂一个定时器去轮询「有位子了吗」只是让一次 200 毫秒的等待变成一次一秒的等待。
 */
function pump(outlet: Outlet): void {
  const p = gate[outlet];
  if (p.timer) {
    clearTimeout(p.timer);
    p.timer = null;
  }
  const lim = limitOf(outlet);
  while (p.queue.length) {
    if (p.queue[0].dead) {
      p.queue.shift();
      continue;
    }
    const now = Date.now();
    const verdict = admissible(p, lim, now);
    if (!verdict.ok) {
      if (verdict.at > now) {
        p.timer = setTimeout(() => {
          p.timer = null;
          pump(outlet);
        }, verdict.at - now);
        // 一个等着的定时器不该拖住进程退出（单测、脚本里都会遇到）。
        (p.timer as { unref?: () => void }).unref?.();
      }
      return;
    }
    const w = p.queue.shift();
    if (!w || w.dead) continue;
    p.inFlight += 1;
    p.stamps.push(now);
    w.admit();
  }
}

const abortError = (outlet: Outlet): Error => {
  const e = new Error(`在 ${outlet} 出口排队时被中止。`);
  e.name = "AbortError";
  return e;
};

/**
 * 拿一个位子。拿不到就**等**，等到有位子为止；`signal` 中止时抛 `AbortError`。
 *
 * 返回的那一句 `release()` 必须在 `finally` 里叫，而且叫几次算一次 —— 漏叫一次的表现不是
 * 报错，是这个出口的并发额度永久少一格，越跑越慢直到全部卡死。
 */
export function acquire(outlet: Outlet, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(abortError(outlet));
  return new Promise<() => void>((resolve, reject) => {
    const p = gate[outlet];
    let off: (() => void) | null = null;
    const w: Waiter = {
      dead: false,
      admit: () => {
        w.dead = true;
        off?.();
        let done = false;
        resolve(() => {
          if (done) return;
          done = true;
          p.inFlight -= 1;
          pump(outlet);
        });
      },
      drop: (e) => {
        w.dead = true;
        off?.();
        /*
         * 当场从队里摘掉，不等下一次 `pump` 顺手清。`snapshot()` 数的是队列长度，而那个数
         * 是运营台上唯一能看见「此刻堵了多少」的地方 —— 留着几个已经走掉的人，那个数会一直
         * 偏高，读的人会去调一个并没有被撑满的限额。
         */
        const at = p.queue.indexOf(w);
        if (at >= 0) p.queue.splice(at, 1);
        reject(e);
      },
    };
    if (signal) {
      const onAbort = () => w.drop(abortError(outlet));
      signal.addEventListener("abort", onAbort, { once: true });
      off = () => signal.removeEventListener("abort", onAbort);
    }
    p.queue.push(w);
    pump(outlet);
  });
}

/**
 * 上游回了 429：这个出口**整体**退避一段时间，期间 `acquire` 一律等。
 *
 * 整体而不是只让撞上的那一次等：429 说的是这一把 key 这一分钟发多了，那么此刻队里那几个
 * 发出去也是 429。只罚撞上的那一个等于让后面每一个都各撞一次，把一次退避摊成一串失败。
 *
 * 已经在飞的那几个不管 —— 它们的位子已经花掉了，掐掉只是白付一次钱。
 */
export function coolDown(outlet: Outlet, ms: number): void {
  const wait = Math.min(COOLDOWN_MAX_MS, Math.max(COOLDOWN_MIN_MS, Math.round(ms)));
  const until = Date.now() + wait;
  const p = gate[outlet];
  if (until > p.coolUntil) p.coolUntil = until;
  pump(outlet);
}

/**
 * `Retry-After` 那个头读成毫秒。秒数和 HTTP 日期两种写法都认（RFC 9110 两种都允许），读不
 * 出来就用兜底值 —— 429 是真的，头读不懂不该让它变成「不退避」。
 */
export function retryAfterMs(header: string | null | undefined, fallbackMs = 5_000): number {
  const raw = (header ?? "").trim();
  if (!raw) return fallbackMs;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return fallbackMs;
}

/** 给 trace 和运营台用：每个出口此刻在飞几个、排队几个、退避到几点。 */
export function snapshot(): Record<Outlet, { inFlight: number; queued: number; coolUntil: number }> {
  return Object.fromEntries(
    OUTLETS.map((o) => [
      o,
      { inFlight: gate[o].inFlight, queued: gate[o].queue.length, coolUntil: gate[o].coolUntil },
    ]),
  ) as Record<Outlet, { inFlight: number; queued: number; coolUntil: number }>;
}
