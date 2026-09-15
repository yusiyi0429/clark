/**
 * 业务域的名字和它的负责人 —— **2026-08-31 一号位当面校准的那一份**。
 *
 * ## 为什么这份事实值得钉一条测试
 *
 * 它有两条会静默改掉它的路：
 *
 * 1. `seed-tokenking.ts` 是生成的。重跑一次生成器，域名和 DRI 全部由本体和
 *    `scripts/gen-seed-from-ontology.mjs` 里那张校准表说了算 —— 校准表被谁删了、
 *    或者本体那边改了名字，屏幕上就换了一套分工，而没有任何一处会报错。
 *    （这一版之前就有过一次：D-07/D-08 被手改成「HR」「Finance」，下一次重跑会把
 *    它们静默改回本体里的中文长名。）
 * 2. 「一个域可以有几个负责人」是这一版新加的（`Domain.driIds`）。退回单值的写法
 *    照旧编译得过、照旧跑得起来，只是屏幕上少一个人 —— 而少的那个人不会喊。
 *
 * 所以这里只认三件事：**名字**、**名单**、**没有人的时候屏幕上说什么**。
 */
import { describe, expect, it } from "vitest";

import { domains, people } from "./seed-tokenking";

/** 域编号 → 屏幕上的名字。 */
const nameOf = (code: string) => domains.find((d) => d.id === code)?.name;

/** 域编号 → 负责人姓名，按名单顺序。 */
const drisOf = (code: string) =>
  (domains.find((d) => d.id === code)?.driIds ?? []).map(
    (id) => people.find((p) => p.id === id)?.name,
  );

describe("业务域的名字", () => {
  it("六个域是一号位校准过的那一套", () => {
    expect(nameOf("D-03")).toBe("Method");
    expect(nameOf("D-04")).toBe("Agents");
    expect(nameOf("D-05")).toBe("Engine & Ontology");
    expect(nameOf("D-06")).toBe("TokenOps");
    expect(nameOf("D-07")).toBe("Organization & Talent");
    expect(nameOf("D-08")).toBe("Finance & Compliance");
  });

  it("旧名字一个都不许再出现", () => {
    /*
     * 反着钉一遍。上面那几条只保证「新名字在」，而一次半成品的改动完全可能两套名字
     * 并存（比如生成器改了、种子没重跑）—— 那时屏幕上是新名字，而别处按旧名字取的
     * 地方安静地取不到东西。
     */
    const all = domains.map((d) => d.name);
    for (const old of ["Foundry & Engine（FE）", "TokenHub", "HR", "Finance", "人才与组织能力", "公司运营与保障"]) {
      expect(all).not.toContain(old);
    }
  });
});

describe("谁负责", () => {
  it("一个域可以有两个人，顺序照交上来的那份名单", () => {
    expect(drisOf("D-05")).toEqual(["刘人豪", "于斯一"]);
    expect(drisOf("D-04")).toEqual(["陈溪南", "孙铭泽"]);
  });

  it("一个人的那几个域", () => {
    expect(drisOf("D-03")).toEqual(["白田田"]);
    expect(drisOf("D-07")).toEqual(["秦梦怡"]);
    expect(drisOf("D-08")).toEqual(["唐巨杰"]);
  });

  it("TokenOps 现在一个负责人都没有 —— 空名单，不是占位的岗位", () => {
    /*
     * 这一条是这份校准里最容易被「修好」的一条：一个空数组看起来像漏填，而随手补一个
     * 「业务负责人」进去，屏幕上就再也看不出这个域没有人。空着是事实，要被看见。
     */
    expect(drisOf("D-06")).toEqual([]);
  });

  it("校准带进来的那四个人真的在名册上", () => {
    // 名单里指向一个不存在的人时，`drisOf` 会交出 undefined —— 上面几条会先红，
    // 但红在名字上，指不出「这个人根本不存在」。这一条把话说明白。
    for (const name of ["唐巨杰", "秦梦怡", "于斯一", "陈溪南"]) {
      expect(people.some((p) => p.name === name)).toBe(true);
    }
  });
});
