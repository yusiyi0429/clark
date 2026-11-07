import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkHomeData } from "@/lib/home/types";
import { LeftColumn } from "./LeftColumn";

const data = { period: "2026-11", missions: [], waiting: [], other: { subSessions: [] } } as unknown as WorkHomeData;
const render = (extra: Partial<Parameters<typeof LeftColumn>[0]>) => renderToStaticMarkup(
  <LeftColumn data={data} view={{ kind: "home" }} buddy={null} speaking={false} go={() => undefined} phone={false}
    account={{ displayName: "孙铭泽", role: "member" }} today="11 月 7 日 周六" alert={false} {...extra} />,
);

describe("左栏：计划读不到、空月份（5.4.2、5.4.4）", () => {
  it("计划读不到时树最上面一行「本体读取失败」加「重试」，不画成空树", () => {
    const html = render({ onRetryPlan: () => undefined });
    expect(html).toContain('data-testid="plan-read-failed"');
    expect(html).toMatch(/本体读取失败.*重试/);
    expect(render({})).not.toContain("本体读取失败");
  });

  it("空月份：「今天」行行尾出「11 月待敲定」chip", () => {
    const html = render({ month: { href: "/me/work/month/2026-11", label: "11 月待敲定" } });
    expect(html).toMatch(/11 月 7 日 周六.*11 月待敲定/);
    expect(render({})).not.toContain("待敲定");
  });
});
