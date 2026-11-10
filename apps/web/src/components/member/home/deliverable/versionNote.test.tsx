import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TDeliverableVersion } from "@warmap/contracts";

/** 交付以后伙伴写的版本说明：左边那颗是本人选的伙伴形象（PR #80 走查：原来写死了蓝色胶囊）。 */
const state = vi.hoisted(() => ({ buddy: null as unknown }));
vi.mock("@/components/buddy/useBuddy", () => ({ useBuddy: () => ({ buddy: state.buddy, loading: false }) }));

import { VersionNote } from "./VersionNote";

const done = { status: "done" as const, achieved: "v2 达成了", gain: null, why: null, lesson: null, edited: false, dismissed: false };
const version = (note: TDeliverableVersion["note"]): TDeliverableVersion => ({
  id: "11111111-1111-4111-8111-111111111111", number: 2, statement: null, createdAt: "2026-10-29T10:00:00.000Z", items: [],
  review: { status: "done", phase: null, startedAt: null, finishedAt: null, expectedSeconds: 120, basis: "acceptance", headline: null, summary: null, gain: null,
    mismatch: null, score: 100, met: 1, total: 1, ready: true, criteria: [], beyondScope: [], error: null },
  deliveredAt: new Date().toISOString(), note,
});
const render = (note: TDeliverableVersion["note"]) =>
  renderToStaticMarkup(<VersionNote version={version(note)} canEdit onPatch={async () => null} onWithdraw={async () => null} />);

beforeEach(() => { state.buddy = null; });

describe("版本说明的伙伴形象", () => {
  it("本人选了哪种就画哪种；伙伴在写这一版说明时它在说，写完待机", () => {
    state.buddy = { name: "团团", form: "panda", personality: "steady" };
    expect(render(done)).toMatch(/data-skin="panda"[^>]*>.*data-pose="idle"/);
    expect(render({ ...done, status: "writing", achieved: null })).toMatch(/data-skin="panda"[^>]*>.*data-pose="speaking"/);
    state.buddy = { name: "小天", form: "alive", personality: "steady" };
    expect(render(done)).toMatch(/data-skin="alive"/);
  });

  it("还没选伙伴：默认那颗胶囊", () => {
    expect(render(done)).toMatch(/data-skin="classic"/);
  });
});
