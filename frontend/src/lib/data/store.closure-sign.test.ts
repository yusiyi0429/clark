/*
 * 会后闭环单签发之后，被这场会覆盖的每件议题的「最近动静」要跟着动。
 *
 * 这一条钉的是 `signClosure` 里那一行 `touch(issue, at)`。它曾经在一次改动里被顺手删掉
 * （那次改的是另一个函数），而全仓一千一百多条测试没有一条会红 —— 签发是这件议题身上
 * 最重的一次动静（状态推到已拍板、判断改版、重开条件布控），删掉之后屏幕上「最近动静」
 * 那一栏里它还停在会前的位置，而账面上什么都不缺。
 *
 * 环境变量必须在任何摸到 `store.ts` 的 import 之前设好（成例见 `store.judgements.test.ts`
 * 头部），所以下面只有 `import type`，真模块在 `beforeAll` 里 `await import()`。
 * 跑 demo 那一档：内容包里有一场开完的会和一份还没签发的闭环单，live 档里两样都没有。
 */
process.env.TKOS_MODE = "demo";
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

import { beforeAll, describe, expect, it } from "vitest";
import type { api as Api } from "./store";

let api: typeof Api;

beforeAll(async () => {
  api = (await import("./store")).api;
});

describe("会后闭环单签发", () => {
  it("签发之后，被这场会覆盖的议题「最近动静」就是签发那一刻", async () => {
    const closure = await api.getMeetingClosure("BIZ-TK");
    expect(closure).not.toBeNull();
    expect(closure!.signedAt).toBeUndefined(); // 还没签过，下面这一次才是第一次

    /*
     * 取一件**真在库里、且这次要签的**议题。圈除的那几条不写回，也就不该被 touch；
     * `signClosure` 对找不到的 `issueRef` 是跳过，所以这里先按真议题过滤 ——
     * 挑到一个不存在的 id，下面那两条断言会因为「取不到这件议题」而报别的错。
     */
    const issues = await api.listIssues();
    const covered = closure!.items
      .filter((i) => !i.excluded)
      .map((i) => i.issueRef)
      .find((id) => issues.some((x) => x.id === id));
    expect(covered).toBeDefined();

    const before = issues.find((x) => x.id === covered)!.updatedAt;
    /*
     * 隔开一毫秒再签。单测里 `sleep()` 是个 `Promise.resolve()`（`TKOS_FAKE_LATENCY`
     * 默认关），同一毫秒内 `nowIso()` 回同一个串 —— 那时候「没动」和「动了」长得一样。
     */
    await new Promise((done) => setTimeout(done, 5));

    const receipt = await api.signClosure(closure!.meetingId);

    const after = (await api.getIssue(covered!)).updatedAt;
    expect(after).not.toBe(before);
    // 更贴题的那一条：动到的正是签发那一刻，不是别处顺手改的某个时刻。
    expect(after).toBe(receipt.signedAt);
  });
});
