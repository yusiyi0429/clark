"use client";

/**
 * 浏览器这一侧的「库改过了」。一个号，一份订阅名单，加一个挂在每份读面上的钩子。
 *
 * 号从服务端来（`/api/data/changes`，那条路由的开头讲了为什么要有它；号本身在
 * `lib/data/revision.ts`）。这里只做两件事：记住见过的最大的号，和让屏幕上挂着的
 * 那几份数据在号变大之后重问一遍。
 *
 * ## 为什么补问要按 key 记账，而不是收到号就全量重问
 *
 * 读面关掉了 `revalidateIfStale`（`lib/use-resource.ts` 里的理由：静默重取会让等待
 * 状态说假话）。这条规则有一个后果：**缓存里有旧数据的 key，重新挂载时不会去问。**
 * 所以「收到号就把此刻挂着的重问一遍」是不够的 —— 他当时不在那一页，那一页的缓存
 * 就停在改动之前，等他切回去，屏幕上是旧的，而且再也不会自己变新。
 *
 * 于是每个 key 记一笔「我这份是在几号那一刻取的」。号变大时屏幕上挂着的立刻重问；
 * 没挂着的那些，等它下次挂上来发现自己那一笔落后了，自己补问一轮。
 *
 * 换成「清空没挂着的 key」（`useInvalidate` 对写操作用的就是那一手）在这里不行：
 * 那是他自己点出来的一次写，清空的代价是下次进那一页先闪一下骨架，能接受；而这条
 * 线是服务端自己在动，一天里会响很多次 —— 那样每一次都会把他没在看的那些页清成
 * 骨架，切回去必然从头长一遍。
 */

/** 见过的最大的号。没连上、或者服务端还没改过任何东西的时候是 0。 */
let current = 0;

type Watcher = () => void;

const watchers = new Set<Watcher>();

/**
 * 每个 key 上一次是在几号那一刻取的。`-1` 用不到 —— 没有记录就等于「刚取的」
 * （见 `useLiveRefresh`），所以这张表只会存真的数字。
 *
 * 不清理：key 是「issues」「board:ISS-3」这样的枚举，一次会话里几十条上限。
 */
const fetchedAt = new Map<string, number>();

export const liveRevision = (): number => current;

/** 服务端报来一个号。比见过的大才算，小的或相等的直接丢（重连时会重报同一个）。 */
export function noteRevision(rev: number): void {
  if (!Number.isFinite(rev) || rev <= current) return;
  current = rev;
  // 拷一份再遍历：回调里退订是正常的（组件卸载）。
  for (const watcher of [...watchers]) {
    try {
      watcher();
    } catch {
      /* 一份读面炸了不该连坐另一份。 */
    }
  }
}

function watch(watcher: Watcher): () => void {
  watchers.add(watcher);
  return () => {
    watchers.delete(watcher);
  };
}

/**
 * 给一份读面挂上「库改了就重问」。`useResource` 内部用，别处不用直接叫。
 *
 * `revalidate` 是那份数据的 `mutate`（不带参数 = 重新去问一次，问回来之前保留旧值，
 * 所以外面的 `AsyncBoundary` 不会掉回骨架）。
 */
export function liveRefresh(key: string, revalidate: () => void): () => void {
  const seen = fetchedAt.get(key);

  /*
   * 第一次见到这个 key：记成「现在这个号」，**不重问**。
   *
   * 没有记录就说明这一份此刻正在被取（或者刚被 `useSeed` 放进来），它拿到的就是这个
   * 号那一刻的库。这里少了这一笔，每一次挂载都会紧跟一次多余的重问 —— 每开一页都
   * 把所有请求发两遍。
   */
  if (seen === undefined) fetchedAt.set(key, current);

  const refresh = () => {
    // 同一个号已经有人替这个 key 问过了就别再问。两个组件用同一个 key 是常事
    // （比如议题头和报告栏都要那条议题），否则同一个号会发两遍同样的请求。
    if ((fetchedAt.get(key) ?? -1) >= current) return;
    fetchedAt.set(key, current);
    revalidate();
  };

  // 挂上来的时候先对一次号：他刚才不在这一页，而这一页的那份数据是改动之前取的。
  refresh();

  return watch(refresh);
}
