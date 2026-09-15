// src/lib/agent/talk/tools.test.ts
import { describe, expect, it } from "vitest";
import { admit, BUDGET, TALK_TOOLS } from "./tools";
import { checkProposal } from "./point";

describe("轮内预算是升级触发器，不是硬中断", () => {
  it("六个工具都在，名字与规格一致（形状照 STAGE_TOOLS：名字在 t.function.name）", () => {
    expect(TALK_TOOLS.map((t) => t.function.name).sort()).toEqual([
      "escalate",
      "evidence_lookup",
      "micro_research",
      "ontology_lookup",
      "propose_point_update",
      "report_calculate",
    ]);
    /*
     * 上一版这里是 `TALK_TOOLS.every((t) => t.type === "function")` —— `type` 是字面量
     * 类型，编译期已经保证，那条断言在运行期恒真。真正会静默漂的是**描述与必填栏**：
     * 描述空了模型就不知道什么时候该调它（发出去不报错，只是它不调），必填栏漏了
     * 参数校验那一头就收得下缺参数的调用。
     */
    for (const t of TALK_TOOLS) {
      const f = t.function;
      expect(f.description.length, `${f.name} 没有描述`).toBeGreaterThan(10);
      const required = f.parameters.required ?? [];
      expect(required.length, `${f.name} 一栏必填都没有`).toBeGreaterThan(0);
      for (const key of required) {
        expect(Object.keys(f.parameters.properties), `${f.name} 的必填 ${key} 不在 properties 里`)
          .toContain(key);
      }
    }
  });

  it("第四次调用被拦，拦下来带的是一个装配好的升级项 —— 不是字符串标签", () => {
    const v = admit(
      { calls: 3, micro: 0, ontology: 0, startedAt: 0 },
      "evidence_lookup",
      1_000,
      {
        issueId: "ISS-1",
        question: "2025 年末的算力总量到底是多少",
      },
    );
    expect(v.allow).toBe(false);
    // 不用 if 包 —— 上面那行断言已经把 v.allow 钉成 false 了，
    // 这里用非空断言让类型收窄，而不是让断言躲进一个桩不会进的分支。
    const blocked = v as Extract<typeof v, { allow: false }>;
    expect(blocked.escalate?.type).toBe("async_research");
    expect(blocked.escalate?.payload.issueId).toBe("ISS-1");
    expect(blocked.escalate?.payload).toMatchObject({ question: "2025 年末的算力总量到底是多少" });
    expect(blocked.why.length).toBeGreaterThan(0);
  });

  it("说不出缺口是什么时 escalate 是 null，但 why 得说清为什么没转", () => {
    const v = admit(
      { calls: 3, micro: 0, ontology: 0, startedAt: 0 },
      "evidence_lookup",
      1_000,
      {
        issueId: "ISS-1",
        question: "   ",
      },
    );
    const blocked = v as Extract<typeof v, { allow: false }>;
    expect(blocked.escalate).toBeNull();
    /*
     * 整句对。`why` 是个字符串，`toContain("没有")` 是子串判断 —— 太宽：任何一句带
     * 「没有」两个字的话都绿，包括「已达调用次数上限，没有别的了」这种什么都没说清的。
     * 这句话会被 `turn.ts` 原样喂回模型（`turn.test.ts` 那一侧断的就是它），所以它得
     * 说清两件事：为什么拦、以及为什么没转成异步。
     */
    expect(blocked.why).toBe("已达调用次数上限，但没有明确的缺口可转异步");
  });

  it("第二次 micro_research 被拦", () => {
    const v = admit(
      { calls: 1, micro: 1, ontology: 0, startedAt: 0 },
      "micro_research",
      1_000,
      {
        issueId: "ISS-1",
        question: "还差一条口径",
      },
    );
    expect(v.allow).toBe(false);
    expect((v as Extract<typeof v, { allow: false }>).escalate?.type).toBe("async_research");
  });

  it("超时之后 micro_research 转异步，evidence_lookup 照放 —— 只读那个不花外部时间", () => {
    const late = BUDGET.syncTimeoutMs + 1;
    const ctx = { issueId: "ISS-1", question: "还差一条口径" };
    const blocked = admit({ calls: 1, micro: 0, ontology: 0, startedAt: 0 }, "micro_research", late, ctx);
    expect(blocked.allow).toBe(false);
    expect((blocked as Extract<typeof blocked, { allow: false }>).escalate?.type).toBe("async_research");
    expect(admit({ calls: 1, micro: 0, ontology: 0, startedAt: 0 }, "evidence_lookup", late, ctx).allow).toBe(true);
  });

  it("30 秒边界精确钉住：到点放行，过点拦下", () => {
    const ctx = { issueId: "ISS-1", question: "还差一条口径" };
    // 恰好 30 秒时放行
    const onTime = admit({ calls: 1, micro: 0, ontology: 0, startedAt: 0 }, "micro_research", BUDGET.syncTimeoutMs, ctx);
    expect(onTime.allow).toBe(true);
    // 超过 30 秒时拦下
    const overTime = admit({ calls: 1, micro: 0, ontology: 0, startedAt: 0 }, "micro_research", BUDGET.syncTimeoutMs + 1, ctx);
    expect(overTime.allow).toBe(false);
  });

  it("propose_point_update 与 escalate 不占检索预算 —— 它们不发外部请求", () => {
    const ctx = { issueId: "ISS-1", question: "还差一条口径" };
    expect(admit({ calls: 3, micro: 1, ontology: 0, startedAt: 0 }, "propose_point_update", 1_000, ctx).allow).toBe(true);
    expect(admit({ calls: 3, micro: 1, ontology: 0, startedAt: 0 }, "escalate", 1_000, ctx).allow).toBe(true);
  });

  it("工具说明里不许出现内部字段名 —— 那些词模型不该看见", () => {
    const all = TALK_TOOLS.map((t) => t.function.description).join("\n");
    // 正向断言：确认测试真的在看这份文本
    expect(all.length).toBeGreaterThan(0);
    expect(all).toContain("判断状态"); // 应该出现的产品词汇
    // 禁用词检查
    for (const banned of ["TalkPoint", "PointProposal", "checkProposal", "Escalation", "deliberationLog"])
      expect(all).not.toContain(banned);
    const propose = TALK_TOOLS.find((t) => t.function.name === "propose_point_update");
    expect(propose!.function.description).toContain("已确认"); // §4.3 的「模型不可触发 →judged」
  });

  it("schema 宣传的字段名必须与 checkProposal 的白名单一致 —— 两端是一根线", () => {
    const propose = TALK_TOOLS.find((t) => t.function.name === "propose_point_update");
    expect(propose).toBeDefined();

    // 从 schema 里提取顶层字段名（point_id 除外 —— 它是路由参数，Task 9 会剥掉）
    const schemaKeys = Object.keys(propose!.function.parameters.properties).filter((k) => k !== "point_id");
    expect(schemaKeys.sort()).toEqual(["candidate", "openQuestions", "statements", "thesis"]);

    // 从 schema 里提取 candidate 的嵌套键 —— 不许手写字面量
    const candidateProp = propose!.function.parameters.properties.candidate as {
      type: string;
      properties: Record<string, unknown>;
    };
    const candidateKeys = Object.keys(candidateProp.properties);
    expect(candidateKeys.sort()).toEqual(["basis", "boundary", "reopenIf", "statement"]);

    // 用 schema 推出的键造一份提议，过 checkProposal 必须是 ok
    const candidateObj: Record<string, string> = {};
    for (const key of candidateKeys) {
      candidateObj[key] = key === "statement" ? "判断" : key === "basis" ? "依据" : `值-${key}`;
    }
    const fullProposal = {
      thesis: "争点",
      statements: ["陈述 1", "陈述 2"],
      openQuestions: ["问题 1"],
      candidate: candidateObj,
    };
    const result = checkProposal(fullProposal);
    expect(result.ok).toBe(true);

    // 确认 statements 和 openQuestions 的数组类型匹配
    const statementsOnly = { statements: ["a", "b"] };
    expect(checkProposal(statementsOnly).ok).toBe(true);
    const openQuestionsOnly = { openQuestions: ["x", "y"] };
    expect(checkProposal(openQuestionsOnly).ok).toBe(true);
  });
});

describe("ontology_lookup 的预算", () => {
  const ctx = { issueId: "ISS-001", question: "01-J2" };

  it("占检索额度 —— 它发的是真 HTTP，不是读本进程的台账", () => {
    const v = admit({ calls: 3, micro: 0, ontology: 0, startedAt: 0 }, "ontology_lookup", 1_000, ctx);
    expect(v.allow).toBe(false);
  });

  it("两次之后拦下来，而且**不转异步**", () => {
    // 转异步那条路查的是外面的网页，而这一次问的是「公司自己记过没有」。
    // 转过去等于起一轮永远答不对的检索，屏幕上却像是正常转了异步。
    const v = admit({ calls: 2, micro: 0, ontology: 2, startedAt: 0 }, "ontology_lookup", 1_000, ctx);
    expect(v.allow).toBe(false);
    if (v.allow) throw new Error("unreachable");
    expect(v.escalate).toBeNull();
    expect(v.why).toContain("本体");
  });

  it("超时之后照拦 —— 和 evidence_lookup 不同，它花外部时间", () => {
    const late = BUDGET.syncTimeoutMs + 1;
    const blocked = admit({ calls: 1, micro: 0, ontology: 0, startedAt: 0 }, "ontology_lookup", late, ctx);
    expect(blocked.allow).toBe(false);
    expect(admit({ calls: 1, micro: 0, ontology: 0, startedAt: 0 }, "evidence_lookup", late, ctx).allow).toBe(true);
  });

  it("说明里写清它不联网、也写清取不到不是故障", () => {
    const t = TALK_TOOLS.find((x) => x.function.name === "ontology_lookup");
    expect(t).toBeDefined();
    // 不写清「不联网」，模型会拿它当第二个检索工具，白花一次预算而空结果像「公司没有这条」
    expect(t!.function.description).toContain("不联网");
    expect(t!.function.description).toContain("不是故障");
  });
});
