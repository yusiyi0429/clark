/**
 * 两个源的分派，以及叙述那一支交出去的 `OpenedContext` 长什么样。
 *
 * 这里锁住的大多是**不许填假值**那一类：`anchorCode` 空着、`memberIds` 空着、
 * `mode` 是第三档。它们看起来都是「少填了几格」，而每一格填上去都会让下游读出
 * 一个不存在的事实 —— 这几条用例就是为了让那种填补在改动时立刻变红。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return { ...actual, request: requestMock };
});

/*
 * 旧路那一支整个换掉：这个文件验的是**分派**，不是 GraphKnowledge 自己那一套
 * （它有自己的一批用例）。不换的话这里会真的去打图服务的地址。
 */
const openGraphMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/graphknowledge", async () => {
  const actual = await vi.importActual<typeof import("@/lib/graphknowledge")>("@/lib/graphknowledge");
  return { ...actual, openContext: openGraphMock };
});

const { openOntologyContext } = await import("./context");

const KEYS = [
  "TKOS_MEMORY_API_BASE_URL",
  "TKOS_MEMORY_API_KEY",
  "TKOS_ONTOLOGY_SOURCE",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.TKOS_MEMORY_API_BASE_URL = "https://memory.test";
  process.env.TKOS_MEMORY_API_KEY = "k";
  delete process.env.TKOS_ONTOLOGY_SOURCE;
  requestMock.mockReset();
  openGraphMock.mockReset();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const reply = (over: Record<string, unknown> = {}) => ({
  statusCode: 200,
  body: {
    text: async () =>
      JSON.stringify({
        query: "q",
        tenant: "local",
        org: "local-org",
        hit_paths: 2,
        lateral_nodes: 0,
        root_statement: "公司经营愿景是……",
        narrative: "一段公司经营脉络。",
        narrative_raw_chars: 1851,
        narrative_chars: 762,
        model: "deepseek-v4-flash-ga-260731",
        ...over,
      }),
  },
});

const base = {
  recipe: "S03" as const,
  prefix: "ISS-" as const,
  channel: "A4" as const,
  q: "交付侧入口要不要自建",
};

describe("换源开关", () => {
  it("不填就是叙述那一支 —— 留空是「留了这一行没填值」，不该被读成「要走旧路」", async () => {
    requestMock.mockResolvedValue(reply());
    const opened = await openOntologyContext(base);
    expect(opened.mode).toBe("narrative");
    expect(openGraphMock).not.toHaveBeenCalled();
  });

  it("写别的值也走叙述那一支 —— 只有恰好等于 graph 才算切回去", async () => {
    process.env.TKOS_ONTOLOGY_SOURCE = "graphknowledge";
    requestMock.mockResolvedValue(reply());
    expect((await openOntologyContext(base)).mode).toBe("narrative");
    expect(openGraphMock).not.toHaveBeenCalled();
  });

  it("TKOS_ONTOLOGY_SOURCE=graph 时原样转给旧路，判断号照旧传下去", async () => {
    process.env.TKOS_ONTOLOGY_SOURCE = "graph";
    openGraphMock.mockResolvedValue({ mode: "anchored" });
    await openOntologyContext({ ...base, judgmentCodes: ["01-J2"] });
    expect(requestMock).not.toHaveBeenCalled();
    expect(openGraphMock).toHaveBeenCalledWith(
      expect.objectContaining({ recipe: "S03", channel: "A4", judgmentCodes: ["01-J2"] })
    );
  });
});

describe("叙述那一支交出去的东西", () => {
  it("mode 是第三档，正文进 bundle，快照冻得下来", async () => {
    requestMock.mockResolvedValue(reply());
    const opened = await openOntologyContext(base);
    expect(opened.mode).toBe("narrative");
    expect(opened.bundle?.renderedMarkdown).toBe("一段公司经营脉络。");
    expect(opened.snapshotId).toMatch(/^ctx-/);
  });

  it("**anchorCode 空着、memberIds 空着** —— 这一支没有锚点也没有可引编号", async () => {
    requestMock.mockResolvedValue(reply());
    const opened = await openOntologyContext(base);
    expect(opened.bundle?.anchorCode).toBe("");
    expect(opened.bundle?.memberIds).toEqual([]);
    expect(opened.anchor).toBeNull();
    expect(opened.anchorOrigin).toBeNull();
  });

  it("noAnchorReason 不许写成「图谱里没有对应锚点」—— 那是旧路的一条分支，这一支根本没有锚点", async () => {
    requestMock.mockResolvedValue(reply());
    const opened = await openOntologyContext(base);
    expect(opened.noAnchorReason).toContain("不产生锚点");
    expect(opened.noAnchorReason).not.toContain("图谱里没有");
  });

  it("staticContext 空着 —— 正文只在 bundle 里放一份，两处会各自漂移", async () => {
    requestMock.mockResolvedValue(reply());
    expect((await openOntologyContext(base)).staticContext).toBe("");
  });

  it("**传了判断号要在 trace 上说它没进去** —— 「传了没用」和「没传」在产出上长得一样", async () => {
    requestMock.mockResolvedValue(reply());
    const opened = await openOntologyContext({ ...base, judgmentCodes: ["01-J2", "01-J3"] });
    const n = opened.trace.find((x) => x.label.includes("不吃判断号"));
    expect(n).toBeDefined();
    expect(n!.detail.judgmentCodes).toEqual(["01-J2", "01-J3"]);
  });

  it("钉住的锚点同理 —— 复现旧运行要连换源开关一起钉回去", async () => {
    requestMock.mockResolvedValue(reply());
    const opened = await openOntologyContext({ ...base, anchorCode: "ISS-D6" });
    expect(opened.trace.some((x) => x.label.includes("不吃钉住的锚点"))).toBe(true);
  });

  it("上游那个压缩模型要进 trace —— 这段话是它写的，不是图里的原文", async () => {
    requestMock.mockResolvedValue(reply());
    const opened = await openOntologyContext(base);
    const n = opened.trace.find((x) => x.label.includes("已取回"));
    expect(n!.detail.model).toBe("deepseek-v4-flash-ga-260731");
  });

  it("要了原文却只拿回压缩版时记一条告警，但**不失败这一次运行**", async () => {
    requestMock.mockResolvedValue(reply());
    const opened = await openOntologyContext({ ...base, includeRaw: true });
    expect(opened.mode).toBe("narrative");
    expect(opened.warnings.join()).toContain("吃的是压缩版");
  });

  it("问句超长要裁并留告警 —— 裁的口径复用旧路那一份，不另抄一个常量", async () => {
    requestMock.mockResolvedValue(reply());
    const opened = await openOntologyContext({ ...base, q: "问".repeat(300) });
    expect(opened.warnings.join()).toContain("裁到");
    const sent = JSON.parse(requestMock.mock.calls[0][1].body as string).query as string;
    expect(sent.length).toBeLessThan(300);
  });

  it("上游挂了要**原样抛**，不许折成一次「没有公司上下文」的正常运行", async () => {
    requestMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(openOntologyContext(base)).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("回放冻结快照（TKOS_ONTOLOGY_SNAPSHOT，2026-09-04）", () => {
  afterEach(() => {
    delete process.env.TKOS_ONTOLOGY_SNAPSHOT;
  });

  it("有这个快照就不打上游：正文是那一次真取回的原文，trace 与 warnings 都写明来自快照", async () => {
    requestMock.mockResolvedValue(reply());
    const first = await openOntologyContext(base);
    requestMock.mockReset();
    requestMock.mockRejectedValue(new Error("上游躺了，这一次不该被调用"));

    process.env.TKOS_ONTOLOGY_SNAPSHOT = first.snapshotId ?? "";
    const replayed = await openOntologyContext(base);
    expect(requestMock).not.toHaveBeenCalled();
    expect(replayed.mode).toBe("narrative");
    expect(replayed.snapshotId).toBe(first.snapshotId);
    expect(replayed.bundle?.renderedMarkdown).toBe("一段公司经营脉络。");
    expect(replayed.warnings.join("\n")).toMatch(/来自冻结快照/);
    expect(replayed.trace.some((t) => t.label === "本体叙述来自冻结快照")).toBe(true);
  });

  it("问句和快照里的不一样时记告警但不拦 —— 那是调用方要的对照条件", async () => {
    requestMock.mockResolvedValue(reply());
    const first = await openOntologyContext(base);
    process.env.TKOS_ONTOLOGY_SNAPSHOT = first.snapshotId ?? "";
    const replayed = await openOntologyContext({ ...base, q: "另一个议题" });
    expect(replayed.warnings.join("\n")).toMatch(/问句与本次不同/);
  });

  it("快照不存在就照旧打上游，并在 trace 上说未命中 —— 不静默降级", async () => {
    process.env.TKOS_ONTOLOGY_SNAPSHOT = "ctx-0000000000000000";
    requestMock.mockResolvedValue(reply());
    const opened = await openOntologyContext(base);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(opened.trace.some((t) => t.label === "本体叙述回放未命中")).toBe(true);
  });
});
