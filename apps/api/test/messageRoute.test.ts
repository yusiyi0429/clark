import { describe, expect, it } from "vitest";
import { routeMessage } from "../src/messageRoute.js";

const PROJECTS = [
  { projectId: "v1", names: ["11/18 上线 V1"], text: ["约定、对表与参考评审"] },
  { projectId: "v2", names: ["11/30 上线 V2"], text: ["本机派活、岗位与本机验收跑通"] },
  { projectId: "link", names: ["对接打通"], text: ["伙伴 API、本体上下文与会议回流"] },
];

describe("首页「自动」发给谁", () => {
  it("提到哪个项目的词就发给那个；几个项目都有的词、什么都没提到的发给伙伴", () => {
    expect(routeMessage("V2 的本机验收怎么样了", PROJECTS)).toEqual({ target: { projectId: "v2" } });
    expect(routeMessage("v2 的本机验收怎么样了", PROJECTS)).toEqual({ target: { projectId: "v2" } });
    expect(routeMessage("上线了吗", PROJECTS)).toEqual({ target: "main" });
    expect(routeMessage("会议回流卡住了", PROJECTS)).toEqual({ target: { projectId: "link" } });
    expect(routeMessage("今天天气", PROJECTS)).toEqual({ target: "main" });
  });

  it("恰好一个项目命中才发给它：两个项目各被提到一个独有的词就发给伙伴；日期、时间这种纯数字不算词", () => {
    expect(routeMessage("V2 的本机验收和会议回流一起看下", PROJECTS)).toEqual({ target: "main" });
    expect(routeMessage("对接打通和 V1 哪个先", PROJECTS)).toEqual({ target: "main" });
    expect(routeMessage("18 号下午开会", PROJECTS)).toEqual({ target: "main" });
  });

  it("句子里有完整名字就算命中，名字一个套一个时只算最长的", () => {
    expect(routeMessage("对接打通这件今天能交吗", PROJECTS)).toEqual({ target: { projectId: "link" } });
    // 「上线」两个项目都有，但完整名字只出现了一个。
    expect(routeMessage("11/18 上线 V1 还差什么", PROJECTS)).toEqual({ target: { projectId: "v1" } });
    const nested = [{ projectId: "short", names: ["上线"], text: [] }, { projectId: "long", names: ["上线 V1"], text: [] }];
    expect(routeMessage("上线 V1 怎么样", nested)).toEqual({ target: { projectId: "long" } });
  });

  it("项目挂着的 Task 名字也算它的名字", () => {
    const withTasks = [
      { projectId: "home", names: ["新首页", "11/18 上线 V1"], text: [] },
      { projectId: "world", names: ["本体对接", "会议回流"], text: [] },
    ];
    expect(routeMessage("会议回流今天能交吗", withTasks)).toEqual({ target: { projectId: "world" } });
    expect(routeMessage("11/18 上线 V1 还差什么", withTasks)).toEqual({ target: { projectId: "home" } });
  });

  it("没有项目时都发给伙伴", () => {
    expect(routeMessage("V2 的本机验收怎么样了", [])).toEqual({ target: "main" });
  });
});
