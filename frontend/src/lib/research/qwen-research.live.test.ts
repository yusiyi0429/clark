/**
 * **N2′ 的一次性真跑探针。默认整条跳过 —— 它会真的调通义、真的花钱**（一次约 ¥2.6）。
 *
 * 打开：`TKOS_QWEN_LIVE=1`。整轮深研不用跑（那是 ¥12 和半小时），这一步单独跑得动。
 *
 * ## 它验的是罐头验不到的那一件事：真回包长什么样
 *
 * 离线那一批（`qwen-research.test.ts`）喂的是我照文档编的帧，所以它证明的是「**如果**回包
 * 长成那样，这段代码接得住」。而文档恰恰缺了最关键的一层：`webSites` 挂在 `extra.deep_research`
 * 下面哪一级只写了「存在」，没给样例。猜错路径的表现不是报错，是这一步永远交零条 url 而
 * 整轮照常出稿 —— 静默变回没有它的样子。
 *
 * 所以这里**一次调用同时答两个问题**：真帧的形状是什么（存盘 + 打印路径），以及产品里那个
 * 扫法在真帧上找不找得到（拿 `scanSites` 跑一遍）。分两次跑要花两份钱。
 *
 * ## 跑完看什么
 *
 * 屏幕上那份摘要里，`扫到` 是 0 就是路径猜错了 —— 这时去看存盘的那份 `frames.jsonl`，
 * 里面有真帧，照着它改 `scanSites` 或 `messageOf`，然后把那几帧收进离线用例当夹具。
 *
 * 存盘落在 scratchpad，不进仓库：里面是这一次研究的题面和它搜到的地址，属于运行痕迹。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { frameJson, readSse } from "@/lib/agent/sse";

import { keepUrl, phaseOf, scanSites } from "./qwen-research";

const ON = process.env.TKOS_QWEN_LIVE === "1";
const run = ON ? it : it.skip;
const LONG = 6 * 60 * 1000;

/** 存哪儿。跟着这次会话的 scratchpad 走，不落进仓库。 */
const OUT_DIR =
  process.env.TKOS_QWEN_LIVE_OUT ??
  join(process.env.TEMP ?? ".", "claude", "qwen-live");

/** `.env.local` 抄进来。同 `data/a4-live-probe.test.ts` 那一份，理由也是同一个：vitest 不读它。 */
function loadEnvLocal(): void {
  if (!existsSync(".env.local")) return;
  for (const raw of readFileSync(".env.local", "utf8").split("\n")) {
    const line = raw.replace("\r", "").trim();
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
}

/**
 * 一条 url 是从哪条路径上扫出来的，`extra.deep_research.research.webSites[0]` 这样。
 *
 * 这是这个探针最值钱的输出：文档缺的就是这一行。产品里那个扫法不需要它（它不猜路径），
 * 但**下一个读这段代码的人需要** —— 有了它，「为什么不直接写死路径」这个问题答得出来。
 */
function pathsOfUrls(node: unknown, at = "", out: string[] = [], depth = 0): string[] {
  if (depth > 8 || !node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((x, i) => pathsOfUrls(x, `${at}[${i}]`, out, depth + 1));
    return out;
  }
  const o = node as Record<string, unknown>;
  if (typeof o.url === "string" && o.url) out.push(at || "(根)");
  for (const [k, v] of Object.entries(o)) pathsOfUrls(v, at ? `${at}.${k}` : k, out, depth + 1);
  return out;
}

/** 发一次，把帧原样收下来。**不断流** —— 这一次要看清 `answer` 阶段长什么样。 */
async function collect(
  url: string,
  key: string,
  messages: { role: "user" | "assistant"; content: string }[],
  opts: { stopAfterWebResearch: boolean }
): Promise<{ frames: unknown[]; text: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), LONG - 30_000);
  const frames: unknown[] = [];
  let text = "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "X-DashScope-SSE": "enable",
      },
      body: JSON.stringify({
        model: "qwen-deep-research",
        input: { messages },
        parameters: { incremental_output: true },
      }),
      cache: "no-store",
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).split(key).join("***");
      throw new Error(`HTTP ${res.status}：${body.slice(0, 600)}`);
    }
    if (!res.body) throw new Error("没有回流");
    let sawWeb = false;
    for await (const frame of readSse(res.body)) {
      const data = frameJson(frame);
      if (!data) continue;
      frames.push(data);
      const p = phaseOf(data);
      if (p === "WebResearch") sawWeb = true;
      // 反问那一次要读到底（它就是要那句话）；真跑那一次读过 answer 的头几帧就够看形状了。
      if (opts.stopAfterWebResearch && sawWeb && p && p !== "WebResearch" && p !== "KeepAlive") {
        if (frames.filter((f) => phaseOf(f) === p).length >= 3) {
          ctl.abort(new Error("看够了"));
          break;
        }
      }
    }
  } catch (e) {
    // 断流是这里的正常出口，超时也要把已收的帧留下来 —— 它们就是这次要的东西。
    if (!frames.length) throw e;
  } finally {
    clearTimeout(timer);
  }
  for (const f of frames) {
    const m = (f as { output?: { message?: { content?: unknown } } })?.output?.message?.content;
    if (typeof m === "string" && m) text = m.startsWith(text) ? m : text + m;
  }
  return { frames, text };
}

const BRIEF =
  "请就柔性中小尺寸 AMOLED 面板行业做一次深度调研，时间窗：当前时点 ± 未来 3 年。" +
  "覆盖需求端、供给端、技术路线、竞争格局、上游与产业链、政策与外部环境、风险与周期位置、" +
  "对主体的含义这八个角度，每个角度都去找一手材料，优先给可核对的原始出处。";

let url = "";
let key = "";

beforeAll(() => {
  if (!ON) return;
  loadEnvLocal();
  url = (process.env.TKOS_QWEN_RESEARCH_URL ?? "").trim();
  key = (process.env.TKOS_QWEN_RESEARCH_KEY ?? process.env.DASHSCOPE_API_KEY ?? "").trim();
});

describe("真回包的形状", () => {
  run(
    "扫得到地址，而且能说出它们挂在哪条路径上",
    async () => {
      expect(url, "没配 TKOS_QWEN_RESEARCH_URL").toBeTruthy();
      expect(key, "没配 TKOS_QWEN_RESEARCH_KEY / DASHSCOPE_API_KEY").toBeTruthy();

      // ---- 第一步：让它反问 ----------------------------------------------
      const step1 = await collect(url, key, [{ role: "user", content: BRIEF }], {
        stopAfterWebResearch: false,
      });
      expect(step1.text, "第一次调用没交回任何文字").toBeTruthy();

      // ---- 第二步：真跑 ---------------------------------------------------
      const step2 = await collect(
        url,
        key,
        [
          { role: "user", content: BRIEF },
          { role: "assistant", content: step1.text },
          {
            role: "user",
            content:
              "按以下口径直接开始，不用再确认：地域以中国大陆市场为主；八个角度都要；" +
              "来源优先一手材料与可核对的原始出处。",
          },
        ],
        { stopAfterWebResearch: true }
      );

      // ---- 存盘 -----------------------------------------------------------
      mkdirSync(OUT_DIR, { recursive: true });
      const dump = join(OUT_DIR, "frames.jsonl");
      writeFileSync(dump, step2.frames.map((f) => JSON.stringify(f)).join("\n"), "utf8");

      // ---- 诊断 -----------------------------------------------------------
      const phases = [...new Set(step2.frames.map(phaseOf).filter(Boolean))];
      const webFrames = step2.frames.filter((f) => phaseOf(f) === "WebResearch");

      // 产品里那个扫法，原样跑一遍真帧。
      const scanned: Record<string, unknown>[] = [];
      for (const f of webFrames) {
        const extra = (f as { output?: { message?: { extra?: { deep_research?: unknown } } } })?.output
          ?.message?.extra?.deep_research;
        scanSites(extra, scanned);
      }
      const urls = [...new Set(scanned.map((x) => String(x.url)))];
      const paths = [...new Set(webFrames.flatMap((f) => pathsOfUrls(f)))];

      console.log(
        [
          "",
          "──── N2′ 真跑 ────",
          `帧数        ${step2.frames.length}（其中 WebResearch ${webFrames.length}）`,
          `走过的阶段  ${phases.join(" → ") || "（一个都没取到）"}`,
          `扫到        ${scanned.length} 条带 url 的对象，去重后 ${urls.length}`,
          `过卫生之后  ${urls.filter(keepUrl).length} 条`,
          `挂在哪      ${paths.slice(0, 12).join("\n            ") || "（没找到）"}`,
          `头三条      ${urls.slice(0, 3).join("\n            ") || "（无）"}`,
          `它反问的    ${step1.text.slice(0, 120).replace(/\s+/g, " ")}`,
          `原始帧存盘  ${dump}`,
          "",
        ].join("\n")
      );

      expect(phases, "一个阶段都没取到 —— messageOf 那两种形状可能都不对").not.toEqual([]);
      expect(webFrames.length, "没走到 WebResearch —— 这一次可能又被反问了一轮").toBeGreaterThan(0);
      /*
       * 这一条就是这次跑的全部理由。红了不代表产品坏了，代表**路径猜错了**：
       * 去看上面打印的「挂在哪」和存盘的那份 frames.jsonl，照真帧改 `scanSites`。
       */
      expect(urls.length, "WebResearch 帧里一条 url 都没扫到 —— 看存盘的 frames.jsonl").toBeGreaterThan(0);
      expect(urls.filter(keepUrl).length, "扫到了但全被 keepUrl 挡掉了").toBeGreaterThan(0);
    },
    LONG
  );
});
