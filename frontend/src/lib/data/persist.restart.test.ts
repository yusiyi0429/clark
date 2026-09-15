/**
 * **重启之后第一次「确认并写回」不许崩。**
 *
 * 2026-08-20 在真实例上走完一遍撞到的：Decision 编号原来靠 `store.decisionIds` 这个
 * `Set` 去重，而整个 store 要过一次 `JSON.stringify` 落盘 —— Set 出来是 `{}`。于是
 * 重启之后 `Object.assign(store, restored)` 把它换成一个普通对象，一号位在会后确认
 * 那一页按下「确认并写回」，服务端当场 `decisionIds.has is not a function`，屏幕上
 * 只剩一句「这一次写回没有成功。可能是网络中断了。」—— 而网络好得很。
 *
 * 所以这一条钉的是**跨一次真实重启**：第一程定一件事、落盘；第二程从快照起来，
 * 再定一件事。两件事同一天，所以第二个编号还必须和第一个不同 —— 那份「哪些编号
 * 发过了」不能在重启时丢，否则判断修订史里指认「因哪个决定变的」那个键会重号。
 *
 * 单独一个文件，理由同 `persist.seed-frozen.test.ts`：`persist.ts` 在模块加载时就把
 * `TKOS_DATA_DIR` 读成常量，所以每一程都要先设环境变量再 `vi.resetModules()`。
 * 这里也是唯一一个**真落盘**的测试文件（写到 `os.tmpdir()` 下的临时目录，用完删掉），
 * 别的文件都设 `TKOS_PERSIST=0`。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Closure } from "./types";

// 这台机器上可能导出着真 key。单测不许把钱花出去，也不许出网。
process.env.TKOS_MODEL_MOCK = "1";

let dir = "";

const FIELDS: Closure = {
  choose: "先把这件事定下来",
  notChoose: "",
  why: "",
  keyHypothesis: "",
  riskAccepted: "",
  commitment: "",
  reopenTrigger: "",
};

/**
 * 起一件议题、把草案摆好、定下来，返回这次拿到的 Decision 编号。
 *
 * 草案要手填：产品里它由 A10 写出来，而单测里一次模型调用都不许打。
 */
async function decideSomething(title: string): Promise<string> {
  const { api, __seedClosureDraftForTest } = await import("./store");
  const issue = await api.addIssue(title);
  __seedClosureDraftForTest(issue.id, {
    issueId: issue.id,
    sourceMeetingId: "",
    minutesSinceMeeting: null,
    fields: FIELDS,
    writeBack: null,
    revises: [],
    pastMedianLabel: null,
  });
  const result = await api.confirmClosure(issue.id, FIELDS, "close");
  return result.decisionId;
}

describe("跨一次重启", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tkos-restart-"));
    process.env.TKOS_DATA_DIR = dir;
    // 这个文件要的就是真落盘 —— 别的测试文件设的 0 会让这一整条失去意义。
    delete process.env.TKOS_PERSIST;
    delete process.env.TKOS_SEED_FROZEN;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TKOS_DATA_DIR;
  });

  it("从快照起来之后还能定事，而且编号不和上一程重号", async () => {
    // 第一程
    vi.resetModules();
    const first = await decideSomething("要不要把口径这件事收到一份文档里");
    (await import("./persist")).flushNow();

    // 第二程：同一个 TKOS_DATA_DIR，从刚落下的那份快照起来。
    vi.resetModules();
    const second = await decideSomething("要不要把承接这件事按域拆开");

    // 崩过的就是这一步 —— 抛出来的话上面那句 await 直接把用例判红。
    expect(second).not.toBe(first);
    // 两件事同一天定的，所以第二个必然是同一个日期后面挂 `-2`。
    expect(second.startsWith(first)).toBe(true);
  });
});
