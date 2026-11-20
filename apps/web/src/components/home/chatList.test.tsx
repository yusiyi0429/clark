import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TChatListResponse, TChatRow } from "@warmap/contracts";
import { ChatList, chatsDot, previewLine } from "./ChatList";

const at = "2026-11-06T02:00:00.000Z";
const row = (fields: Partial<TChatRow>): TChatRow => ({
  id: "00000000-0000-4000-8000-000000000001", peer: { personId: "p", displayName: "测试研发", left: false }, peerBuddy: null,
  last: { author: "buddy", text: "好的", at }, unread: false, waiting: 0, ...fields,
});
const list: TChatListResponse = { mine: [row({ unread: true })], inbound: [row({ waiting: 1 })], requests: [] };
const line = (author: TChatRow["last"]["author"], side: "with" | "from") => previewLine(row({ last: { author, text: "回滚演练照做", at } }), side, "Miles");
const html = (value: TChatListResponse) => renderToStaticMarkup(<ChatList list={value} view={{ kind: "home" }} myBuddy="Miles" go={() => undefined} />);

describe("左栏对话（设计第 1 节）", () => {
  it("滑块上的点：有人等我是黄的，只有新回复是蓝的", () => {
    expect(chatsDot(list)).toBe("attention");
    expect(chatsDot({ ...list, inbound: [row({})] })).toBe("stopped");
    expect(chatsDot({ mine: [row({})], inbound: [], requests: [] })).toBeNull();
  });

  it("预览前面带谁说的", () => {
    expect(line("owner", "with")).toBe("测试研发：回滚演练照做");
    expect(line("buddy", "with")).toBe("测试研发的伙伴：回滚演练照做");
    expect(line("asker_buddy", "with")).toBe("Miles 替你问的：回滚演练照做");
    expect(line("asker", "with")).toBe("我：回滚演练照做");
    expect(line("buddy", "from")).toBe("Miles：回滚演练照做");
    expect(line("asker", "from")).toBe("测试研发：回滚演练照做");
  });

  it("两组：上组蓝点，下组『来问 Miles 的』黄点；下组没人不画组标题", () => {
    expect(html(list)).toMatch(/data-tone="stopped"[\s\S]*来问 Miles 的[\s\S]*data-tone="attention"/);
    expect(html({ ...list, inbound: [] })).not.toContain("来问 Miles 的");
  });
});
