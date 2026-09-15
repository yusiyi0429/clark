/**
 * 轮内取一次的分派。
 *
 * 这里最要紧的一条是**「items 空着不等于没取到」**：叙述那一支永远交空的 `items`，
 * 正文在 `recall` 里。上面那扇门（`ontologyLookupForChat`）如果照旧路那条「items 空
 * 就判 not_found」走，每一次取本体都会被报成「公司没记过这条」，而它手上明明有一整段。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return { ...actual, request: requestMock };
});

const lookupMembersMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/graphknowledge", async () => {
  const actual = await vi.importActual<typeof import("@/lib/graphknowledge")>("@/lib/graphknowledge");
  return { ...actual, lookupMembers: lookupMembersMock };
});

const { lookupOntology } = await import("./lookup");

const KEYS = ["TKOS_MEMORY_API_BASE_URL", "TKOS_MEMORY_API_KEY", "TKOS_ONTOLOGY_SOURCE"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.TKOS_MEMORY_API_BASE_URL = "https://memory.test";
  process.env.TKOS_MEMORY_API_KEY = "k";
  delete process.env.TKOS_ONTOLOGY_SOURCE;
  requestMock.mockReset();
  lookupMembersMock.mockReset();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const reply = () => ({
  statusCode: 200,
  body: {
    text: async () =>
      JSON.stringify({
        query: "M1-A 是什么",
        narrative: "M1-A 战略决策机制让组织围绕同一个议题持续形成可追溯的判断。",
        model: "deepseek-v4-flash-ga-260731",
        hit_paths: 2,
        lateral_nodes: 0,
      }),
  },
});

describe("lookupOntology", () => {
  it("默认走叙述那一支：items 空、正文在 recall 里", async () => {
    requestMock.mockResolvedValue(reply());
    const r = await lookupOntology("M1-A 是什么");
    expect(r.mode).toBe("narrative");
    expect(r.items).toEqual([]);
    expect(r.recall).toContain("M1-A");
    expect(lookupMembersMock).not.toHaveBeenCalled();
  });

  it("压缩模型进 warning —— 摆到模型面前的不是图里的原话，对谈里最容易把它当原话复述", async () => {
    requestMock.mockResolvedValue(reply());
    expect((await lookupOntology("M1-A 是什么")).warning).toContain("deepseek-v4-flash-ga-260731");
  });

  it("**长得像短码的问句也照样走叙述** —— 这一支没有按编号取那条路", async () => {
    requestMock.mockResolvedValue(reply());
    const r = await lookupOntology("01-J2");
    expect(r.mode).toBe("narrative");
    expect(JSON.parse(requestMock.mock.calls[0][1].body as string).query).toBe("01-J2");
  });

  it("TKOS_ONTOLOGY_SOURCE=graph 时转回旧路", async () => {
    process.env.TKOS_ONTOLOGY_SOURCE = "graph";
    lookupMembersMock.mockResolvedValue({ mode: "code", sent: "01-J2", items: [], recall: "", warning: "" });
    const r = await lookupOntology("01-J2");
    expect(r.mode).toBe("code");
    expect(requestMock).not.toHaveBeenCalled();
  });
});
