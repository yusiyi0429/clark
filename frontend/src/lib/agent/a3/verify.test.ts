/*
 * 这一段不碰 store，但要碰模型与检索：`TKOS_MODEL_MOCK=1` 让抓取返回签过名的
 * 假页面、让模型走罐头。测试里既不读也不打印任何 key。
 *
 * 这一行必须是文件里最早的可执行语句，而写在顶上还不够 —— ESM 的静态 import 会被
 * 提到最前面求值。所以下面只留 `import type` 与 vitest 自己的 import，真模块一律
 * 在 `beforeAll` 里 `await import()`。
 *
 * **「一条外部证据都没入账」这一档必须打桩造出来，靠离线跑是造不出来的。**
 * 离线档下 `providers()` 回的是 `[MockSearch]`，而 `MockSearch` → `mockPage` →
 * `CANNED["a4.extract"]` 这条链是通的 —— 不打桩地跑，台账里一定有条目，
 * 这条测试断言的就成了它的反面。所以这里桩掉**测试侧**的 `providers()`：
 * `src/lib/research/search.ts` 一字未动（硬约束），改的只是这个文件看到的它。
 *
 * 桩里那支检索家就是缺 key 那一档在表里的东西：`name: "none"`、搜什么都回空数组。
 * 现搭一个而不是 `new NoSearch()`，因为 `NoSearch` 那个类在 `search.ts` 里
 * **没有导出**（导出它就是「改那个文件」）。
 */
process.env.TKOS_MODEL_MOCK = "1";

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Harness } from "@/lib/agent/harness";
import type { SearchProvider } from "@/lib/research/search";
import type { BlindspotRuling, TargetHit } from "./stages";

vi.mock("@/lib/research/search", async () => {
  const actual = await vi.importActual<typeof import("@/lib/research/search")>("@/lib/research/search");
  const none: SearchProvider = {
    name: "none",
    label: "未启用",
    windowed: false,
    reason: "测试桩：这一档表里有源，但一条都取不到",
    async search() {
      return [];
    },
  };
  return { ...actual, providers: () => ({ list: [none], skipped: [] }) };
});

let verify: typeof import("./verify");
let makeProvenance: typeof import("./provenance").makeProvenance;

beforeAll(async () => {
  verify = await import("./verify");
  ({ makeProvenance } = await import("./provenance"));
});

const hit: TargetHit = {
  target: { kind: "judgment", id: "J-2", text: "今年不会有新玩家" },
  match: "challenges",
  why: "正是新玩家",
  hops: 1,
};
const notBlind: BlindspotRuling = {
  isBlindspot: false,
  proximity: "far",
  hops: null,
  credibility: null,
  magnitude: "unknown",
  why: [],
};

describe("pickBudget", () => {
  it("撞上靶点就给足预算", () => {
    expect(verify.pickBudget({ hits: [hit], blindspot: notBlind })).toBe(verify.BUDGET_HIT);
  });

  it("判成盲区也给足预算", () => {
    expect(verify.pickBudget({ hits: [], blindspot: { ...notBlind, isBlindspot: true } })).toBe(verify.BUDGET_HIT);
  });

  it("既没撞上也不是盲区就给最省的那一档", () => {
    expect(verify.pickBudget({ hits: [], blindspot: notBlind })).toBe(verify.BUDGET_MISS);
  });
});

describe("buildPropositions", () => {
  it("从问题与命中机械造命题 —— 不为了造命题再调一次模型", () => {
    const raw = verify.buildPropositions({
      question: "这家公司做的是不是同类产品？",
      entities: [{ name: "智谱 AI", kind: "company" }],
      hits: [hit],
    });
    const props = raw.propositions as Record<string, unknown>[];
    expect(props[0].statement).toBe("今年不会有新玩家");
    expect(props[0].queries).toContain("智谱 AI 今年不会有新玩家");
    expect(props[props.length - 1].statement).toBe("这家公司做的是不是同类产品？");
    expect(props.every((p) => Array.isArray(p.counterQueries) && (p.counterQueries as string[]).length > 0)).toBe(true);
  });

  it("一条命中都没有时也至少有一条命题（就是那个问题本身）", () => {
    const raw = verify.buildPropositions({ question: "值不值得看？", entities: [], hits: [] });
    expect((raw.propositions as unknown[]).length).toBe(1);
  });
});

describe("verifyExternally", () => {
  it("一条外部证据都没入账时如实回 searchless，一条证据都不编", async () => {
    const notes: string[] = [];
    const h = {
      note(label: string) {
        notes.push(label);
      },
      substep() {},
      async callMessages() {
        return { text: "{}" };
      },
    } as unknown as Harness;

    const r = await verify.verifyExternally(h, {
      question: "值不值得看？",
      entities: [],
      hits: [],
      blindspot: notBlind,
      provenance: makeProvenance("I-7"),
    });
    expect(r).toEqual({ evidence: [], searchless: true, groups: 0 });
    expect(notes.some((n) => n.includes("没有一条外部证据入账"))).toBe(true);
  });
});
