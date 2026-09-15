// 这两行必须在**任何会摸到 store.ts 的 import 之前**生效，而写在文件顶上不够：
// ESM 的 import 会被提到模块最前面求值，所以下面所有会到 store 的模块都在 beforeAll
// 里 await import，不留静态 import。（理由的长版本见 store.judgements.test.ts 开头。）
//
// TKOS_PERSIST=0：别读也别写 .data 里那份真快照 —— 这几条断言数的是「台账上有几轮」，
// 本机跑过一次 dev 之后那份快照里就有真实的扫描记录，读进来这个文件必红。
process.env.TKOS_PERSIST = "0";
// TKOS_MODEL_MOCK=1：单测里一次模型都不许真调用，而这台机器上可能导出着真 key。
process.env.TKOS_MODEL_MOCK = "1";

/**
 * `getScanCadence`：屏幕上那句节奏的唯一数据来源。
 *
 * 这一层要钉的不是中位数怎么算（那在 `scan/cadence.test.ts`），而是**读口读的是
 * 真台账**：`scanRoundPut` 写进去的东西，原样进得了这个方法的结果；他手点出来的那些
 * 进不了节奏。两者接不上的话，屏幕上那句话又会变成一个和库无关的数。
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { api as Api, scanRoundPut as ScanRoundPut } from "./store";
import type { POST as InboxPost } from "@/app/api/signals/inbox/route";

let api: typeof Api;
let scanRoundPut: typeof ScanRoundPut;
let inboxPost: typeof InboxPost;

beforeAll(async () => {
  const mod = await import("./store");
  api = mod.api;
  scanRoundPut = mod.scanRoundPut;
  process.env.OPERATOR_TOKEN = "operator-token-for-test";
  inboxPost = (await import("@/app/api/signals/inbox/route")).POST;
});

const T0 = Date.parse("2026-08-20T00:00:00Z");
const at = (hoursFromT0: number) => new Date(T0 + hoursFromT0 * 3_600_000).toISOString();

describe("getScanCadence", () => {
  it("台账是空的：三样都说不出来", async () => {
    // 种子里没有扫描记录，`TKOS_PERSIST=0` 之下这一张表开局就是空的。
    expect(await api.getScanCadence()).toEqual({ counted: 0, medianHours: null, lastAt: null });
  });

  it("自动那几轮进节奏，他手点的那几轮只进「上一轮」", async () => {
    for (const h of [0, 24, 48]) {
      scanRoundPut({ runId: `auto-${h}`, scannedAt: at(h), nominated: 1, trigger: "auto" });
    }

    const only = await api.getScanCadence();
    expect(only).toEqual({ counted: 3, medianHours: 24, lastAt: at(48) });

    /*
     * 现在补两条他手点的，而且**故意排在最后一轮自动之后、彼此只隔几分钟** ——
     * 这正是「手点两次把节奏算成几分钟」那个坏法子的现场。
     *
     * 破坏点：把 `getScanCadence` 里排除 `trigger !== "auto"` 那一句去掉，`counted`
     * 变 5、`medianHours` 从 24 掉到 0.1 左右，下面两条一起红。
     */
    scanRoundPut({ runId: "manual-1", scannedAt: at(50), nominated: 0, trigger: "manual" });
    scanRoundPut({ runId: "manual-2", scannedAt: at(50.1), nominated: 0, trigger: "manual" });

    const mixed = await api.getScanCadence();
    expect(mixed.counted).toBe(3);
    expect(mixed.medianHours).toBe(24);
    // 「上次什么时候扫的」不关心是谁起的，所以它跟着手点那一轮往前走。
    expect(mixed.lastAt).toBe(at(50.1));
  });

  it("同一个 runId 重投是就地更新：不会凭空多算一轮", async () => {
    const before = await api.getScanCadence();
    scanRoundPut({ runId: "auto-24", scannedAt: at(24), nominated: 9, trigger: "auto" });
    const after = await api.getScanCadence();
    expect(after.counted).toBe(before.counted);
  });

  it("重投时 trigger 也跟着改口 —— 台账上一条记录只有一个来路", async () => {
    scanRoundPut({ runId: "flip", scannedAt: at(72), nominated: 0, trigger: "manual" });
    const asManual = await api.getScanCadence();
    scanRoundPut({ runId: "flip", scannedAt: at(72), nominated: 0, trigger: "auto" });
    const asAuto = await api.getScanCadence();
    expect(asAuto.counted).toBe(asManual.counted + 1);
  });
});

/**
 * 收件口那一条路填的是 `auto`。
 *
 * 这一条和上面那几条是一对：读口只数自动的，那就得有人真的写下自动。两条写入路
 * 各自填错的表现完全不同 —— 收件口填成 manual，节奏永远是空的（屏幕上那一行消失，
 * 而雷达明明在转）；`scan/run.ts` 填成 auto，他连点两下就把周期算成几分钟。
 * 后一头钉在 `scan/run.test.ts`。
 */
describe("抓取作业推进来的那一轮", () => {
  it("记成自动，因而进得了节奏", async () => {
    const before = await api.getScanCadence();

    // 一条都没过线的一批也照记 —— 这一侧本来就要记，正好也是最省事的一批。
    const post = (runId: string, scannedAt: string) =>
      inboxPost(
        new Request("http://localhost/api/signals/inbox", {
          method: "POST",
          headers: { "content-type": "application/json", "x-operator-token": "operator-token-for-test" },
          body: JSON.stringify({ run_id: runId, scanned_at: scannedAt, signals: [] }),
        })
      );

    expect((await post("job-1", at(200))).status).toBe(200);
    expect((await post("job-2", at(224))).status).toBe(200);

    const after = await api.getScanCadence();
    expect(after.counted).toBe(before.counted + 2);
    expect(after.lastAt).toBe(at(224));
  });
});
