/**
 * 任务表这一层只钉三件事，三件都是「不许发生」：
 *
 *   · 同一件事不许同时跑两轮 —— 两轮都往同一个地方写。
 *   · `failed` 不许被自动抹掉 —— 抹掉就等于把失败藏起来，并且每次轮询都花一次钱。
 *     解闩必须是一个明确的动作（`clearTask`，屏幕上那个「打回重研」）。
 *   · 结算之后不许还挂着「走到第几步」—— 屏幕按「有 step」判它在跑。
 *
 * 2026-09-07 起多一件：**同一条道上一次只跑几轮**（`lane`）。深研排队用的就是它，而它坏掉的
 * 两头同样没有症状 —— 放松了是两轮并跑（实测把取证从 5 分 43 秒拖到 13 分钟，而屏幕上只是
 * 「都变慢了」），卡住了是队里剩下的每一条永远写着「排队中」，谁也不会来推它一把。
 */
import { afterEach, describe, expect, it } from "vitest";

import { clearTask, runTask, taskState, taskStep } from "./tasks";

/** 手动控制一轮任务什么时候结束。 */
const deferred = () => {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<{ attempts?: number }>((res, rej) => {
    resolve = () => res({ attempts: 1 });
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("clearTask", () => {
  it("正在跑的不动 —— 抹掉一个 running 会让同一件事同时跑两轮", async () => {
    const d = deferred();
    expect(runTask("t-run", "1", () => d.promise).status).toBe("running");

    expect(clearTask("t-run", "1")).toBe(false);
    expect(taskState("t-run", "1").status).toBe("running");

    d.resolve();
    await tick();
    expect(taskState("t-run", "1").status).toBe("done");
  });

  it("失败过的能解闩，解开之后同一个 key 能再起一轮", async () => {
    const first = deferred();
    runTask("t-fail", "1", () => first.promise);
    first.reject(new Error("模型输出被截断"));
    await tick();
    expect(taskState("t-fail", "1").status).toBe("failed");

    // 不解闩就再起一轮：`runTask` 本身不拦（它只拦 running），拦的是调用方
    // 那几个 ensure 函数。所以这里验的是解闩这个动作本身。
    expect(clearTask("t-fail", "1")).toBe(true);
    expect(taskState("t-fail", "1").status).toBe("idle");

    const second = deferred();
    expect(runTask("t-fail", "1", () => second.promise).status).toBe("running");
    second.resolve();
    await tick();
    expect(taskState("t-fail", "1").status).toBe("done");
  });

  it("没跑过的 key 返回 false —— 没什么可抹的", () => {
    expect(clearTask("t-none", "1")).toBe(false);
  });
});

describe("taskStep", () => {
  const step = (no: number, label: string) => ({
    label,
    no,
    total: 4,
    at: "2026-08-20T10:00:00.000Z",
  });

  it("写在正在跑的那一条上，屏幕从这里读「第几步」", () => {
    const d = deferred();
    runTask("t-step", "1", () => d.promise);

    taskStep("t-step", "1", step(1, "装配上下文"));
    expect(taskState("t-step", "1").step).toMatchObject({ no: 1, label: "装配上下文" });

    // 往前走一格：整块换掉，不合并 —— 上一步的原话不许留在下一步里。
    taskStep("t-step", "1", step(2, "写正式报告"));
    expect(taskState("t-step", "1").step).toMatchObject({ no: 2, label: "写正式报告" });
    // 起点不动：那行字上的秒表从这里算。
    expect(taskState("t-step", "1").startedAt).toBeTruthy();

    d.resolve();
  });

  it("结算之后不留步骤 —— 留着等于说「还在写正式报告」，而它已经写完了", async () => {
    const d = deferred();
    runTask("t-settle", "1", () => d.promise);
    taskStep("t-settle", "1", step(2, "写正式报告"));

    d.resolve();
    await tick();
    expect(taskState("t-settle", "1").status).toBe("done");
    expect(taskState("t-settle", "1").step).toBeUndefined();
  });

  it("已经挂了的那一条不许被补上步骤 —— 慢的收尾会让屏幕把它读成还在跑", async () => {
    const d = deferred();
    runTask("t-late", "1", () => d.promise);
    d.reject(new Error("模型输出被截断"));
    await tick();

    taskStep("t-late", "1", step(3, "压成四节"));
    expect(taskState("t-late", "1").status).toBe("failed");
    expect(taskState("t-late", "1").step).toBeUndefined();
  });

  it("没跑过的 key 不会因为一次上报凭空长出一条任务", () => {
    taskStep("t-ghost", "1", step(1, "装配上下文"));
    expect(taskState("t-ghost", "1")).toEqual({ status: "idle" });
  });
});

/**
 * **一条道上的队。**
 *
 * 不给 `lane` 的那一条路一个字没改（上面那几组验的就是它），所以这里只推排队那一支。
 */
describe("lane：同一条道一次只跑一个", () => {
  afterEach(() => {
    delete process.env.TKOS_DEEP_CONCURRENCY;
  });

  it("第一个直接跑，第二个进队 —— 而且**队里那个的函数一次都不许被叫到**", async () => {
    /*
     * 这一条是这一组里最要紧的。排队排错的样子不是报错，是「两轮都在跑，而表上写着排队」
     * —— 一轮深研十几分钟、真花钱，从屏幕上分辨不出来。所以不光看状态，还要数那个函数
     * 被叫过几次。
     */
    const a = deferred();
    const b = deferred();
    let bStarted = 0;

    expect(runTask("t-lane", "a", () => a.promise, { lane: "L1" }).status).toBe("running");
    const second = runTask("t-lane", "b", () => {
      bStarted += 1;
      return b.promise;
    }, { lane: "L1" });

    expect(second.status).toBe("queued");
    // 在跑的那一轮也要等，所以是 1 不是 0（屏幕上写「前面还有 1 轮」）。
    expect(second.queuePosition).toBe(1);
    await tick();
    expect(bStarted).toBe(0);
    // 排着队的没有起点 —— 有的话屏幕上的秒表会从按下去那一刻走，写出「已 15 分钟」。
    expect(second.startedAt).toBeUndefined();

    a.resolve();
    await tick();
    expect(taskState("t-lane", "a").status).toBe("done");
    expect(taskState("t-lane", "b").status).toBe("running");
    expect(bStarted).toBe(1);
    expect(taskState("t-lane", "b").startedAt).toBeTypeOf("string");

    b.resolve();
    await tick();
    expect(taskState("t-lane", "b").status).toBe("done");
  });

  it("**前一个挂了也要放行** —— 不放的话队里剩下的永远写着「排队中」", async () => {
    const a = deferred();
    const b = deferred();
    runTask("t-lane-fail", "a", () => a.promise, { lane: "L2" });
    runTask("t-lane-fail", "b", () => b.promise, { lane: "L2" });

    a.reject(new Error("模型接不上"));
    await tick();
    expect(taskState("t-lane-fail", "a").status).toBe("failed");
    expect(taskState("t-lane-fail", "b").status).toBe("running");

    b.resolve();
    await tick();
  });

  it("先来后到，而且号次跟着队伍往前挪", async () => {
    /*
     * 号次不刷新的表现：前面那一轮跑完了，第三条还写着「前面还有 2 轮」—— 一句每过十五分钟
     * 就更假一点的话，而它旁边没有任何别的数能对。
     */
    const ds = [deferred(), deferred(), deferred()];
    const order: string[] = [];
    ["a", "b", "c"].forEach((n, i) =>
      runTask("t-lane-fifo", n, () => {
        order.push(n);
        return ds[i].promise;
      }, { lane: "L3" })
    );

    expect(taskState("t-lane-fifo", "b").queuePosition).toBe(1);
    expect(taskState("t-lane-fifo", "c").queuePosition).toBe(2);

    ds[0].resolve();
    await tick();
    expect(order).toEqual(["a", "b"]);
    expect(taskState("t-lane-fifo", "c").queuePosition).toBe(1);

    ds[1].resolve();
    await tick();
    expect(order).toEqual(["a", "b", "c"]);
    ds[2].resolve();
    await tick();
  });

  it("排着队的那一条再被叫一次不许重复入队 —— 前端在轮询", async () => {
    /*
     * `queued` 在表上不是 `running`，所以少判它那一档的表现是：轮询每五秒把同一件议题再排
     * 一次，队伍越排越长，而每一条都会真的跑一轮。
     */
    const a = deferred();
    const b = deferred();
    runTask("t-lane-dup", "a", () => a.promise, { lane: "L4" });
    let bStarted = 0;
    const mk = () => runTask("t-lane-dup", "b", () => {
      bStarted += 1;
      return b.promise;
    }, { lane: "L4" });
    mk();
    mk();
    mk();

    a.resolve();
    await tick();
    expect(bStarted).toBe(1);
    expect(taskState("t-lane-dup", "b").status).toBe("running");
    b.resolve();
    await tick();
  });

  it("排着队的不许被 `clearTask` 抹掉", async () => {
    /*
     * 抹掉之后它照旧会被起出来（起它的那个闭包已经在队里了），而表上已经没有它 ——
     * 屏幕上是「还没开始」，后台正在跑一轮真花钱的深研。
     */
    const a = deferred();
    const b = deferred();
    runTask("t-lane-clear", "a", () => a.promise, { lane: "L5" });
    runTask("t-lane-clear", "b", () => b.promise, { lane: "L5" });

    expect(clearTask("t-lane-clear", "b")).toBe(false);
    expect(taskState("t-lane-clear", "b").status).toBe("queued");

    a.resolve();
    await tick();
    b.resolve();
    await tick();
  });

  it("`TKOS_DEEP_CONCURRENCY` 只管深研那条道，而且在取用时读", async () => {
    // 别条道不该跟着变：那个变量的名字里写着 deep，配它的人要的就是深研。
    process.env.TKOS_DEEP_CONCURRENCY = "2";
    const ds = [deferred(), deferred(), deferred()];
    ["a", "b", "c"].forEach((n, i) =>
      runTask("t-deep", n, () => ds[i].promise, { lane: "deep" })
    );
    expect(taskState("t-deep", "a").status).toBe("running");
    expect(taskState("t-deep", "b").status).toBe("running");
    expect(taskState("t-deep", "c").status).toBe("queued");
    expect(taskState("t-deep", "c").queuePosition).toBe(2);

    ds.forEach((d) => d.resolve());
    await tick();
    await tick();

    // 同一个值配在别的道上不生效 —— 那条道照旧是 1。
    const es = [deferred(), deferred()];
    runTask("t-other", "a", () => es[0].promise, { lane: "L6" });
    expect(runTask("t-other", "b", () => es[1].promise, { lane: "L6" }).status).toBe("queued");
    es.forEach((d) => d.resolve());
    await tick();
    await tick();
  });

  it("不给 `lane` 就不排队 —— 别的几条链路一个字没改", async () => {
    const a = deferred();
    const b = deferred();
    expect(runTask("t-free", "a", () => a.promise).status).toBe("running");
    expect(runTask("t-free", "b", () => b.promise).status).toBe("running");
    a.resolve();
    b.resolve();
    await tick();
  });
});
