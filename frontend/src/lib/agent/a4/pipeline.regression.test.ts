/**
 * §5.2 通用验收里**可机检的那几条** —— 每一版深研跑完都要还成立的四件事。
 *
 * 和 `pipeline.test.ts` 的分工：那个文件测的是各节点半途而废时的处置（补维度、缺口进清单），
 * 这个文件测的是**产出的形状**，跨版本要能拿同一批断言去量。所以这几条故意写得不看具体
 * 内容：内容对不对要真模型跑一轮再人工比对（§5.1 那张表，记在
 * `docs/superpowers/plans/2026-08-26-deep-research-v2-验收记录.md`），机器答不了。
 *
 * 打桩的理由同 `pipeline.test.ts`：`openContext` 在图服务连不上时抛 `AgentRunFailed` 就地
 * 失败，而那是故意的。打的是**转纯外部**那一档 —— 一号位真机上两次整跑走的都是这一档。
 *
 * ## 这四条都是「断了会红」的断言，不是「跑过了就绿」的记号
 *
 * 前一稿里有三条其实测不出它自己写着的那件事：覆盖表那条把整张表 `JSON.stringify` 之后找
 * 八个维度号，而 `sweep.ts` 的表是 `DIM_IDS.map(...)` 建的，八行永远都在；附录那条给
 * `appendixFrom` 兜了个 `?? blocks.length` 的底，于是这一栏彻底不写了也照样绿；证据条数那条
 * 写的是 `>= 0`，只能拦住 `undefined`。改成现在这样之后，四条各自都在源码里被人为弄断过一次
 * 并确认变红（记在 task-12 报告的「fix round 1」一节）。
 *
 * 离线（`TKOS_MODEL_MOCK=1`）跑的是 `models/mock.ts` 那张**静态**罐头表，它写不出这一轮
 * 真跑出来的证据编号，所以离线每一轮固定 `degraded === true`（`A4-B11`：证据包条目没交账）、
 * 每条维度链的 `recorded` 固定是 0。**这几条断言都绕开了那两件事**：改罐头去把断言弄绿，
 * 等于让这份验收测试说一句假话。「查不到是合法结果」也是同一件事的另一面 —— 所以证据条数
 * 那条量的是「这个数和台账对不对得上」，不是「这个数够不够大」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DIM_IDS, MIN_TRIED_FOR_NOT_FOUND } from "./dims";
import { partition } from "./layer";
import { runDeepResearchV2 } from "./pipeline";
import type { A4Input } from "./prompt";

vi.mock("@/lib/ontology/context", () => ({ openOntologyContext: vi.fn() }));

const { openOntologyContext } = await import("@/lib/ontology/context");
type Opened = Awaited<ReturnType<typeof openOntologyContext>>;
const external = {
  mode: "external_only",
  bundle: null,
  anchor: null,
  noAnchorReason: "这一池分不出高低（前 4 名分数拉不开）",
  staticContext: "",
  snapshotId: null,
  trace: [],
  warnings: [],
} as unknown as Opened;

const input = (title = "维信诺所处的行业"): A4Input => ({
  issueId: "ISS-R",
  title,
  scope: null,
  preTake: null,
  preOpenQuestions: [],
  judgments: [],
});

describe("§5.2 通用验收", () => {
  beforeEach(() => {
    process.env.TKOS_MODEL_MOCK = "1";
    process.env.TKOS_DR_V2 = "1";
    vi.mocked(openOntologyContext).mockReset();
    vi.mocked(openOntologyContext).mockResolvedValue(external);
  });

  /*
   * 两个变量都要在这儿删掉，理由和 `pipeline.test.ts` 里那个 `clearEnv` 一样：`TKOS_DR_V2`
   * 漏出去会让同一次 vitest 里后面的用例走上一条不是为它们写的链路，`TKOS_MODEL_MOCK`
   * 漏出去会让它们静静地不出网。那个 `clearEnv` 是那个文件里的局部常量、没有导出，跨测试
   * 文件去引它等于给两份用例绑一根看不见的线，所以这里照抄两行而不是去引它。
   */
  afterEach(() => {
    delete process.env.TKOS_DR_V2;
    delete process.env.TKOS_MODEL_MOCK;
  });

  it("八维覆盖表全绿或有记录的缺口，没有第三种状态", async () => {
    const r = await runDeepResearchV2(input());
    /*
     * 覆盖表没有挂在 `A4Result` 上，`sweep.ts` 只把它记进这条 trace，所以这里认的是那条
     * 记录的字段名和它每一行的写法 —— 字段改名、某一维那一行不见了、「N 组」那个写法变了，
     * 这一条都会红。整张表 `stringify` 之后找维度号是测不出东西的：那张表是
     * `DIM_IDS.map(...)` 建出来的，八行永远齐。
     */
    const detail = r.run.trace.find((n) => n.label === "覆盖表")?.detail as
      | { 各维?: unknown; 门?: unknown }
      | undefined;
    const rows = detail?.各维;
    expect(Array.isArray(rows)).toBe(true);
    const lines = rows as string[];
    expect(lines).toHaveLength(DIM_IDS.length);

    for (const dim of DIM_IDS) {
      const line = lines.find((l) => l.startsWith(`${dim} `));
      expect(line, `${dim} 这一维在覆盖表上没有行`).toBeTruthy();
      const groups = Number(/：(\d+) 组/.exec(line ?? "")?.[1] ?? NaN);
      const tried = Number(/试过 (\d+) 条问法/.exec(line ?? "")?.[1] ?? 0);
      // 两种合法状态：有独立来源，或者「搜了几轮一无所获」并留下够数的问法。第三种 ——
      // 既没来源也没记录 —— 才是这一条要拦的，而它在产出上和「有来源」长得一样安静。
      expect(
        groups > 0 || tried >= MIN_TRIED_FOR_NOT_FOUND,
        `${line}：既没有独立来源，已搜未得也不足 ${MIN_TRIED_FOR_NOT_FOUND} 条问法`
      ).toBe(true);
    }
    // 这一条的规则本身归 `dims.ts` 的 `gateOpen` 管（强判断那几维要两组）。门没开时这一栏
    // 装的是缺口原话，断言的失败信息里就带着它。
    expect(detail?.门).toBe("开");
  });

  it("正文与附录物理分开，附录不是空的", async () => {
    const r = await runDeepResearchV2(input("x"));
    const blocks = r.doc.blocks?.blocks ?? [];
    const at = r.doc.blocks?.appendixFrom;
    /*
     * 不给这一栏兜底：兜了 `?? blocks.length` 的话，「附录从哪儿开始」这句话彻底不写了也
     * 照样绿，而缺这一栏时 `auditExit` 那条「校验机械铺在正文里」就永远查不出东西
     * （它循环到 0 就结束）。下标要**严格落在块列表里面**：落到末尾或末尾之外，指的是
     * 一个空附录。
     */
    expect(typeof at).toBe("number");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(blocks.length);

    /*
     * 「物理分开」按块的类型两边各验一次，因为 `partition` 认的是 type、压根不读
     * `appendixFrom` —— 只查「附录里有附录块」的话，一份 `evidence_list` 坐在第 0 位、
     * `appendixFrom` 写着 5 的报告也能绿。`stage-write.ts` 那次重排的产物是：正文段在前、
     * 附录块在后、下标正好是正文块数。
     */
    expect(partition(blocks.slice(0, at)).appendix).toHaveLength(0);
    expect(partition(blocks.slice(at)).body).toHaveLength(0);
    expect(partition(blocks.slice(at)).appendix.length).toBeGreaterThan(0);
  });

  it("出口对账跑过，剩下的违规都带规则号", async () => {
    const r = await runDeepResearchV2(input("x"));
    /*
     * 「跑过」按 trace 上那条收口记录判，不按「有没有报出违规」判：一轮干净的报告和一轮
     * 压根没跑出口对账的报告，在 `violations` 上长得一模一样（都是空的）。
     */
    expect(r.run.trace.some((n) => n.label === "出口对账 · 收口")).toBe(true);
    /*
     * 三层各报各的号：区块结构 `A4-B*`、文字面 `A4-G*`、出口七项 `A4-N*`。合并那一下不许
     * 把号抹平 —— 屏幕上「这一份哪里没过」能不能定位到节点，全靠这个号。
     */
    for (const v of r.violations) expect(v.rule).toMatch(/^A4-[BGN]\d\d$/);
  });

  it("用时与证据条数进了产出 —— 跨版本要能比", async () => {
    const r = await runDeepResearchV2(input("x"));
    /*
     * 量的是「这个数和台账对不对得上」，不是「够不够大」：一轮什么都没搜到是合法结果
     * （离线这一档就是），那时两边都是 0，这一条照样成立。而 `recorded` 被抹成 0、或者
     * 台账进了产出却没计数，两边就对不上了 —— 那才是「跨版本拿它比」这句话失效的时候。
     *
     * 台账那一侧认的是 `assembledFrom` 里 `kind: "ext"` 那几条：`evidenceManifest` 一条
     * 入账证据出一条，而底稿（`shared.ts` 的 `baseManifest`）一条 `ext` 都不出。
     */
    const ledgerItems = (r.doc.assembledFrom ?? []).filter((i) => i.kind === "ext");
    expect(r.evidencing.recorded).toBe(ledgerItems.length);
    // 整轮用时在 `AgentRunRecord.latencyMs`（`ResearchDoc.durationMs` 抄的就是它）——
    // `run` 上没有 `durationMs` 这一栏。
    expect(r.run.latencyMs).toBeGreaterThan(0);
  });
});
