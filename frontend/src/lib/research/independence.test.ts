import { describe, expect, it } from "vitest";

import { assign, simhash64 } from "./independence";

const item = (url: string, sourceDomain: string, text: string) => ({ url, sourceDomain, text });

const groupOf = (url: string, out: ReturnType<typeof assign>) =>
  out.find((g) => g.url === url)!.group;

describe("出处归因优先于域名", () => {
  it("两个站转同一家的稿，只算一个来源", async () => {
    /*
     * 这就是这一层存在的理由。按域名数数，这两条是「两个独立来源互相印证」；按出处
     * 数数，它是一家的说法被抄了两遍。前一种读法会让一号位以为这个数字已经被交叉验证过。
     */
    const out = assign([
      item("https://a.com/1", "a.com", "据新华社，某项指标在本季度回落。"),
      item("https://b.com/2", "b.com", "据新华社报道，某项指标在本季度回落。"),
    ]);
    expect(groupOf("https://a.com/1", out)).toBe("src:新华社");
    // 「报道」不是机构名的一部分，剥掉之后两条必须落在同一组。
    expect(groupOf("https://b.com/2", out)).toBe("src:新华社");
  });

  it("「社」不剥 —— 新华社和新华网是两家", async () => {
    const out = assign([
      item("https://a.com/1", "a.com", "据新华社，某项指标在本季度回落。"),
      item("https://b.com/2", "b.com", "据新华网，某项指标在本季度回落。"),
    ]);
    expect(groupOf("https://a.com/1", out)).toBe("src:新华社");
    expect(groupOf("https://b.com/2", out)).toBe("src:新华网");
  });

  it("「来源：」和「转自」这几种引出方式都认", async () => {
    const out = assign([
      item("https://a.com/1", "a.com", "来源：国家统计局。本季度数据如下。"),
      item("https://b.com/2", "b.com", "转自国家统计局，本季度数据如下。"),
    ]);
    expect(groupOf("https://a.com/1", out)).toBe("src:国家统计局");
    expect(groupOf("https://b.com/2", out)).toBe("src:国家统计局");
  });

  it("「某机构表示」这种不算署名", async () => {
    // 宽到这一档，正文里随便一个人名都会被当成出处，于是每一页各自成一组 —— 那时
    // 循环引用会全部通过覆盖判定。
    const out = assign([item("https://a.com/1", "a.com", "某机构表示，某项指标在本季度回落。")]);
    expect(groupOf("https://a.com/1", out)).toBe("dom:a.com");
  });

  it("「数据显示」里的那个「据」不是署名标记", async () => {
    /*
     * 这一条是真运行里量出来的：一批算力议题的页面里，贵州省大数据局、新华网、百家号
     * 三条互不相干的稿子全部匹配到「数据显示，」，被折成同一个 `src:显示` 组。
     *
     * **危害是反的** —— 假合并会让独立来源被少算，覆盖判定因此比设计的更严：三个真正
     * 独立的来源被当成一个，一条本该达标的命题被判成「只有一个独立来源」。而屏幕上
     * 只会显示「够不上互相印证」，没有任何一处会说这是折叠折错了。
     *
     * 同源的还有「票据」「根据」「据实结算」「据此」「据悉」—— 都不是「据某机构」。
     */
    const out = assign([
      item("https://a.gov.cn/1", "a.gov.cn", "数据显示，2025 年该省专项资金规模为一亿元。"),
      item("https://b.com/2", "b.com", "数据显示，某运营商智算服务收入增速可观。"),
      item("https://c.com/3", "c.com", "本季度业绩数据显示，公司云业务的剩余履约义务增长。"),
      item("https://d.com/4", "d.com", "管理遵循合法合规，据实结算、序时兑现的原则。"),
      item("https://e.com/5", "e.com", "纸面数据看似接近，但实际表现因模型结构而异。"),
    ]);
    // 五条各自成组，一条都不许被折进同一个假署名里。
    expect(groupOf("https://a.gov.cn/1", out)).toBe("dom:a.gov.cn");
    expect(groupOf("https://b.com/2", out)).toBe("dom:b.com");
    expect(groupOf("https://c.com/3", out)).toBe("dom:c.com");
    expect(groupOf("https://d.com/4", out)).toBe("dom:d.com");
    expect(groupOf("https://e.com/5", out)).toBe("dom:e.com");
  });

  it("「图片来源：」「信息来源：」照旧认得出", async () => {
    /*
     * 修「据」的时候最容易连坐的就是这两个：`来源[:：]` 前面常常带着「图片」「信息」
     * 「数据」这类词。收紧到「必须在句首或标点之后」会把它们一起误伤 —— 而它们恰恰是
     * 最硬的署名信号。所以约束只加在光杆的「据」上，另外三种引出方式一个字都不动。
     */
    const out = assign([
      item("https://a.com/1", "a.com", "图片来源：火山引擎。所谓 token 就是模型处理文本的单位。"),
      item("https://b.com/2", "b.com", "信息来源：火山引擎，二〇二六年三月的模型价格对比。"),
    ]);
    expect(groupOf("https://a.com/1", out)).toBe("src:火山引擎");
    expect(groupOf("https://b.com/2", out)).toBe("src:火山引擎");
  });
});

describe("正文近重复折叠", () => {
  it("没署名但正文一样的，按转载折成一组", async () => {
    /*
     * 只钉两头（完全相同 / 明显不同）。中间那一档（改了标题、加了编者按）落在阈值内还是
     * 外，取决于 md5 在那几个二元组上的散布 —— 写一个「刚好 6」的例子，测的是那个例子
     * 而不是这段代码。真实转载的距离分布留给实验台去量。
     */
    const text = "某项指标在本季度回落约两成，相关部门尚未说明原因，行业内对此有两种解释。";
    const out = assign([
      item("https://a.com/1", "a.com", text),
      item("https://b.com/2", "b.com", text),
    ]);
    expect(groupOf("https://b.com/2", out)).toBe(groupOf("https://a.com/1", out));
    expect(out.find((g) => g.url === "https://b.com/2")!.why).toContain("近似重复");
  });

  it("各自写的两篇不折", async () => {
    const out = assign([
      item("https://a.com/1", "a.com", "某项指标在本季度回落约两成，相关部门尚未说明原因。"),
      item("https://b.com/2", "b.com", "我们走访了三家工厂，问的是订单排到几月、加班有没有减少。"),
    ]);
    expect(groupOf("https://a.com/1", out)).toBe("dom:a.com");
    expect(groupOf("https://b.com/2", out)).toBe("dom:b.com");
  });

  it("同一个站的两页各自入组，靠域名兜底就是一组", async () => {
    const out = assign([
      item("https://a.com/1", "a.com", "某项指标在本季度回落约两成，相关部门尚未说明原因。"),
      item("https://a.com/2", "a.com", "我们走访了三家工厂，问的是订单排到几月、加班有没有减少。"),
    ]);
    expect(groupOf("https://a.com/2", out)).toBe("dom:a.com");
  });
});

describe("每条都要答得出「凭什么同组」", () => {
  it("why 不为空", async () => {
    // 「这两条为什么只算一个来源」是屏幕上会被问到的问题。
    const out = assign([item("https://a.com/1", "a.com", "据新华社，某项指标回落。")]);
    expect(out[0].why).toContain("新华社");
  });
});

describe("simhash", () => {
  it("同一段文本每次都是同一个指纹", async () => {
    // 不确定的指纹会让同一批页面这次折成两组、下次折成一组，而覆盖判定读的就是组数。
    const a = simhash64("某项指标在本季度回落约两成。");
    const b = simhash64("某项指标在本季度回落约两成。");
    expect([...a]).toEqual([...b]);
  });

  it("64 位，每位是 0 或 1", async () => {
    const sig = simhash64("某项指标在本季度回落约两成。");
    expect(sig).toHaveLength(64);
    expect([...sig].every((x) => x === 0 || x === 1)).toBe(true);
  });
});
