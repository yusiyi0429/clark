import { beforeEach, describe, expect, it, vi } from "vitest";

const ui = vi.hoisted(() => ({ values: new Map<string, ReadonlySet<string> | null>(), current: "", effects: [] as (() => void | (() => void))[], get: vi.fn(), post: vi.fn() }));
vi.mock("react", () => ({
  useState: (initial: null) => {
    const id = ui.current;
    if (!ui.values.has(id)) ui.values.set(id, initial);
    return [ui.values.get(id), (value: ReadonlySet<string>) => ui.values.set(id, value)];
  },
  useEffect: (effect: () => void | (() => void)) => ui.effects.push(effect),
  useCallback: (callback: unknown) => callback,
}));
vi.mock("@/lib/api/client", () => ({ browserApi: { GET: ui.get, POST: ui.post } }));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); ui.values.clear(); ui.effects = []; ui.post.mockResolvedValue({ response: { ok: true } }); });

describe("shared first-visit marks", () => {
  it("closing release notes updates the mission guide's separate hook and keeps one server read", async () => {
    ui.get.mockResolvedValue({ data: { keys: [] } });
    const { useSeenMarks } = await import("./useSeenMarks");
    ui.current = "release"; const release = useSeenMarks();
    ui.current = "mission"; useSeenMarks();
    const cleanups = ui.effects.map((effect) => effect());
    await vi.waitFor(() => expect(ui.values.get("mission")).toEqual(new Set()));
    release.mark("release:2026-10");
    expect(ui.values.get("mission")).toEqual(new Set(["release:2026-10"]));
    expect(ui.get).toHaveBeenCalledTimes(1);
    cleanups.forEach((cleanup) => { if (cleanup) cleanup(); });
    release.mark("tour:mission-card");
    expect(ui.values.get("mission")).toEqual(new Set(["release:2026-10"]));
  });
  it("a delayed initial read cannot overwrite a newly completed tour", async () => {
    let resolve!: (value: { data: { keys: string[] } }) => void;
    ui.get.mockReturnValue(new Promise((ready) => { resolve = ready; }));
    const { useSeenMarks } = await import("./useSeenMarks");
    ui.current = "mission"; const mission = useSeenMarks(); ui.effects[0]();
    mission.mark("tour:mission-card"); resolve({ data: { keys: ["release:2026-10"] } });
    await vi.waitFor(() => expect(ui.values.get("mission")).toEqual(new Set(["tour:mission-card", "release:2026-10"])));
  });
});
