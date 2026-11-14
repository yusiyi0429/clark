import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { runAction, type BuddyDeps } from "../src/buddyActions.js";
import type { Query } from "../src/meetingStore.js";

describe("伙伴读取成员来件", () => {
  it("使用成员自己的会话和固定资源路由，业务拒绝原样返回", async () => {
    const app = Fastify();
    app.get("/api/me/partner-meetings/meeting1/record", async req => ({
      title: "例会", text: req.headers.cookie && req.url.endsWith("?source=feishu") ? "依据正文" : "", sourceUrl: null,
    }));
    app.get("/api/me/team-deliveries/2f726fdc-24ad-4a23-80b3-e118d2a6d1aa",async (_,reply)=>reply.code(404).send({code:"NOT_FOUND",message:"未共享"}));
    const deps: BuddyDeps = {app,q:vi.fn(async()=>({rows:[{session_version:1}]})) as unknown as Query,env:{sessionSecret:"test-only",publicOrigin:"https://test.local"},now:()=>new Date(),names:()=>new Map(),history:vi.fn()};
    const call={personId:"member-b",runId:null,conversationId:null};
    try {
      const opened=await runAction(deps,call,"read_partner_item",{kind:"meeting",id:"meeting:meeting1",source:"feishu"});
      expect(opened.result).toMatchObject({title:"例会",text:"依据正文"});
      await expect(runAction(deps,call,"read_partner_item",{kind:"delivery",id:"2f726fdc-24ad-4a23-80b3-e118d2a6d1aa"})).rejects.toMatchObject({status:404});
    } finally { await app.close(); }
  });
});
