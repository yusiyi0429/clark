// 换文件夹更灵活（设计 17.2 第 32 条）：选文件夹可一步绑项目；新建文件夹（名字校验、父目录只能在主目录或已允许的文件夹下）。
// 主目录换成临时目录，不碰本人真的桌面；系统选文件夹窗口也是假的（真窗口那条路写进给本人的测试步骤）。
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { LocalFolderCreateResponse } from "@warmap/contracts";
import { folderNameProblem } from "../src/folders.js";
import { registerFormats } from "../src/store.js";
import { api, pair, startTestRunner, tempDir } from "./helpers.js";

registerFormats();
const PROJECT = "6b0f3a52-4d0c-4c1e-9a43-1f7d2c9b8e10";

describe("新建文件夹的名字", () => {
  it("一层的名字；路径分隔符、非法字符、点和空格结尾、Windows 保留名都不行", () => {
    for (const ok of ["天枢新项目", "my-app", "v1.2 草稿", "CONSOLE", "com10"]) expect(folderNameProblem(ok), ok).toBeNull();
    for (const bad of ["a/b", "a\\b", "C:", "x?", "a<b", "x|y", "a\u0001b", ".", "..", "草稿.", "草稿 ", "CON", "con.txt", "Nul", "COM1", "lpt9.md", " "]) {
      expect(folderNameProblem(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });
});

describe("换文件夹", { timeout: 30_000 }, () => {
  let t: Awaited<ReturnType<typeof startTestRunner>>;
  let token: string;
  const home = tempDir("tl-home-");
  const work = tempDir("tl-pickwork-"); // 系统窗口里「选中」的文件夹，不在假主目录下
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);

  beforeAll(async () => {
    mkdirSync(join(home, "Desktop"));
    t = await startTestRunner({ pickFolder: work, home, dataDir: join(home, "AppData", "tianshu") });
    token = await pair(t.port);
  });
  afterAll(() => t.cleanup());

  it("选文件夹带项目：选中后一步绑上；不带就和原来一样", async () => {
    const r = await call("POST", "/v1/folders/pick", { projectId: PROJECT, projectName: "天枢" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.project).toMatchObject({ projectId: PROJECT, name: "天枢", folder: { id: r.body.folder.id } });
    const plain = await call("POST", "/v1/folders/pick", {});
    expect(plain.body.project).toBeUndefined();
    expect((await call("POST", "/v1/folders/pick", { path: "C:/x" })).status).toBe(400);
  });

  it("新建：默认建在桌面，空的、加进允许的文件夹，带项目就一步绑上", async () => {
    const r = await call("POST", "/v1/folders/create", { name: "天枢新项目", projectId: PROJECT, projectName: "天枢" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Value.Check(LocalFolderCreateResponse, r.body)).toBe(true);
    const path = join(home, "Desktop", "天枢新项目");
    expect(r.body.folder.path).toBe(path);
    expect(readdirSync(path)).toEqual([]);
    expect((await call("GET", "/v1/folders")).body.folders.map((f: any) => f.path)).toContain(path);
    expect((await call("GET", "/v1/projects")).body.projects.find((p: any) => p.projectId === PROJECT).folder.path).toBe(path);
  });

  it("名字不对、重名（不分大小写）不建", async () => {
    const bad = await call("POST", "/v1/folders/create", { name: "CON" });
    expect([bad.status, bad.body.error.message]).toEqual([400, "「CON」是 Windows 保留的名字，换一个"]);
    expect((await call("POST", "/v1/folders/create", { name: "a/b" })).status).toBe(400);
    expect((await call("POST", "/v1/folders/create", { name: "Demo" })).status).toBe(200);
    const dup = await call("POST", "/v1/folders/create", { name: "demo" });
    expect([dup.status, dup.body.error.code]).toEqual([409, "conflict"]);
  });

  it("父目录：主目录下、已允许的文件夹下可以；别处、相对路径、不存在的、本机数据目录里不行", async () => {
    const sub = join(home, "work");
    mkdirSync(sub);
    expect((await call("POST", "/v1/folders/create", { name: "甲", parent: sub })).body.folder.path).toBe(join(sub, "甲"));
    expect((await call("POST", "/v1/folders/create", { name: "乙", parent: work })).body.folder.path).toBe(join(work, "乙")); // 选过的文件夹
    const outside = tempDir("tl-outside-");
    const no = await call("POST", "/v1/folders/create", { name: "丙", parent: outside });
    expect([no.status, no.body.error.message]).toEqual([400, "只能建在你的主目录下，或已经允许的文件夹下"]);
    expect(existsSync(join(outside, "丙"))).toBe(false);
    expect((await call("POST", "/v1/folders/create", { name: "丁", parent: "Desktop" })).status).toBe(400);
    expect((await call("POST", "/v1/folders/create", { name: "戊", parent: join(home, "nope") })).status).toBe(400);
    const data = await call("POST", "/v1/folders/create", { name: "己", parent: join(home, "AppData", "tianshu") });
    expect([data.status, data.body.error.message]).toEqual([400, "这个文件夹里有 Claude 或天枢本机程序的登录信息和钥匙，不能选"]);
  });
});
