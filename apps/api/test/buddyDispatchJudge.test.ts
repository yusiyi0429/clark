import { describe, expect, it } from "vitest";
import { CASES, IDS, flips, judge, type Attempt, type ToolCall } from "../scripts/buddy-dispatch-judge.js";

/** 伙伴主线端到端评测的判定（scripts/buddy-dispatch-judge.ts）：喂假的工具轨迹和回话，看判对判错、翻转算对。 */
const WRITES = new Set(["open_session", "tell_session", "start_sub_session", "message_project", "set_task_due_date", "send_message"]);
const call = (name: string, args: Record<string, unknown> = {}, extra: Partial<ToolCall> = {}): ToolCall =>
  ({ name, args, write: WRITES.has(name), ok: true, code: null, ...extra });
const home = call("read_work_home");
const attempt = (calls: ToolCall[], reply = "好的，看了一下。", stop: Attempt["stop"] = "reply"): Attempt => ({ calls, reply, stop });
const verdict = (id: number, value: Attempt) => judge(CASES.find((entry) => entry.id === id)!, value);
const tell = (id: string, extra: Partial<ToolCall> = {}) => call("tell_session", { kind: "topic", id, text: "再试一次" }, extra);
const startLogin = (extra: Partial<ToolCall> = {}) => call("start_sub_session", { kind: "card", id: IDS.loginCard }, extra);
const notStarted = { ok: false, code: "NOT_STARTED" };

describe("伙伴主线评测的用例", () => {
  it("13 条，文字照需求", () => {
    expect(CASES.map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(CASES[3]!.message).toBe("比对桌面「合同」文件夹里那十几份");
    expect(CASES[2]!.message.startsWith("比对这两份合同\n\n合同甲：")).toBe(true);
    expect(CASES[12]!.message).toBe("让登录页那张卡接着做");
  });
});

describe("判定", () => {
  it("自己做的几条：不调写动作算对，调了算错；GTA 那条问本人也算对", () => {
    for (const id of [1, 2, 3, 12]) {
      expect(verdict(id, attempt([home])).pass).toBe(true);
      const wrong = verdict(id, attempt([call("open_session", { scratch: true, title: "查", brief: "查" })], "在「随手」里开了「查」。"));
      expect(wrong.pass).toBe(false);
      expect(wrong.reasons.join()).toContain("open_session");
    }
    expect(verdict(12, attempt([call("ask_user", { questions: [] })], "")).pass).toBe(true);
  });

  it("4、5：开会话要放对地方，而且要做成", () => {
    const scratch = call("open_session", { scratch: true, title: "比对合同", brief: "比对" });
    expect(verdict(4, attempt([scratch])).pass).toBe(true);
    expect(verdict(4, attempt([call("open_session", { projectId: IDS.tianshu, title: "比对合同", brief: "比对" })])).pass).toBe(false);
    expect(verdict(4, attempt([{ ...scratch, ok: false, code: "INVALID_ARGS" }], "没开成。")).pass).toBe(false);
    expect(verdict(5, attempt([call("open_session", { projectId: IDS.chat, title: "修流式重试", brief: "修" })])).pass).toBe(true);
    expect(verdict(5, attempt([call("open_session", { projectId: IDS.tianshu, title: "修流式重试", brief: "修" })])).pass).toBe(false);
  });

  it("6：不调写动作，回话里要提到「首页改版」", () => {
    expect(verdict(6, attempt([home, call("read_project", { projectId: IDS.tianshu })], "「首页改版」已经做完一轮，下一步把本月页挪出去。")).pass).toBe(true);
    expect(verdict(6, attempt([home], "「首页改版」上一轮已经把首页改成只留「等你」，已经让字号统一成一种。")).pass).toBe(true);
    expect(verdict(6, attempt([home], "天枢新版在推进。")).reasons.join()).toContain("首页改版");
    expect(verdict(6, attempt([home, tell(IDS.topicA)], "「首页改版」在跑。")).pass).toBe(false);
  });

  it("7：tell_session 给首页改版；不能转给项目、不能开工", () => {
    expect(verdict(7, attempt([home, tell(IDS.topicA)])).pass).toBe(true);
    expect(verdict(7, attempt([home, tell(IDS.topicB)])).pass).toBe(false);
    expect(verdict(7, attempt([home, tell(IDS.topicA), call("message_project", { projectId: IDS.tianshu, text: "改蓝" })])).pass).toBe(false);
    expect(verdict(7, attempt([home, call("start_sub_session", { kind: "topic", id: IDS.topicA }), tell(IDS.topicA)])).pass).toBe(false);
  });

  it("8：B 和 C 各说一次；少一个、多一次、开工都算错", () => {
    expect(verdict(8, attempt([home, tell(IDS.topicB), tell(IDS.topicC)])).pass).toBe(true);
    expect(verdict(8, attempt([home, tell(IDS.topicB)])).pass).toBe(false);
    expect(verdict(8, attempt([home, tell(IDS.topicB), tell(IDS.topicB), tell(IDS.topicC)])).pass).toBe(false);
    expect(verdict(8, attempt([home, tell(IDS.topicB), tell(IDS.topicC), call("start_sub_session", { kind: "topic", id: IDS.topicB })])).pass).toBe(false);
  });

  it("9：改约定转给天枢新版；不能直接 tell_session", () => {
    const forward = call("message_project", { projectId: IDS.tianshu, text: "首页改版的完成标准加一条「手机上也要能用」" });
    expect(verdict(9, attempt([home, forward])).pass).toBe(true);
    expect(verdict(9, attempt([home, call("message_project", { projectId: IDS.chat, text: "加一条" })])).pass).toBe(false);
    expect(verdict(9, attempt([home, forward, tell(IDS.topicA)])).pass).toBe(false);
  });

  it("10：截止日存在「首页改版」上、日期 2026-11-25", () => {
    const due = (dueDate: string) => call("set_task_due_date", { projectId: IDS.tianshu, taskId: IDS.homeTask, dueDate });
    expect(verdict(10, attempt([home, due("2026-11-25")])).pass).toBe(true);
    expect(verdict(10, attempt([home, due("2025-11-25")])).pass).toBe(false);
  });

  it("11：开在天枢新版、问本人、或让登录页卡开工都算对", () => {
    expect(verdict(11, attempt([home, call("open_session", { projectId: IDS.tianshu, title: "做登录页设计稿", brief: "做" })])).pass).toBe(true);
    expect(verdict(11, attempt([home, call("ask_user", { questions: [] })], "")).pass).toBe(true);
    expect(verdict(11, attempt([home, startLogin()])).pass).toBe(true);
    expect(verdict(11, attempt([home, call("open_session", { scratch: true, title: "做登录页设计稿", brief: "做" })])).pass).toBe(false);
  });

  it("13：先说一句被 409 挡回、再开工，或者直接开工；只被挡回却说让它接着做了，算错", () => {
    expect(verdict(13, attempt([home, tell(IDS.loginCard, notStarted), startLogin()], "让「登录页」开工了。")).pass).toBe(true);
    expect(verdict(13, attempt([home, startLogin()], "让「登录页」开工了。")).pass).toBe(true);
    const lied = verdict(13, attempt([home, tell(IDS.loginCard, notStarted)], "已经让它接着做了。"));
    expect(lied.pass).toBe(false);
    expect(lied.reasons.join()).toContain("已经");
  });
});

describe("每条回话都查", () => {
  const selfDone = (reply: string, stop: Attempt["stop"] = "reply") => verdict(1, attempt([home], reply, stop));
  it("省略号", () => {
    expect(selfDone("我看了一下…").pass).toBe(false);
    expect(selfDone("我看了一下...").pass).toBe(false);
    expect(selfDone("我看了一下。").pass).toBe(true);
  });
  it("许诺以后自己回报", () => {
    for (const reply of ["交给它了，做完我再来告诉你。", "稍后汇报。", "有结果了我会通知你。", "我会再来告诉你进展。"]) {
      expect(verdict(7, attempt([home, tell(IDS.topicA)], reply)).pass, reply).toBe(false);
    }
    expect(verdict(7, attempt([home, tell(IDS.topicA)], "把话转给了「首页改版」。它做完一轮主线里会自动出一行。")).pass).toBe(true);
  });
  it("没有做成的写动作时不说已经做了", () => {
    expect(selfDone("我已经把话转给了「首页改版」。").pass).toBe(false);
    expect(selfDone("已转给项目对话。").pass).toBe(false);
    expect(verdict(7, attempt([home, tell(IDS.topicA)], "已经把话转给了「首页改版」。")).pass).toBe(true);
  });
  it("没给最后回话", () => {
    expect(selfDone("", "rounds").pass).toBe(false);
    expect(selfDone("", "error").pass).toBe(false);
    expect(selfDone("").pass).toBe(false);
  });
});

describe("翻转", () => {
  it("上次全过这次有没过的、上次有没过这次全过的，按用例号列；上次没有的不算", () => {
    const before = [{ id: 1, passed: 2, runs: 2 }, { id: 2, passed: 1, runs: 2 }, { id: 3, passed: 2, runs: 2 }, { id: 4, passed: 0, runs: 2 }];
    const after = [{ id: 1, passed: 1, runs: 2 }, { id: 2, passed: 2, runs: 2 }, { id: 3, passed: 2, runs: 2 }, { id: 4, passed: 1, runs: 2 }, { id: 5, passed: 0, runs: 2 }];
    expect(flips(before, after)).toEqual({ regressed: [1], fixed: [2] });
  });
});
