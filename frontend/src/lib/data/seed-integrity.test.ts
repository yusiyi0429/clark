/**
 * 种子里**不许有指向不存在对象的引用**。
 *
 * ## 这条为什么值得单独钉
 *
 * 这一类坏法没有编译期症状，也没有运行期报错 —— 它的症状是**整页白掉**，而白屏在屏幕上
 * 和「这一页还没做」长得一模一样。数据层那几个 `find*` 找不到就抛（`findJudgment`、
 * `findDomain`），而抛在渲染里就是白屏。
 *
 * 2026-08-31 去掉 01 / 02 两个域时撞的正是这个：判断没了，而二十件预载案例的
 * `judgmentRefs`、卡片的 `strategyRef`、正文里的溯源芯片仍然指着它们。一路 tsc 全绿、
 * 28 条无关的测试才红出来，而红的原话是「找不到判断 01-J1」——离原因隔着好几层。
 *
 * 所以这里不测行为，只测**一件事**：每一处写着 id 的地方，那个 id 真的有对象。
 * 往后再去掉任何一个域、任何一批判断，这一份会先红，而且红在原因上。
 */
import { describe, expect, it } from "vitest";

import * as ad from "./seed-agent-domain";
import * as demo from "./seed-demo";
import { seededCases } from "./seed-cases";
import { domains, issues, judgments, people } from "./seed-tokenking";
import { TODAY } from "./shared";

const cases = seededCases(TODAY);

/**
 * 库里此刻真的存在的那些 id。
 *
 * **四份种子合起来算**（本体、预载案例、04 域那一份、演示内容包）—— 产品跑起来它们在
 * 同一个库里，一份里的卡片指得到另一份里的议题。只算其中一份的话，这份检查会把正常的
 * 跨份引用报成悬空，而人对着一屏假阳性会开始不看它。
 */
const live = {
  domain: new Set([...domains, ...ad.bizDomains].map((d) => d.id)),
  person: new Set(people.map((p) => p.id)),
  judgment: new Set([...judgments, ...ad.judgments].map((j) => j.id)),
  issue: new Set(
    [...issues, ...cases.issues, ...ad.issues, ...demo.issues].map((i) => i.id),
  ),
};

/**
 * 把整棵树走一遍，交回「这个字段指向的那个 id 不存在」的清单。
 *
 * 按**字段名**认类型，不按 id 的长相：`domainId` 一定指域，`judgmentRefs` 一定指判断。
 * 按长相猜（比如「`D-` 开头就是域」）会在哪天有人换了编号规则时安静地不再检查。
 */
const dangling = (root: unknown): string[] => {
  const bad: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const here = `${path}.${key}`;
      const one = (kind: keyof typeof live, id: unknown) => {
        if (typeof id !== "string" || id.length === 0) return;
        if (!live[kind].has(id)) bad.push(`${here} → ${kind} ${id}`);
      };
      if (key === "domainId") one("domain", value);
      else if (key === "domainIds" || key === "extraDomainIds") {
        if (Array.isArray(value)) value.forEach((v) => one("domain", v));
      } else if (key === "judgmentRefs") {
        if (Array.isArray(value)) value.forEach((v) => one("judgment", v));
      } else if (key === "driId") one("person", value);
      else if (key === "driIds") {
        if (Array.isArray(value)) value.forEach((v) => one("person", v));
      } else if (key === "issueId") one("issue", value);
      else if (key === "issueIds") {
        if (Array.isArray(value)) value.forEach((v) => one("issue", v));
      } else if (key === "strategyRef" || key === "hypothesisRef") {
        /*
         * 卡面上那句「· 动摇 01-J9」。它**不是链接**，只是一个编号 —— 指错了不会抛，
         * 只会在卡上印一个库里查不到的编号。比链接更难发现，因为屏幕上它看着正常。
         */
        one("judgment", (value as { id?: unknown } | null)?.id);
      } else if (key === "href") {
        /*
         * 溯源芯片点开的地址（`/judgments/<id>`）。这一条是**真链接**：指向不存在的判断
         * 时点开就抛，而抛在渲染里是整页白掉。
         */
        const m = typeof value === "string" ? /^\/judgments\/(.+)$/.exec(value) : null;
        if (m) one("judgment", m[1]);
      } else walk(value, here);
    }
  };
  walk(root, "");
  return bad;
};

describe("本体种子", () => {
  it("域、人、判断、议题之间没有一处悬空引用", () => {
    expect(dangling({ domains, issues, judgments })).toEqual([]);
  });
});

describe("演示内容包", () => {
  it("卡、议题、报告、会前那一叠，没有一处悬空引用", () => {
    /*
     * demo 那一档和真数据走的是同一个库（`tk` 恒为 `seed-tokenking`），所以它引的判断
     * 和域必须是同一批还活着的。这一份原来没人扫 —— 去掉 01 / 02 两个域时，它里面
     * 三十多处指向 `01-J*` 的引用一声不响地全成了悬空。
     */
    expect(dangling({ ...demo })).toEqual([]);
  });
});

describe("预载案例", () => {
  it("议题、卡片、会、会后那一叠，没有一处悬空引用", () => {
    expect(dangling(cases)).toEqual([]);
  });

  it("每场会上的议题都还在", () => {
    /*
     * 上一条已经覆盖了 `issueIds`，这一条要的是另一件事：**一场会不许一件议题都没有**。
     * 议题被删掉之后那一栏会退成空数组，而空数组过得了上面那一关 —— 屏幕上是一场排好的、
     * 点进去什么都没有的会。
     */
    for (const slot of cases.meetingSlots) {
      expect({ 会: slot.id, 议题数: slot.issueIds.length }).toEqual({
        会: slot.id,
        议题数: expect.any(Number),
      });
      expect(slot.issueIds.length).toBeGreaterThan(0);
    }
  });

  it("会后那一叠里每一份都挂在一件还在的议题上", () => {
    for (const [key, debrief] of Object.entries(cases.debriefs)) {
      expect({ 单: key, 议题在: live.issue.has(debrief.issueId) }).toEqual({
        单: key,
        议题在: true,
      });
    }
  });
});
