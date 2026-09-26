import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CompanySnapshot, WorkSnapshot, WelcomeFlow, monthTargetCopy, onboardingSteps, type OnboardingData } from "./WelcomeFlow";
import { OnboardingProgress } from "./OnboardingProgress";

const base = { displayName: "测试", companyName: null, voiceprint: { configured: false, enrolled: false, updatedAt: null }, next: { text: "可以开始工作", action: "进入工作台", href: "/me" } };
const member: Extract<OnboardingData, { role: "member" }> = { ...base, role: "member", work: { period: "2026-10", planStatus: "none", battlefields: [], missions: [] } };
const ceo: Extract<OnboardingData, { role: "ceo" }> = { ...base, role: "ceo", company: { sixMonthGoal: "", battlefields: [], capabilities: [], people: [] } };

describe("真实数据的首次引导", () => {
  it("角色决定快照，声纹不可用时不占步骤，不包含未交付的雷达", () => {
    expect(onboardingSteps(member)).toEqual(["hello", "work", "start"]);
    expect(onboardingSteps({ ...ceo, voiceprint: { ...base.voiceprint, configured: true } })).toEqual(["hello", "company", "voiceprint", "start"]);
  });
  it("空态只说没有登记，不推断没有工作", () => {
    const html = renderToStaticMarkup(<WorkSnapshot data={member} />);
    expect(html).toContain("这个月还没有登记你参与的战场");
    expect(html).toContain("这个月还没有登记你的 Mission");
    expect(html).not.toContain("没有工作");
    expect(renderToStaticMarkup(<CompanySnapshot data={ceo} />)).toContain("公司的目标和战场还没登记");
  });
  it("目标的三种状态有独立文案，已签发但无对应目标仍说明缺失", () => {
    expect(monthTargetCopy("none", null)).toBe("本月目标还没出来");
    expect(monthTargetCopy("draft", null)).toBe("本月目标还在协商");
    expect(monthTargetCopy("negotiating", null)).toBe("本月目标还在协商");
    expect(monthTargetCopy("confirmed", "客户验证")).toBe("客户验证");
    expect(monthTargetCopy("confirmed", null)).toContain("还没有登记");
  });
  it("本人的 Mission 按战场列出三条并注明余数；未关联的也能看见", () => {
    const data = { ...member, work: { ...member.work, battlefields: [{ id: "bf", name: "灯塔", monthTarget: null }], missions: Array.from({ length: 5 }, (_, i) => ({ id: String(i), code: String(i), title: `结果${i}`, battlefieldIds: i === 4 ? [] : ["bf"] })) } };
    const html = renderToStaticMarkup(<WorkSnapshot data={data} />);
    expect(html).toContain("灯塔");
    expect(html).toContain("另 1 条");
    expect(html).not.toContain("结果3");
    expect(html).toContain("结果4");
  });
  it("服务端首屏包含问候与晨光，胶囊不可操作；读屏进度有文本", () => {
    const html = renderToStaticMarkup(<WelcomeFlow data={member} />);
    expect(html).toContain("你好，测试");
    expect(html).toContain("先进入工作台");
    expect(html).toContain("data-morning-canvas");
    expect(html).not.toContain("声纹，可以现在录");
    expect(renderToStaticMarkup(<OnboardingProgress current={2} total={3} />)).toContain("第 2 步，共 3 步");
  });
});
