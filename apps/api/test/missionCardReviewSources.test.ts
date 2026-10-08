import { describe, expect, it } from "vitest";
import { validateMissionCardReviewReport, type MissionCardReviewInput } from "../src/missionCardReview.js";

const input:MissionCardReviewInput={roundId:"round",round:2,period:"2026-10",battlefield:{id:"growth",name:"增长",ownerId:"dri"},goals:null,cards:[{
  cardId:"card",ownerId:"owner",ownerConfirmedAt:"2026-10-01T02:00:00Z",missions:[{missionId:"mission",version:3,outcome:"新版结果"}],
  annotations:[{id:"note",mission_id:"mission",field:"outcome",source_version:1,body:"请留验收证据",source_text:"旧版结果"}],
  revisions:[{id:"revision",mission_id:"mission",field:"outcome",before_version:1,after_version:3,before_text:"旧版结果",after_text:"新版结果",reason:"补充结果"}],
  feedback:[],corrections:[{id:"correction",mission_id:"mission",field:"outcome",original:"新版结果",proposed:"补充范围",reason:"新证据",note:"保留意见",applied_version:null}],
}]};
const report=(source:Record<string,unknown>)=>({summary:"依据快照核对",findings:[{kind:"question",title:"确认范围",body:"还需明确验收边界",sources:[{cardId:"card",...source}]}]});
describe("Co-Agent Review 可追溯来源",()=>{
  it("每种来源的卡、字段、版本和逐字原文必须匹配，历史版本不伪装成当前结果",()=>{
    for(const source of [
      {missionId:"mission",field:"outcome",version:3,quote:"新版结果"},
      {annotationId:"note",missionId:"mission",field:"outcome",version:1,quote:"旧版结果"},
      {revisionId:"revision",missionId:"mission",field:"outcome",version:3,quote:"新版结果"},
      {correctionId:"correction",missionId:"mission",field:"outcome",quote:"保留意见"},
    ]) expect(validateMissionCardReviewReport(input,report(source))).toBe(true);
    for(const source of [
      {missionId:"mission",field:"outcome",version:1},{missionId:"mission",version:3,quote:"不存在"},
      {annotationId:"note",version:3},{revisionId:"revision",version:1},{correctionId:"correction",version:3},
      {annotationId:"note",missionId:"other"},{revisionId:"revision",field:"title"},
      {annotationId:"note",revisionId:"revision"},{cardId:"other"},{field:"outcome"},{version:3},
    ]) expect(validateMissionCardReviewReport(input,report(source)),JSON.stringify(source)).toBe(false);
  });
  it("跨人观察仍需真实卡来源，空来源、伪造字段和任意格式不会通过",()=>{
    expect(validateMissionCardReviewReport(input,report({quote:"新版结果"}))).toBe(true);
    expect(validateMissionCardReviewReport(input,report({quote:"没有来源的业务事实"}))).toBe(false);
    expect(validateMissionCardReviewReport(input,{summary:"summary",findings:[{kind:"risk",title:"title",body:"body",sources:[]}]})).toBe(false);
    expect(validateMissionCardReviewReport(input,{...report({missionId:"mission",version:3}),approval:true})).toBe(false);
  });
});
