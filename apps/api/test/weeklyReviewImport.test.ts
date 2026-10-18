import { describe, expect, it } from "vitest";
import { migrate } from "../src/migrate.js";
import { mondayOf, parseWeeklyReviewDoc, weekOfText, writeImportedWeeks, type ImportDoc } from "../src/weeklyReviewImport.js";
import { createTestDb } from "./helpers.js";

/** 结构照飞书上几种写法造的样例（内容是编的）：模板 H2、H1 写周、表格两列、加粗段落、一份按周追加。 */
const URL = "https://tokenking.feishu.cn/wiki/node";
const doc = (markdown: string, title = "某人｜DRI周度复盘｜2026年10月"): ImportDoc => ({ title, url: URL, markdown, editedAt: "2026-10-16T10:00:00Z" });
const text = (lines: string[]) => lines.map((line) => `${line}[飞书原文](${URL})`).join("\n");

describe("飞书周复盘解析", () => {
  it("周：区间按结束那天归周，单个日期按那天", () => {
    expect(mondayOf("2026-10-16")).toBe("2026-10-12");
    expect(weekOfText("# 2026.10.12-10.16")).toBe("2026-10-12");
    expect(weekOfText("复盘周期：2026年10月12日—16日")).toBe("2026-10-12");
    expect(weekOfText("统计：9月28日至10月3日")).toBe("2026-09-28");
    expect(weekOfText("10月1日—10月8日（国庆）")).toBe("2026-10-05");
    expect(weekOfText("DRI周复盘｜2026-10-08")).toBe("2026-10-05");
  });

  it("模板五块按标题归位，每行挂飞书原文；标题里的状态留作正文", () => {
    const [week] = parseWeeklyReviewDoc(doc(`<title>x</title>\n# 2026.10.12-10.16\n## 本周总体判断\n**状态：黄｜安装包好了**\n## 关键进展与 Evidence\n- 装好三台\n- 发了说明\n## 最重要的问题及 Why\n同意开关没做\n## 判断变化 / Implication\n瓶颈转到上手\n## 当前处理\n下周做开关\n---`));
    expect(week.weekStart).toBe("2026-10-12");
    expect(week.body).toEqual({
      overall: { text: text(["黄｜安装包好了"]), sources: [URL] },
      progress: { text: text(["- 装好三台", "- 发了说明"]), sources: [URL] },
      issues: { text: text(["同意开关没做"]), sources: [URL] },
      implications: { text: text(["瓶颈转到上手"]), sources: [URL] },
      actions: { text: text(["下周做开关"]), sources: [URL] },
    });
  });

  it("表格两列（项目｜结论）、加粗段落、正文写周期的写法", () => {
    const [table] = parseWeeklyReviewDoc(doc(`<table><tr><td><b>项目</b></td><td>结论</td></tr><tr><td>本周总体判断</td><td>黄｜还差控制链</td></tr><tr><td>关键进展与 Evidence</td><td>凭证加密入库<br/>管理页完成</td></tr></table>`, "Weekly Review｜2026.10.12-10.16"));
    expect(table.body.overall.text).toBe(text(["黄｜还差控制链"]));
    expect(table.body.progress.text).toBe(text(["凭证加密入库", "管理页完成"]));
    expect(table.body.issues).toEqual({ text: "无", sources: [] });
    const [bold] = parseWeeklyReviewDoc(doc(`# **2026.10.12—10.16**\n周期：10.12—10.16\n**总体判断｜绿｜按计划**\n**01 ｜ 关键进展**\n内部评审完成`));
    expect(bold.body.overall.text).toBe(text(["绿｜按计划"]));
    expect(bold.body.progress.text).toBe(text(["内部评审完成"]));
  });

  it("一份按周追加的：按带日期的标题拆成几周；10 月以外的周不要", () => {
    const weeks = parseWeeklyReviewDoc(doc(`# 2026.09.21-09.25\n## 关键进展\n九月的\n# 2026.10.12-10.16\n## 关键进展\n第三周\n# 2026.10.19-10.23\n## 关键进展\n第四周`));
    expect(weeks.map((week) => [week.weekStart, week.body.progress.text])).toEqual([["2026-10-12", text(["第三周"])], ["2026-10-19", text(["第四周"])]]);
  });

  it("写库：已提交（导入），已有的周不覆盖", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const q = db.query.bind(db);
      const [week] = parseWeeklyReviewDoc(doc(`# 2026.10.12-10.16\n## 关键进展\n导入的`));
      await q(`INSERT INTO weekly_reviews(id,person_id,week_start,status,created_at,updated_at) VALUES(gen_random_uuid(),'a','2026-10-12','drafting',now(),now())`);
      expect(await writeImportedWeeks(q, [{ personId: "a", doc: doc(""), week }, { personId: "b", doc: doc(""), week }], new Date("2026-10-18T08:00:00Z"))).toBe(1);
      expect((await q("SELECT person_id,status,origin,draft_source,import_source,submitted_at FROM weekly_reviews ORDER BY person_id")).rows).toEqual([
        expect.objectContaining({ person_id: "a", status: "drafting", origin: "tianshu" }),
        { person_id: "b", status: "submitted", origin: "import", draft_source: "import", import_source: { title: "某人｜DRI周度复盘｜2026年10月", url: URL },
          submitted_at: new Date("2026-10-16T10:00:00Z") }]);
    });
  });
});
