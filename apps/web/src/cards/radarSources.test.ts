import { describe, expect, it } from "vitest";
import { radarSourceLabel, radarSourceMessage } from "./RadarCard";

describe("Radar 来源三分", () => {
  it("outlets 是发布方级媒体来源，不会显示成微信公众号", () => {
    expect(radarSourceLabel("web")).toBe("Web 搜索");
    expect(radarSourceLabel("wechat")).toBe("微信公众号");
    expect(radarSourceLabel("outlets")).toBe("发布方级媒体来源");
  });

  it("已配置时如实列出发布方名单并标只读", () => {
    const message = radarSourceMessage("outlets", { configured: true, message: "已配置 6 家发布方级媒体来源" });
    expect(message).toContain("BBC");
    expect(message).toContain("经济学人");
    expect(message).toContain("只读");
  });

  it("未配置时沿用 API 说明，其余来源不改写", () => {
    expect(radarSourceMessage("outlets", { configured: false, message: "未配置发布方级媒体来源" })).toBe(
      "未配置发布方级媒体来源",
    );
    expect(radarSourceMessage("web", { configured: true, message: "已配置" })).toBe("已配置");
  });
});
