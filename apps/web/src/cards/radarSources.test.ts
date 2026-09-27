import { describe, expect, it } from "vitest";
import { radarSourceLabel, radarSourceMessage } from "./RadarCard";

describe("Radar 来源三分", () => {
  it("outlets 是发布方级媒体来源，不会显示成微信公众号", () => {
    expect(radarSourceLabel("web")).toBe("Web 搜索");
    expect(radarSourceLabel("wechat")).toBe("微信公众号");
    expect(radarSourceLabel("outlets")).toBe("发布方级媒体来源");
  });

  it("已配置时按负载里当前启用的发布方如实列出名单并标只读（在「雷达设置」里增减，不再写死）", () => {
    const message = radarSourceMessage("outlets", { configured: true, message: "已配置 3 家发布方级媒体来源", names: ["BBC", "经济学人", "The Information"] });
    expect(message).toBe("BBC、经济学人、The Information · 只读");
    expect(radarSourceMessage("outlets", { configured: true, message: "已配置 1 家发布方级媒体来源", names: ["金融时报"] })).not.toContain("BBC");
  });

  it("负载没带名单时沿用 API 说明，不编造名单", () => {
    expect(radarSourceMessage("outlets", { configured: true, message: "已配置 6 家发布方级媒体来源" })).toBe("已配置 6 家发布方级媒体来源");
    expect(radarSourceMessage("outlets", { configured: true, message: "已配置 0 家发布方级媒体来源", names: [] })).toBe("已配置 0 家发布方级媒体来源");
  });

  it("未配置时沿用 API 说明，其余来源不改写", () => {
    expect(radarSourceMessage("outlets", { configured: false, message: "未配置发布方级媒体来源" })).toBe(
      "未配置发布方级媒体来源",
    );
    expect(radarSourceMessage("web", { configured: true, message: "已配置" })).toBe("已配置");
  });
});
