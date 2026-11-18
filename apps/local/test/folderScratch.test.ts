// 「随手」项目在这台电脑上的文件夹（plan-dots 第 3 件）：本机程序自己在 主目录/天枢/随手 建好、加进允许的文件夹、绑到项目。
// 主目录换成临时目录，不碰本人真的主目录。
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalScratchFolderResponse } from "@warmap/contracts";
import { registerFormats } from "../src/store.js";
import { api, pair, startTestRunner, tempDir } from "./helpers.js";

registerFormats();
const SCRATCH = "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10";

describe("「随手」的文件夹", { timeout: 30_000 }, () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  let home: string;
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  const scratch = () => call("POST", "/v1/folders/scratch", { projectId: SCRATCH, projectName: "随手" });
  const target = () => join(home, "天枢", "随手");
  const boundPath = async () => (await call("GET", "/v1/projects")).body.projects.find((p: any) => p.projectId === SCRATCH)?.folder?.path ?? null;

  beforeEach(async () => {
    home = tempDir("tl-home-");
    t = await startTestRunner({ home, dataDir: join(home, "AppData", "tianshu") });
    token = await pair(t.port);
  });
  afterEach(() => t.cleanup());

  it("第一次：建出 主目录/天枢/随手，进了允许的文件夹，绑到这个项目", async () => {
    const r = await scratch();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Value.Check(LocalScratchFolderResponse, r.body)).toBe(true);
    expect(existsSync(target())).toBe(true);
    expect(r.body.folder.path).toBe(target());
    expect(r.body.project).toMatchObject({ projectId: SCRATCH, name: "随手", folder: { id: r.body.folder.id, path: target() } });
    expect((await call("GET", "/v1/folders")).body.folders.map((f: any) => f.path)).toContain(target());
    expect(await boundPath()).toBe(target());
  });

  it("再调一次：不报错，不多建，绑定不变", async () => {
    const first = await scratch();
    const again = await scratch();
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.folder.id).toBe(first.body.folder.id);
    expect(readdirSync(join(home, "天枢"))).toEqual(["随手"]);
    expect((await call("GET", "/v1/folders")).body.folders.filter((f: any) => f.path === target())).toHaveLength(1);
    expect(await boundPath()).toBe(target());
  });

  it("天枢/随手 已经在磁盘上（里面有文件）：不清空，直接加进来绑上", async () => {
    mkdirSync(target(), { recursive: true });
    writeFileSync(join(target(), "草稿.md"), "留着");
    const r = await scratch();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(readdirSync(target())).toEqual(["草稿.md"]);
    expect(await boundPath()).toBe(target());
  });

  it("这个项目已经绑了别的文件夹：不换，回现在绑着的", async () => {
    mkdirSync(join(home, "work"));
    const made = await call("POST", "/v1/folders/create", { name: "老地方", parent: join(home, "work"), projectId: SCRATCH, projectName: "随手" });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const own = join(home, "work", "老地方");
    expect(await boundPath()).toBe(own);
    const r = await scratch();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Value.Check(LocalScratchFolderResponse, r.body)).toBe(true);
    expect(r.body.folder).toMatchObject({ id: made.body.folder.id, path: own });
    expect(r.body.project.folder.path).toBe(own);
    expect(existsSync(target())).toBe(false);
    expect(await boundPath()).toBe(own);
  });

  it("没带项目、项目 id 不对：400，不建", async () => {
    expect((await call("POST", "/v1/folders/scratch", {})).status).toBe(400);
    expect((await call("POST", "/v1/folders/scratch", { projectId: "x" })).status).toBe(400);
    expect((await call("POST", "/v1/folders/scratch", { projectId: SCRATCH, path: "C:/x" })).status).toBe(400);
    expect(existsSync(target())).toBe(false);
  });
});
