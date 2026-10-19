import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DateTimePicker } from "./DatePicker";
import { Select } from "./Select";

// 手持（≤959 或粗指针）：下拉与月历走底部 sheet。
vi.mock("./useHandheld", () => ({ useHandheld: () => true }));

describe("手持下拉（底部 sheet）", () => {
  it("关着时触发器显示已选项，隐藏的原生下拉也有选项", () => {
    const html = renderToStaticMarkup(<Select aria-label="负责人" options={[{ value: "p1", label: "王路遥" }, { value: "p2", label: "李想" }]} value="p1" onChange={() => undefined} />);
    expect(html).toContain("王路遥");
    expect(html).not.toContain("data-placeholder");
    expect(html).toMatch(/<option value="p1"[^>]*>王路遥<\/option>/);
  });
  it("日期时间的时刻显示已选值", () => {
    const html = renderToStaticMarkup(<DateTimePicker label="截止" value="2099-10-23T18:00" onChange={() => undefined} />);
    expect(html).toMatch(/18:00<\/span>/);
  });
});
