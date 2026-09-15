/**
 * 一次跑几个，跑完一个补一个。**结果按输入顺序回来。**
 *
 * 为什么不是 `Promise.all(items.map(fn))`：一波检索抓回来五页、四条维度链各领几个维度，
 * 全撒出去的话同一秒里有二十来个模型调用在飞 —— 那几个出口的限流是按并发算的，撞上
 * 429 之后重来一遍比排队慢。所以要一个闸门。
 *
 * 为什么不是 `for (const x of items) await fn(x)`：那正是 2026-08-27 那一轮跑了 47 分钟
 * 的形状（深研 v2 的 N3：四条链 × 三波 × 五页抽取，一次一个排着走）。抽一页和抽另一页
 * 之间没有任何依赖，串着等只是把等待时间加起来。
 *
 * ## 结果保序是硬要求，不是顺手
 *
 * 取证那一步把抽出来的证据按顺序记进台账，而台账的编号（`E1`、`E2`…）就是记的顺序。
 * 谁先回来谁先记的话，同一批页跑两遍会得到两套编号，而报告正文里引的是编号 —— 那意味着
 * 「同样的输入跑出同样的账」这件事没了，出了问题也没法比对两轮。所以这里等齐了按下标回填。
 *
 * ## 谁负责接异常
 *
 * `fn` 自己接。这个函数**不吞异常**：一个抛出来，整批跟着抛（同 `Promise.all`）。
 * 调用处（`evidence.ts` 的抽取、`sweep.ts` 的每条链）本来就各自套着 try/catch —— 一页抽
 * 不出来不该拖垮整轮，那条纪律写在它们各自的注释里。在这里加一个「出错就当 null」等于把
 * 那条纪律搬到一个不知道业务的地方，而它在这里只能是静默的。
 */

/** 一次最多几个在飞。给 0 或负数当 1 —— 那是「串着跑」，不是「不限」。 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const n = items.length;
  const out = new Array<R>(n);
  if (!n) return out;
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, n));

  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= n) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}
