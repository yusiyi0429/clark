/**
 * 种子冻结开关。
 *
 * 单独一个文件：`persist.ts` 在模块加载时就把 `TKOS_DATA_DIR` 读成了常量，所以每个
 * 用例都要先设环境变量、再 `vi.resetModules()` 重新 import。混进别的测试文件会被
 * 已经加载过的那一份挡住（vitest 每个文件一个进程，跨文件不互相污染）。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir = "";

/** 写一份快照，指纹由调用方给 —— 「种子被改过」就是快照指纹与当前指纹不同。 */
function writeSnapshot(fingerprint: string): void {
  writeFileSync(
    join(dir, "store.json"),
    JSON.stringify({ fingerprint, savedAt: "2026-08-19T00:00:00.000Z", state: { issues: ["真实数据"] } }),
    "utf8"
  );
}

async function load(fingerprint: string) {
  vi.resetModules();
  const m = await import("./persist");
  return { state: m.loadSnapshot(fingerprint), drift: m.seedDrift(), frozen: m.seedFrozen() };
}

describe("种子冻结", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tkos-persist-"));
    process.env.TKOS_DATA_DIR = dir;
    delete process.env.TKOS_SEED_FROZEN;
    delete process.env.TKOS_KEEP_SNAPSHOT;
    delete process.env.TKOS_PERSIST;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TKOS_DATA_DIR;
    delete process.env.TKOS_SEED_FROZEN;
  });

  it("没冻结时种子一变就丢快照重建 —— 开发期要的就是这个", async () => {
    writeSnapshot("old");
    const r = await load("new");
    expect(r.state).toBeNull();
    expect(r.drift).toBe(true);
    expect(r.frozen).toBe(false);
  });

  it("冻结之后种子变了也照旧快照跑，真实数据不被抹掉", async () => {
    writeSnapshot("old");
    process.env.TKOS_SEED_FROZEN = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await load("new");
    expect(r.state).toEqual({ issues: ["真实数据"] });
    expect(r.drift).toBe(true);
    expect(r.frozen).toBe(true);
    // 照旧跑但必须喊出来：不喊的话「我改了种子怎么没变」没有任何线索。
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("种子已冻结");
    warn.mockRestore();
  });

  it("指纹一致就是没漂移，冻不冻结都照读", async () => {
    writeSnapshot("same");
    const a = await load("same");
    expect(a.state).toEqual({ issues: ["真实数据"] });
    expect(a.drift).toBe(false);

    process.env.TKOS_SEED_FROZEN = "1";
    const b = await load("same");
    expect(b.state).toEqual({ issues: ["真实数据"] });
    expect(b.drift).toBe(false);
  });

  it("压根没有快照：漂移是 false，不是「不知道」", async () => {
    const r = await load("new");
    expect(r.state).toBeNull();
    expect(r.drift).toBe(false);
  });

  it("还没读过快照时漂移报 null —— /api/health 可能比 store 先跑到", async () => {
    vi.resetModules();
    const m = await import("./persist");
    expect(m.seedDrift()).toBeNull();
  });
});
