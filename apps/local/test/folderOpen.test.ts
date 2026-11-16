// 在资源管理器中显示（11/16，输入框下面的文件夹菜单）：只认登记过的文件夹 id，路径由本机自己查；打开那一下换成记录，不弹真的窗口。
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, pair, startTestRunner, tempDir } from "./helpers.js";

describe("在资源管理器中显示", { timeout: 30_000 }, () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const opened: string[] = [];
  let picked = tempDir("tl-openwork-"); // 系统窗口里「选中」的文件夹
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);

  beforeAll(async () => {
    t = await startTestRunner({ pickFolder: () => picked, openFolder: async (path) => { opened.push(path); } });
    token = await pair(t.port);
  });
  afterAll(() => t.cleanup());

  it("登记过的文件夹：本机按 id 查出路径打开", async () => {
    const { folder } = (await call("POST", "/v1/folders/pick", {})).body;
    const r = await call("POST", `/v1/folders/${folder.id}/open`, {});
    expect([r.status, r.body]).toEqual([200, { ok: true }]);
    expect(opened).toEqual([folder.path]);
  });

  it("没登记的 id 回 404，不打开", async () => {
    const r = await call("POST", "/v1/folders/nope123/open", {});
    expect([r.status, r.body.error.code]).toEqual([404, "not_found"]);
    expect(opened).toHaveLength(1);
  });

  it("不收路径：带了 path 回 400，不打开", async () => {
    const { folder } = (await call("POST", "/v1/folders/pick", {})).body;
    const r = await call("POST", `/v1/folders/${folder.id}/open`, { path: "C:\\Windows" });
    expect(r.status).toBe(400);
    expect(opened).toHaveLength(1);
  });

  it("文件夹在磁盘上已经没了回 404，不打开", async () => {
    picked = join(tempDir("tl-gone-"), "x");
    mkdirSync(picked);
    const { folder } = (await call("POST", "/v1/folders/pick", {})).body;
    rmSync(picked, { recursive: true });
    const r = await call("POST", `/v1/folders/${folder.id}/open`, {});
    expect(r.status).toBe(404);
    expect(opened).toHaveLength(1);
  });
});
