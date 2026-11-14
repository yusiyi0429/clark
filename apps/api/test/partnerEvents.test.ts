import { describe, expect, it } from "vitest";
import { workEventFromFeed } from "../src/taskFeed.js";
describe("伙伴只提示项目的关键事实", () => {
  const sub = { kind:"card" as const,id:"s",title:"出一版设计",letter:"A" };
  const base = {kind:"sub_session_report" as const,id:"notice1",at:"2026-11-13T01:00:00Z",sub,afterSequence:null,outputs:[],why:"turn_done" as const,summary:"写完一轮",blocker:null};
  it("普通停一轮留在项目里，明确卡点使用原报告标识", () => {
    expect(workEventFromFeed(base,"p","设计")).toBeNull();
    expect(workEventFromFeed({...base,blocker:"等客户给素材"},"p","设计")).toMatchObject({id:"notice1",subjectId:"s",detail:"等客户给素材"});
  });
  it("通过验收后仍保留等合回状态", () => {
    const e = workEventFromFeed({kind:"card_passed",id:"passed:k",at:base.at,cardId:sub.id,title:sub.title,met:2,total:2,
      merge:{state:"needs_merge",baseBranch:"main",commit:null,reason:null,message:null,at:base.at}},"p","设计");
    expect(e).toMatchObject({id:"passed:k",detail:"验收通过（2/2），等合回"});
  });
});
