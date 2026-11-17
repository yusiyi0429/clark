import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CMEI_ART } from "@/components/coagent/cmeiArt";
import { BuddyMark } from "./BuddyMark";
import type { Buddy } from "./useBuddy";

const buddy = (form: string) => ({ name: "小天", form }) as Buddy;

describe("伙伴形象：页头、名片", () => {
  it("页头、名片两个位置：胶囊横放，Q 版是圆", () => {
    const capsule = renderToStaticMarkup(<BuddyMark buddy={buddy("classic")} place="head" />);
    expect(capsule).toMatch(/^<span[^>]*data-place="head"/);
    expect(capsule).not.toContain("data-shape");

    const circle = renderToStaticMarkup(<BuddyMark buddy={buddy("miles")} place="card" />);
    expect(circle).toMatch(/^<span[^>]*data-place="card"[^>]*data-shape="circle"/);
    expect(circle).toContain('viewBox="-20 70 900 900"');
  });

  it("状态照传进来的写在 data-state 上", () => {
    expect(renderToStaticMarkup(<BuddyMark buddy={buddy("miles")} place="head" />)).toMatch(/^<span[^>]*data-state="idle"/);
    for (const state of ["thinking", "typing", "done", "listening"] as const) {
      expect(renderToStaticMarkup(<BuddyMark buddy={buddy("miles")} place="head" state={state} />)).toMatch(new RegExp(`^<span[^>]*data-state="${state}"`));
      expect(renderToStaticMarkup(<BuddyMark buddy={buddy("panda")} place="card" state={state} />)).toMatch(new RegExp(`^<span[^>]*data-state="${state}"`));
    }
  });

  it("C妹 的圆也是正方形取景", () => {
    const [, , width, height] = CMEI_ART.head.split(" ").map(Number);
    expect(width).toBe(height);
    expect(renderToStaticMarkup(<BuddyMark buddy={buddy("cmei")} place="head" />)).toContain(`viewBox="${CMEI_ART.head}"`);
  });
});
