/**
 * **验收用的一次性真跑。默认整条跳过 —— 它会真的打检索、真的调模型、真的花钱。**
 *
 * 打开：`TKOS_SCAN_LIVE=1`。
 *
 * 它验的是罐头那条路验不到的那一件事：**这五步在真检索和真模型上接得起来。**
 * 离线那一条（`run.test.ts`）用的是假检索和现算的罐头，它能证明接线对，证明不了
 * 博查回来的字段名对不对得上、flash 会不会按那份 JSON 格式答、真页面抓不抓得下来。
 *
 * 判据不看端上来的信号选得准不准（那是策略的事，得人看），看三个数：拟出了几条
 * 检索式、检索回来几条、研判之后有没有走到落库那一步。
 *
 * **不落用户的库**：`TKOS_DATA_DIR` 指到一个临时目录、`TKOS_PERSIST=0`，所以这一轮
 * 收下来的东西不会出现在他的待挑列表里。要看真结果，在屏幕上按那个键。
 *
 * 这一轮的账（拟了几条、收下几条、几点收工）写进 `TKOS_SCAN_LIVE_OUT` 指的那个文件。
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { ScanState } from "@/lib/data/types";

const ON = process.env.TKOS_SCAN_LIVE === "1";
const run = ON ? it : it.skip;
const LONG = 15 * 60 * 1000;

let startScan: () => ScanState;
let scanState: () => ScanState;

/** `.env.local` 是 next 读的，vitest 不读 —— 真跑要自己装一遍。已经在环境里的不覆盖。 */
const loadEnvLocal = async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  if (!existsSync(".env.local")) return;
  for (const raw of readFileSync(".env.local", "utf8").split(String.fromCharCode(10))) {
    const line = raw.replace(String.fromCharCode(13), "").trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
};

beforeAll(async () => {
  if (!ON) return;
  await loadEnvLocal();
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.TKOS_DATA_DIR = mkdtempSync(join(tmpdir(), "tkos-scan-live-"));
  process.env.TKOS_PERSIST = "0";
  delete process.env.TKOS_MODEL_MOCK;
  const mod = await import("./run");
  startScan = mod.startScan;
  scanState = mod.scanState;
});

describe("真跑一轮扫描", () => {
  run(
    "五步在真检索和真模型上接得起来",
    async () => {
      const first = startScan();
      expect(first.unavailable).toBeUndefined();

      let last: ScanState = first;
      for (let i = 0; i < 900; i += 1) {
        last = scanState();
        if (last.status !== "running" && last.status !== "idle") break;
        // 每一步都要在屏幕上说得出自己在干什么。
        if (last.step) expect(last.step.length).toBeGreaterThan(0);
        await new Promise((r) => setTimeout(r, 1000));
      }

      /*
       * 这一轮的账写到文件里，不写 console —— 这套 vitest 配置不把 console 输出摊到
       * 终端上（试过：离线那一条明明在 `land()` 里 log 了，一行都不出现）。而这条探针
       * 唯一的产出就是那几个数：拟了几条、搜回几条、收下几条。丢了它，一次四分钟的
       * 真跑只剩一个「过了」。
       */
      const out = process.env.TKOS_SCAN_LIVE_OUT;
      if (out) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(out, JSON.stringify(last, null, 2), "utf8");
      }
      expect(last.status).toBe("done");
      expect(last.got).toBeDefined();
      // 零条过线是合法结果，所以这里不断言收下了几条 —— 断言的是这一轮**跑到了落库**。
      expect(last.finishedAt).toBeTruthy();
      expect(last.runId).toMatch(/^s-/);
    },
    LONG,
  );
});
