import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { DatePicker, DateTimePicker } from "./DatePicker";
import { Select } from "./Select";
import { dateLabel, dateTimeLabel, splitDateTime, timeOptions } from "./pickerFormat";

const css = readFileSync(new URL("./picker.module.css", import.meta.url), "utf8");
const now = new Date("2026-10-12T04:00:00Z");

describe("pickerFormat（中文日期）", () => {
  it("「10 月 15 日 周四」，不在今年才带年份", () => {
    expect(dateLabel("2026-10-15", now)).toBe("10 月 15 日 周四");
    expect(dateLabel("2027-01-04", now)).toBe("2027 年 1 月 4 日 周一");
    expect(dateLabel("", now)).toBe("");
    expect(dateLabel("10/15", now)).toBe("");
  });
  it("日期时间「10 月 15 日 周四 10:00」，拆分与原生 datetime-local 同形", () => {
    expect(dateTimeLabel("2026-10-15T10:00", now)).toBe("10 月 15 日 周四 10:00");
    expect(splitDateTime("2026-10-15T09:30")).toEqual({ date: "2026-10-15", time: "09:30" });
    expect(splitDateTime("")).toEqual({ date: "", time: "" });
  });
  it("时刻每 15 分钟一档，不在档上的当前值也保留并排好序", () => {
    const slots = timeOptions("10:20");
    expect(slots).toHaveLength(97);
    expect(slots.slice(41, 44)).toEqual(["10:15", "10:20", "10:30"]);
    expect(timeOptions("", 30)).toHaveLength(48);
  });
  it("给了最晚时刻：晚于它的不列（当前值照留）", () => {
    expect(timeOptions("", 15, "09:05").at(-1)).toBe("09:00");
    expect(timeOptions("10:00", 15, "09:05").at(-1)).toBe("10:00");
  });
});

describe("Select（统一下拉）", () => {
  const options = [{ value: "", label: "待指派" }, { value: "p1", label: "王路遥" }, { value: "p2", label: "李想", description: "产品战场" }];
  it("不是原生下拉：按钮触发器 + 中文名，显示当前选项", () => {
    const html = renderToStaticMarkup(<Select aria-label="负责人" options={options} value="p1" onChange={() => undefined} />);
    expect(html).toContain('data-slot="field-trigger"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain("王路遥");
    expect(html).toContain('aria-label="负责人"');
  });
  it("空串是合法值（「待指派」），未知值显示占位", () => {
    expect(renderToStaticMarkup(<Select aria-label="负责人" options={options} value="" onChange={() => undefined} />)).toContain("待指派");
    const html = renderToStaticMarkup(<Select aria-label="负责人" options={options.slice(1)} value="nobody" placeholder="选择负责人" onChange={() => undefined} />);
    expect(html).toContain("选择负责人");
    expect(html).toContain("data-placeholder");
  });
  it("看得见的标签与触发器关联", () => {
    const html = renderToStaticMarkup(<Select label="主持人" options={options} value="p2" onChange={() => undefined} />);
    expect(html).toMatch(/<span[^>]*id="([^"]+)"[^>]*>主持人<\/span>/);
  });
});

describe("DatePicker / DateTimePicker（统一日期）", () => {
  it("触发器写中文日期，读屏名带字段名；没选时写占位", () => {
    const html = renderToStaticMarkup(<DatePicker label="截止" value="2099-10-15" onChange={() => undefined} />);
    expect(html).toContain('aria-label="截止：2099 年 10 月 15 日 周四"');
    expect(html).not.toContain('type="date"');
    expect(renderToStaticMarkup(<DatePicker label="开始" value="" onChange={() => undefined} />)).toContain("选择日期");
  });
  it("日期时间是一组：日期 + 时刻两枚触发器，不出现原生 datetime-local", () => {
    const html = renderToStaticMarkup(<DateTimePicker label="开始" value="2099-10-15T10:00" onChange={() => undefined} />);
    expect(html).toContain('role="group" aria-label="开始"');
    expect(html).toContain("10:00");
    expect(html).not.toContain("datetime-local");
  });
});

describe("picker.module.css", () => {
  it("触发器照全站输入框：变量取 --field-*，聚焦 1px 黑灰、不叠 outline，无虚线", () => {
    expect(css).toMatch(/border: 1px solid var\(--field-border, #dfe5ee\)/);
    expect(css).toMatch(/\[data-focus-visible\],[\s\S]*?border-color: var\(--field-border-focus, #3a3a40\)/);
    expect(css).toMatch(/\.trigger\.trigger:focus-visible \{ outline: none; \}/);
    expect(css).not.toMatch(/dashed/);
  });
  it("手持：底部 sheet、行高 48、日格 44，触发器至少 --touch-hit", () => {
    expect(css).toMatch(/\.sheet \{[^}]*bottom: 0/);
    expect(css).toMatch(/\.sheet \.item \{ min-height: 48px/);
    expect(css).toMatch(/\.sheet \.calDay \{ width: 44px; height: 44px/);
    expect(css).toMatch(/min-height: max\(var\(--touch-hit, 0px\)/);
  });
});
