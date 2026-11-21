import { describe, expect, it } from "vitest";
import { buddyPersona } from "../src/buddyPersona.js";
import { findForbiddenPhrase } from "../src/promptStyle.js";
import { createTestApp, TEST_CEO, TEST_MEMBER } from "./helpers.js";

describe("本人的伙伴", () => {
  it("人设里有「发消息的样子」，缺省带", () => {
    const persona = buddyPersona({ name: "团团", personality: "steady" }, "测试乙");
    expect(persona).toContain("# 发消息的样子");
    expect(persona).toContain("每段会单独成为一条消息");
    expect(persona).toContain("不复述自己用了什么工具");
    expect(persona.indexOf("# 寒暄、托付和心情")).toBeLessThan(persona.indexOf("# 发消息的样子"));
    // 前面风格段「关键判断可以加粗」在普通回复里也让位于「不加粗」。
    expect(persona).toContain("普通回复最多三段，不写标题，不加粗；前面说的关键判断加粗，在普通回复里也不用。");
    expect(findForbiddenPhrase(persona)).toBeNull();
  });

  it("texting:false 时不带", () => {
    const persona = buddyPersona({ name: "团团", personality: "steady" }, "测试乙", { texting: false });
    expect(persona).not.toContain("# 发消息的样子");
    expect(persona).toContain("# 寒暄、托付和心情");
  });

  it("人设里写了在已有项目里开会话、或者哪个项目都不沾的本机文件一次性活，直接开会话不先问；不写「随手」（本人 11/19、11/20）", () => {
    const persona = buddyPersona({ name: "团团", personality: "steady" }, "测试乙");
    expect(persona).not.toContain("随手");
    const line = persona.indexOf("在已有项目里开会话、或者读过首页对过、哪个项目都不沾的本机文件一次性活，直接开会话，不先问，项目绑了哪个就在哪个里做。");
    expect(line).toBeGreaterThan(persona.indexOf("# 先从现实出发"));
    expect(line).toBeLessThan(persona.indexOf("# 底线"));
  });

  it("独立 Chat 经 /internal/buddy 取伙伴的人设：和本地对话同一段，按性格换；没选伙伴是 null；要内部令牌", async () => {
    const token = "internal-chat-test";
    const t = await createTestApp({ internalChatToken: token });
    try {
      const read = (personId: string, role: string, auth = `Bearer ${token}`) => t.app.inject({ method: "GET", url: "/internal/buddy",
        headers: { authorization: auth, "x-owner-id": personId, "x-viewer-role": role } });
      expect((await read(TEST_MEMBER.personId, "member", "Bearer wrong")).statusCode).toBe(401);
      expect((await read(TEST_MEMBER.personId, "member")).json()).toBeNull();
      const cookie = await t.memberCookie();
      expect((await t.app.inject({ method: "PUT", url: "/api/me/buddy", headers: { cookie, origin: t.publicOrigin },
        payload: { name: "团团", form: "panda", personality: "warm" } })).statusCode).toBe(200);
      const member = (await read(TEST_MEMBER.personId, "member")).json();
      expect(member).toMatchObject({ name: "团团", personality: "warm" });
      expect(member.persona).toContain("你叫团团，是测试乙的伙伴");
      expect(member.persona).toContain("# 说话的样子：温和体贴");
      expect(member.persona).toContain("（进度落后）这周会多、事也杂");
      expect(member.persona).toContain("每句话都带「下一步」或「我的倾向」");
      expect(member.persona).toContain("坏消息一定说");
      expect((await t.app.inject({ method: "PUT", url: "/api/me/buddy", headers: { cookie: await t.loginCookie(), origin: t.publicOrigin },
        payload: { name: "圆圆", form: "classic", personality: "coach" } })).statusCode).toBe(200);
      const ceo = (await read(TEST_CEO.personId, "ceo")).json();
      expect(ceo.persona).toContain("你叫圆圆，是本人的伙伴");
      expect(ceo.persona).toContain("# 说话的样子：启发追问");
    } finally { await t.close(); }
  });

  it("新人没有伙伴；本人保存后读回一致，会话里也带上；别人看不到", async () => {
    const t = await createTestApp();
    try {
      const cookie = await t.memberCookie();
      const own = () => t.app.inject({ method: "GET", url: "/api/me/buddy", headers: { cookie } });
      const save = (payload: unknown) => t.app.inject({ method: "PUT", url: "/api/me/buddy",
        headers: { cookie, origin: t.publicOrigin }, payload });
      const before = await own();
      expect(before.statusCode).toBe(200);
      expect(before.json()).toBeNull();
      const saved = await save({ name: "  团团 ", form: "panda" });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toEqual({ name: "团团", form: "panda", personality: "steady" });
      expect((await own()).json()).toEqual({ name: "团团", form: "panda", personality: "steady" });
      const session = await t.app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } });
      expect(session.json()).toMatchObject({ buddy: { name: "团团", form: "panda", personality: "steady" } });
      expect((await save({ name: "蓝蓝", form: "alive", personality: "direct" })).json()).toEqual({ name: "蓝蓝", form: "alive", personality: "direct" });
      // 不带性格（旧页面）时沿用原来的。
      expect((await save({ name: "Miles", form: "miles" })).json()).toEqual({ name: "Miles", form: "miles", personality: "direct" });
      expect((await own()).json()).toEqual({ name: "Miles", form: "miles", personality: "direct" });
      expect((await save({ name: "C妹", form: "cmei" })).json()).toEqual({ name: "C妹", form: "cmei", personality: "direct" });
      const other = await t.app.inject({ method: "GET", url: "/api/me/buddy", headers: { cookie: await t.loginCookie() } });
      expect(other.json()).toBeNull();
    } finally { await t.close(); }
  });

  it("只有登录的本人能读写；名字按宽度算 1–12（汉字、大写字母算 2），外形要在清单里", async () => {
    const t = await createTestApp();
    try {
      expect((await t.app.inject({ method: "GET", url: "/api/me/buddy" })).statusCode).toBe(401);
      expect((await t.app.inject({ method: "PUT", url: "/api/me/buddy", headers: { origin: t.publicOrigin },
        payload: { name: "团团", form: "panda" } })).statusCode).toBe(401);
      const cookie = await t.memberCookie();
      const save = (payload: unknown) => t.app.inject({ method: "PUT", url: "/api/me/buddy",
        headers: { cookie, origin: t.publicOrigin }, payload });
      expect((await save({ name: "   ", form: "panda" })).statusCode).toBe(400);
      for (const tooWide of ["一二三四五六七", "abcdefghijklo", "WWWWWWW", "Annab 小明小", "一二三四五六a"]) {
        expect((await save({ name: tooWide, form: "panda" })).statusCode).toBe(400);
      }
      expect((await save({ name: "团团", form: "cat" })).statusCode).toBe(400);
      expect((await save({ name: "团团", form: "panda", personality: "snarky" })).statusCode).toBe(400);
      expect((await save({ name: "团团" })).statusCode).toBe(400);
      expect((await t.app.inject({ method: "GET", url: "/api/me/buddy", headers: { cookie } })).json()).toBeNull();
      for (const widest of ["一二三四五六", "abcdefghijkl", "WWWWWW", "Anna 小明小", " 一二三四五a "]) {
        expect((await save({ name: widest, form: "classic" })).json()).toEqual({ name: widest.trim(), form: "classic", personality: "steady" });
      }
    } finally { await t.close(); }
  });
});
