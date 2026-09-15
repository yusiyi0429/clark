import { afterEach, describe, expect, it } from "vitest";

import { companyContextForChat } from "./company-context";

/*
 * 单独一个文件，因为这几条用例要跑**真的**取上下文那一路 —— 一路到客户端真的去连一个
 * 连不上的地址。跟打了桩的用例放一起，桩会把真链路挡掉（或者反过来，`mockReset` 之后
 * 桩变回真函数，谁在跑就说不清了）。
 *
 * 两个源各跑一遍：它们是两个客户端、两个异常类，而这条性质（对话不就地失败）必须在
 * 两边都成立。设置全靠环境变量 —— 两处 settings 都是每次调用现读 env 的，不用碰模块缓存。
 */
const KEYS = [
  "TKOS_ONTOLOGY_SOURCE",
  "TKOS_GRAPHKNOWLEDGE_BASE_URL",
  "TKOS_MEMORY_API_BASE_URL",
  "TKOS_MEMORY_API_KEY",
] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

/** 9 号端口是 discard，连不上。 */
const SOURCES = [
  {
    name: "本体叙述接口（默认这一支）",
    setup: () => {
      delete process.env.TKOS_ONTOLOGY_SOURCE;
      process.env.TKOS_MEMORY_API_BASE_URL = "http://127.0.0.1:9";
      process.env.TKOS_MEMORY_API_KEY = "x";
    },
  },
  {
    name: "GraphKnowledge（TKOS_ONTOLOGY_SOURCE=graph）",
    setup: () => {
      process.env.TKOS_ONTOLOGY_SOURCE = "graph";
      process.env.TKOS_GRAPHKNOWLEDGE_BASE_URL = "http://127.0.0.1:9/graph";
    },
  },
] as const;

describe.each(SOURCES)("companyContextForChat 的有意分歧 · $name", ({ setup }) => {
  it("对话路径故意不就地失败：本体不可达也不抛，只是不带上下文", async () => {
    // 这条用例锁的是仓库里唯一一处「不就地失败」。A1a/A3/A4 拿不到上下文必须抛，
    // 对话不抛 —— 理由写在 company-context.ts 的 JSDoc 里。
    // 下一个人读到那段 catch，最合理的动作恰恰是「修正」成往外抛，那会让本体
    // 一停机对话栏就 500。这里红了，说明那个「修正」发生了，不是这里写错了。
    setup();

    const r = await companyContextForChat("毛利率为什么下滑");

    expect(r.block).toBeNull();
    expect(r.note).toContain("本体服务不可达");
    expect(r.note).toMatch(/\d+ms/);
  });
});
