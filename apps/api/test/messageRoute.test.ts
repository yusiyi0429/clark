import { describe, expect, it } from "vitest";
import { routeMessage } from "../src/messageRoute.js";

const TASKS = [
  { taskId: "v1", name: "11/18 上线 V1", doneDefinition: null, criteria: ["约定、对表与参考评审"] },
  { taskId: "v2", name: "11/30 上线 V2", doneDefinition: null, criteria: ["本机派活、岗位与本机验收跑通"] },
  { taskId: "link", name: "对接打通", doneDefinition: null, criteria: ["伙伴 API、本体上下文与会议回流"] },
];

describe("首页「自动」发给谁", () => {
  it("提到哪件 Task 的词就发给那件；几件都有的词、什么都没提到的发给伙伴", () => {
    expect(routeMessage("V2 的本机验收怎么样了", TASKS)).toEqual({ target: { taskId: "v2" } });
    expect(routeMessage("v2 的本机验收怎么样了", TASKS)).toEqual({ target: { taskId: "v2" } });
    expect(routeMessage("上线了吗", TASKS)).toEqual({ target: "main" });
    expect(routeMessage("会议回流卡住了", TASKS)).toEqual({ target: { taskId: "link" } });
    expect(routeMessage("今天天气", TASKS)).toEqual({ target: "main" });
  });

  it("恰好一件命中才发给它：两件各被提到一个独有的词就发给伙伴；日期、时间这种纯数字不算词", () => {
    expect(routeMessage("V2 的本机验收和会议回流一起看下", TASKS)).toEqual({ target: "main" });
    expect(routeMessage("对接打通和 V1 哪个先", TASKS)).toEqual({ target: "main" });
    expect(routeMessage("18 号下午开会", TASKS)).toEqual({ target: "main" });
  });

  it("句子里有完整的 Task 名字就算命中，名字一件套一件时只算最长的", () => {
    expect(routeMessage("对接打通这件今天能交吗", TASKS)).toEqual({ target: { taskId: "link" } });
    // 「上线」两件都有，但完整名字只出现了一件。
    expect(routeMessage("11/18 上线 V1 还差什么", TASKS)).toEqual({ target: { taskId: "v1" } });
    const nested = [{ taskId: "short", name: "上线", doneDefinition: null, criteria: [] }, { taskId: "long", name: "上线 V1", doneDefinition: null, criteria: [] }];
    expect(routeMessage("上线 V1 怎么样", nested)).toEqual({ target: { taskId: "long" } });
  });

  it("没有 Task 时都发给伙伴", () => {
    expect(routeMessage("V2 的本机验收怎么样了", [])).toEqual({ target: "main" });
  });
});
