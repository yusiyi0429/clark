import { expect, test } from "vitest";
import { createTestDb } from "./helpers.js";
import { migrate } from "../src/migrate.js";
import { traceThread, traceAttempt } from "../src/traceIdentity.js";
import { v7 } from "uuid";

test("durable thread and attempt identity survives independent database clients", async () => {
  await createTestDb(async ({ pool, db }) => {
    await migrate(db);
    const thread = await traceThread(db.query.bind(db), "conversation:one");
    expect(thread).toMatch(/^[a-f0-9-]{14}7[a-f0-9-]{21}$/);
    expect(await traceThread(pool.query.bind(pool), "conversation:one")).toBe(
      thread,
    );
    expect(
      await traceThread(pool.query.bind(pool), "conversation:two"),
    ).not.toBe(thread);
    const logical = v7();
    expect(await traceAttempt(db.query.bind(db), thread, logical)).toBe(1);
    expect(await traceAttempt(pool.query.bind(pool), thread, logical)).toBe(2);
    expect(await traceAttempt(pool.query.bind(pool), thread, v7())).toBe(1);
  });
});
