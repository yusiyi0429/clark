import { describe, expect, it } from "vitest";
import { escapeStep, type EscapeContext } from "./escapeChain";

const base: EscapeContext = { modalOpen: false, editableFocused: false, peek: false, railMobileOpen: false, deskOpen: false,
  conversationLayer: false, detailOpen: true, parent: null };

describe("Esc 顺序（C-06 + 讨论台）", () => {
  it("每次只收最上面一层：输入框 → peek → 窄屏浮层 → 讨论台 → 对话层 → 二级页", () => {
    const all = { ...base, editableFocused: true, peek: true, railMobileOpen: true, deskOpen: true, conversationLayer: true };
    expect(escapeStep(all)).toEqual({ kind: "blur" });
    expect(escapeStep({ ...all, editableFocused: false })).toEqual({ kind: "peek" });
    expect(escapeStep({ ...all, editableFocused: false, peek: false })).toEqual({ kind: "railMobile" });
    expect(escapeStep({ ...all, editableFocused: false, peek: false, railMobileOpen: false })).toEqual({ kind: "desk" });
    expect(escapeStep({ ...base, conversationLayer: true })).toEqual({ kind: "conversation" });
    expect(escapeStep(base)).toEqual({ kind: "close" });
  });

  it("模态对话框开着全部交给它；视图内下一级先回上一级；首页上没有二级页可离开", () => {
    expect(escapeStep({ ...base, modalOpen: true, deskOpen: true })).toEqual({ kind: "ignore" });
    expect(escapeStep({ ...base, parent: "/radar" })).toEqual({ kind: "parent", href: "/radar" });
    expect(escapeStep({ ...base, detailOpen: false })).toEqual({ kind: "ignore" });
  });

  it("深度讨论开着：先收它，下一下才回上一级 / 关二级页", () => {
    expect(escapeStep({ ...base, deskOpen: true })).toEqual({ kind: "desk" });
    expect(escapeStep({ ...base, deskOpen: true, parent: "/missions" })).toEqual({ kind: "desk" });
    expect(escapeStep({ ...base, parent: "/missions" })).toEqual({ kind: "parent", href: "/missions" });
  });
});

describe("页内上一层（巡检 P1-14：会议页看材料时 Esc）", () => {
  it("先回到这一页的主视图，下一下才离开二级页；对话层、讨论台仍排在它前面", () => {
    expect(escapeStep({ ...base, innerBack: true })).toEqual({ kind: "inner" });
    expect(escapeStep({ ...base, innerBack: true, conversationLayer: true })).toEqual({ kind: "conversation" });
    expect(escapeStep({ ...base, innerBack: true, deskOpen: true })).toEqual({ kind: "desk" });
    expect(escapeStep({ ...base, innerBack: false })).toEqual({ kind: "close" });
  });
});
