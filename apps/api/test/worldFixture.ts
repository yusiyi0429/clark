import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { migrate } from "../src/migrate.js";
import { WorldClient, type WorldInstance } from "../src/worldClient.js";
import { createTestDb, type TestDb } from "./helpers.js";

// 原样摘自 examples-24e6202.md §1、§2、§4（请求/回执）、§11；占位符保持来源一致。
export const examples = JSON.parse(readFileSync(new URL("./fixtures/world-02.json", import.meta.url), "utf8"));
export const worldEnv = { worldApiUrl: "https://world.test", worldAgentToken: "stub-world-token" };
export const instance: WorldInstance = { scope_id: "<scope>", domains: { eo: "<domain:eo>", company: "<domain:company>" }, people: { "liu-renhao": "<principal:eo-owner>", "yu-siyi": "<principal:eo-dri>", "liu-minghua": "<principal:ceo>" } };
export type HttpCall = { url: URL; method: string; body: any; headers: Headers };
export function stubWorld(handler: (call: HttpCall) => unknown | Promise<unknown>) {
  const calls: HttpCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const call = { url: new URL(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init?.headers) };
    calls.push(call);
    const result = await handler(call);
    return result instanceof Response ? result : Response.json(result);
  }));
  return calls;
}
export async function withWorld(run: (client: WorldClient, db: TestDb) => Promise<void>) {
  await createTestDb(async (db) => {
    await migrate(db.db);
    await run(new WorldClient(db.pool.query.bind(db.pool), worldEnv, instance), db);
  });
}
export function projection(head: any) {
  return { business: { ...head, attributes: { external_refs: head.external_refs ?? [] } }, records: { lifecycle: head.lifecycle } };
}
