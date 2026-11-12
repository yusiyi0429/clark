import { describe, expect, it, vi } from "vitest";
import type { LocalRunner, TLocalSessionSummary } from "@/lib/local/runner";
const actions = vi.hoisted(() => ({ claimSessionStops: vi.fn(), reportSessionStop: vi.fn(async () => undefined) }));
vi.mock("./actions", () => actions);

import { settleSessionStop } from "./sessionStops";

const DEVICE = "00000000-0000-4000-8000-0000000000d1";
const stop = (sessionId: string) => ({ id: `stop-${sessionId}`, sessionId });
const local = (sessions: Partial<TLocalSessionSummary>[], fail = false) => {
  const kill = vi.fn(async () => { if (fail) throw new Error("连不上"); return {}; });
  return { local: { runner: { kill } as unknown as LocalRunner, sessions: sessions as TLocalSessionSummary[] }, kill };
};

describe("请这台电脑停掉（stop_sub_session）", () => {
  it("在跑的、排着的都请本机停掉，报 stopped（3700：排队的卡 C、D、K、N 原来直接报 not_running、没停）", async () => {
    for (const status of ["running", "waiting_permission", "starting", "queued"] as const) {
      actions.reportSessionStop.mockClear();
      const { local: l, kill } = local([{ id: "s1", status }]);
      await settleSessionStop(stop("s1"), DEVICE, l);
      expect(kill).toHaveBeenCalledWith("s1");
      expect(actions.reportSessionStop).toHaveBeenCalledWith("stop-s1", DEVICE, "stopped");
    }
  });

  it("本机没有这个会话、已经停了的报 not_running，不叫本机停；本机停不掉的不报", async () => {
    for (const sessions of [[], [{ id: "s1", status: "exited" as const }], [{ id: "s1", status: "idle" as const }]]) {
      actions.reportSessionStop.mockClear();
      const { local: l, kill } = local(sessions);
      await settleSessionStop(stop("s1"), DEVICE, l);
      expect(kill).not.toHaveBeenCalled();
      expect(actions.reportSessionStop).toHaveBeenCalledWith("stop-s1", DEVICE, "not_running");
    }
    actions.reportSessionStop.mockClear();
    const { local: l } = local([{ id: "s1", status: "queued" }], true);
    await settleSessionStop(stop("s1"), DEVICE, l);
    expect(actions.reportSessionStop).not.toHaveBeenCalled();
  });
});
