import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const { closeDueRounds } = vi.hoisted(() => ({ closeDueRounds: vi.fn() }));
vi.mock("../src/missionRounds.js", () => ({ closeDueRounds }));
import { createMissionRoundScheduler } from "../src/missionRoundScheduler.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); closeDueRounds.mockReset(); });

describe("Mission round scheduler", () => {
  it("runs at startup and once per minute, passes the application clock and stops cleanly", async () => {
    vi.useFakeTimers();
    const pool = {} as Pool;
    const now = () => new Date("2026-10-03T00:00:00.000Z");
    closeDueRounds.mockResolvedValue(1);
    const scheduler = createMissionRoundScheduler(pool, now);
    scheduler.start();
    scheduler.start();
    expect(closeDueRounds).toHaveBeenCalledExactlyOnceWith(pool, now);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(closeDueRounds).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(closeDueRounds).toHaveBeenCalledTimes(2);
    scheduler.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closeDueRounds).toHaveBeenCalledTimes(2);
  });

  it("logs a failed tick without rejecting and can recover on the next tick", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    closeDueRounds.mockRejectedValueOnce(new Error("temporary database failure")).mockResolvedValueOnce(1);
    const scheduler = createMissionRoundScheduler({} as Pool, () => new Date());
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("temporary database failure"));
    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(closeDueRounds).toHaveBeenCalledTimes(2);
  });
});
