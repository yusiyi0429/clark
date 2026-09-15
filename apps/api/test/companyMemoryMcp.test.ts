import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { COMPANY_MEMORY_TOOLS, type TPersonResult, type TSectionMatch, type TSectionSummary } from "@warmap/contracts";
import { buildApp } from "../src/app.js";
import { createTestApp, testEnv, type TestApp } from "./helpers.js";

const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people.json", import.meta.url));
const MEMORY_DIR = fileURLToPath(new URL("./fixtures/company-memory", import.meta.url));

let app: TestApp;
let baseUrl: string;

beforeAll(async () => {
  app = await createTestApp({ companyMemorySeedDir: MEMORY_DIR, companyPeopleSeed: PEOPLE_SEED });
  await app.app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.app.server.address();
  if (!addr || typeof addr === "string") throw new Error("测试服务器未监听");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await app.close();
});

/** 独立 MCP 客户端：与 Pi Runtime 将来使用同一协议入口。 */
function connectClient(token: string | null): Promise<Client> {
  const client = new Client({ name: "standalone-test-client", version: "0.0.0" });
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const transport = new StreamableHTTPClientTransport(new URL("/mcp/company-memory", baseUrl), { requestInit: { headers } });
  return client.connect(transport).then(() => client);
}

async function callTool<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, `工具 ${name} 不应失败`).toBeFalsy();
  const text = result.content[0];
  expect(text?.type).toBe("text");
  return JSON.parse((text as { type: "text"; text: string }).text) as T;
}

describe("CompanyMemory MCP 鉴权边界", () => {
  it("无 token、错误 token、DRI token、CEO session 均被拒绝", async () => {
    const noToken = await app.app.inject({ method: "POST", url: "/mcp/company-memory", payload: {} });
    expect(noToken.statusCode).toBe(401);

    const wrongToken = await app.app.inject({
      method: "POST",
      url: "/mcp/company-memory",
      headers: { authorization: "Bearer wrong-token" },
      payload: {},
    });
    expect(wrongToken.statusCode).toBe(401);

    const driToken = await app.app.inject({
      method: "POST",
      url: "/mcp/company-memory",
      headers: { authorization: `Bearer ${testEnv.driServiceToken}` },
      payload: {},
    });
    expect(driToken.statusCode).toBe(401);

    // CEO session 与 MCP 服务凭据是独立边界，cookie 不能访问 MCP。
    const cookie = await app.loginCookie();
    const ceoSession = await app.app.inject({
      method: "POST",
      url: "/mcp/company-memory",
      headers: { cookie },
      payload: {},
    });
    expect(ceoSession.statusCode).toBe(401);

    await expect(connectClient(null)).rejects.toThrow();
    await expect(connectClient("wrong-token")).rejects.toThrow();
  });
});

describe("CompanyMemory MCP 只读工具契约（独立客户端）", () => {
  it("握手后工具目录只含四个只读工具，与公开契约一致", async () => {
    const client = await connectClient(testEnv.mcpServiceToken);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...COMPANY_MEMORY_TOOLS].sort());
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, `${tool.name} 必须声明只读`).toBe(true);
    }
    await client.close();
  });

  it("search_people 返回 company-people.v1 稳定身份，不从姓名生成 personId", async () => {
    const client = await connectClient(testEnv.mcpServiceToken);
    const result = await callTool<{ people: TPersonResult[] }>(client, "search_people", { query: "测试甲" });
    expect(result.people).toHaveLength(1);
    expect(result.people[0]).toMatchObject({
      personId: "person-fixture-001",
      displayName: "测试甲",
      roles: ["ceo"],
    });
    expect(result.people[0].sourceRef).toContain("company-people.json");
    expect(result.people[0].updatedAt).toBeTruthy();

    const all = await callTool<{ people: TPersonResult[] }>(client, "search_people", {});
    expect(all.people.map((p) => p.personId).sort()).toEqual(["person-fixture-001", "person-fixture-002"]);
    await client.close();
  });

  it("list_sections 返回章节目录，search_sections 按相关度返回章节", async () => {
    const client = await connectClient(testEnv.mcpServiceToken);
    const sections = await callTool<{ sections: TSectionSummary[] }>(client, "list_sections", {});
    expect(sections.sections.map((s) => s.title)).toEqual(["1. 测试战略", "2. 测试业务域"]);
    for (const s of sections.sections) {
      expect(s.id).toMatch(/^company\.md#s\d+$/);
      expect(s.sourceRef).toContain("company.md#");
      expect(s.updatedAt).toBeTruthy();
    }

    const matched = await callTool<{ results: TSectionMatch[] }>(client, "search_sections", { query: "月球基地" });
    expect(matched.results.length).toBeGreaterThan(0);
    expect(matched.results[0].title).toBe("2. 测试业务域");
    expect(matched.results[0].snippet).toContain("月球基地");
    await client.close();
  });

  it("get_passages 读取指定章节段落并带来源，未知章节诚实失败", async () => {
    const client = await connectClient(testEnv.mcpServiceToken);
    const sections = await callTool<{ sections: TSectionSummary[] }>(client, "list_sections", {});
    const target = sections.sections[0];

    const passages = await callTool<{ passages: { id: string; text: string; sourceRef: string; updatedAt: string }[] }>(
      client,
      "get_passages",
      { sectionId: target.id, query: "战略锚点" },
    );
    expect(passages.passages.length).toBeGreaterThan(0);
    expect(passages.passages[0].text).toContain("战略锚点");
    expect(passages.passages[0].sourceRef).toContain("company.md#");
    expect(passages.passages[0].id).toContain(target.id);

    const missing = await client.callTool({ name: "get_passages", arguments: { sectionId: "company.md#s999" } });
    expect(missing.isError).toBe(true);
    await client.close();
  });

  it("不存在 CompanyMemory 写入方法，调用写入工具被拒绝", async () => {
    const client = await connectClient(testEnv.mcpServiceToken);
    const rejected = await client.callTool({ name: "write_sections", arguments: { title: "x", text: "y" } });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected.content)).toContain("未知工具");
    await client.close();
  });
});

describe("company-people.v1 seed 装载与诚实失败边界", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "warmap-seed-"));
  afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

  function writeSeed(name: string, content: string): string {
    const path = join(tempRoot, name);
    writeFileSync(path, content);
    return path;
  }

  const validMemoryDir = fileURLToPath(new URL("./fixtures/company-memory", import.meta.url));

  /** 生产入口语义：buildApp 装载 seed，任何缺失/不合规都必须启动即抛错，不虚构人员或空目录。 */
  async function buildWithSeeds(opts: { people?: string; memoryDir?: string }): Promise<Error> {
    const pool = new Pool({ connectionString: "postgres://localhost:5/no-test-connection" });
    try {
      await buildApp({
        pool,
        env: {
          ...testEnv,
          companyPeopleSeed: opts.people ?? testEnv.companyPeopleSeed,
          companyMemorySeedDir: opts.memoryDir ?? validMemoryDir,
        },
      });
    } finally {
      await pool.end();
    }
    throw new Error("不应到达：seed 不合规时 buildApp 必须抛错");
  }

  it("人员 seed 文件缺失 → 拒绝启动", async () => {
    await expect(buildWithSeeds({ people: join(tempRoot, "missing.json") })).rejects.toThrow(/人员 seed 不存在/);
  });

  it("schemaVersion 不符 / roles 为空 / personId 重复 → 拒绝启动", async () => {
    const wrongVersion = writeSeed(
      "wrong-version.json",
      JSON.stringify({ schemaVersion: "company-people.v2", people: [{ personId: "p1", displayName: "甲", roles: ["ceo"] }] }),
    );
    await expect(buildWithSeeds({ people: wrongVersion })).rejects.toThrow(/company-people\.v1/);

    const emptyRoles = writeSeed(
      "empty-roles.json",
      JSON.stringify({ schemaVersion: "company-people.v1", people: [{ personId: "p1", displayName: "甲", roles: [] }] }),
    );
    await expect(buildWithSeeds({ people: emptyRoles })).rejects.toThrow(/company-people\.v1/);

    const emptyId = writeSeed(
      "empty-id.json",
      JSON.stringify({ schemaVersion: "company-people.v1", people: [{ personId: "", displayName: "甲", roles: ["ceo"] }] }),
    );
    await expect(buildWithSeeds({ people: emptyId })).rejects.toThrow(/company-people\.v1/);

    const duplicate = writeSeed(
      "duplicate.json",
      JSON.stringify({
        schemaVersion: "company-people.v1",
        people: [
          { personId: "p1", displayName: "甲", roles: ["ceo"] },
          { personId: "p1", displayName: "乙", roles: ["dri"] },
        ],
      }),
    );
    await expect(buildWithSeeds({ people: duplicate })).rejects.toThrow(/重复 personId/);
  });

  it("Markdown 目录缺失 / 无章节 → 拒绝启动", async () => {
    await expect(buildWithSeeds({ memoryDir: join(tempRoot, "no-such-dir") })).rejects.toThrow(/种子目录不存在/);
    const emptyDir = join(tempRoot, "empty-md");
    rmSync(emptyDir, { recursive: true, force: true });
    mkdirSync(emptyDir, { recursive: true });
    await expect(buildWithSeeds({ memoryDir: emptyDir })).rejects.toThrow(/没有 \.md 章节/);
  });
});
