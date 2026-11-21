import { describe, expect, it } from "vitest";
import { intakeStatusAfterTurn } from "../src/workIntake.js";

describe("本人同一目标的工作顺序", () => {
  it("正在回答的目标会继续排队", () => {
    expect(intakeStatusAfterTurn(409, "TURN_IN_PROGRESS", false)).toBe("queued");
  });
  it("单项失败让其他已授权要求继续，收到错误不能记作已送达", () => {
    expect(intakeStatusAfterTurn(200, null, false)).toBe("failed");
    expect(intakeStatusAfterTurn(200, null, true)).toBe("delivered");
    expect(intakeStatusAfterTurn(403, "FORBIDDEN", false)).toBe("failed");
  });
});
