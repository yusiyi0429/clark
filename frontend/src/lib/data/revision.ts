/**
 * 「库改过了」这件事本身 —— 一个只会往上走的号，加一份订阅名单。
 *
 * ## 为什么需要它
 *
 * 读面全都关掉了 SWR 的自动重验证（见 `lib/use-resource.ts`，理由在那里：静默重取会
 * 让等待状态说假话）。这个决定对**他点出来的变化**是对的 —— 谁点的谁知道要刷什么。
 * 但这个产品里有一大半变化**不是他点出来的**：深研跑完、报告读成判断、A1a 把一条信号
 * 开成议题、预研落地、写回执行完。这些是服务端自己做完的，而浏览器那一侧没有任何
 * 途径知道它做完了 —— 于是屏幕上一直是刚才那一份，他得按 F5。
 *
 * 补丁的做法是给每一处会变的读面挂一个轮询。已经挂了四个（首页、判断板、潜在议题
 * 详情、待挑信号），而它们各自定了自己的节拍、各自定了自己的开关条件，其中一个的开关
 * 条件恰好排除了真实模型那条路（首页要求 `progress !== undefined`，而真调用给不出
 * 百分比）。第五个第六个只会重复这件事。
 *
 * 所以这里换一条真的通道：**库改过了就说一声**。谁在听，就重问自己屏幕上那几份。
 *
 * ## 号是全局的，不分对象
 *
 * 不做「board:ISS-3 改了」这种粒度。一次确认会同时动判断、议题、时间线、决定、首页
 * 那几个算出来的数 —— 要列全才不漏，而列漏一个的表现恰恰是「屏幕上某个数字是旧的」，
 * 那是这块屏幕最不能出的错（`useInvalidate` 的注释里已经为同一件事做过同一个选择）。
 * 一次全量重问的代价是几个本地 JSON 读，比列错一张表便宜得多。
 *
 * ## 一个诚实的限制
 *
 * 进程内内存，和 `lib/stage/bus.ts`、`lib/asr/relay.ts`、`lib/data/persist.ts` 同一条
 * 约束：单副本部署、单写者。多实例之后 A 实例的写不会通知连在 B 实例上的屏幕 ——
 * 到那时要换成一个真的外部总线，不是在这里打补丁。
 */

/** 从 0 开始。客户端拿它比大小，只认「比我上次见到的大」。 */
let rev = 0;

type Listener = (revision: number) => void;

const listeners = new Set<Listener>();

/**
 * 合并同一小段时间里的连写。
 *
 * 一次确认在服务端是好几笔写（判断、议题、时间线、决定各一次 `persistSoon`）。
 * 不合并的话同一件事会推四帧，屏幕跟着重问四轮 —— 而那四轮问到的是同一份东西。
 *
 * 60ms 是「一次请求里的连写」和「两次独立的动作」之间那条线：模型调用之间隔着秒，
 * 同一个函数体里的连写隔着微秒。
 */
const COALESCE_MS = 60;
let timer: ReturnType<typeof setTimeout> | null = null;

/** 眼下这个号。SSE 那条路刚连上时要先把它报给客户端。 */
export const revision = (): number => rev;

/**
 * 库改过了。**只在真的写了东西之后叫** —— 读操作叫它会让「重问」本身变成
 * 「又改了」，屏幕于是无限重问下去（所以 `/api/data` 那条兜底落盘走的是
 * `persistOnly`，不走这里）。
 */
export function bumpRevision(): void {
  rev += 1;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    const at = rev;
    // 拷一份再遍历：监听者在回调里退订是正常的（流断了就退），
    // 直接遍历原集合会漏掉后面那几个。
    for (const listener of [...listeners]) {
      try {
        listener(at);
      } catch {
        /* 一个订阅者炸了不该连坐另一个。 */
      }
    }
  }, COALESCE_MS);
  // 别让这个定时器把进程吊着不退出（同 persist.ts 那一处）。
  if (typeof timer === "object" && timer && "unref" in timer) (timer as NodeJS.Timeout).unref();
}

/** 订阅。返回退订函数。 */
export function subscribeRevision(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 现在有几块屏在听。`/api/health` 用它答「推送这条路通没通」。 */
export const revisionListenerCount = (): number => listeners.size;
