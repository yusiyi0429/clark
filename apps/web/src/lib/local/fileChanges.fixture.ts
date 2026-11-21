/**
 * 改动视图的例子（单测和假本机共用）：照「在改前那份里把第 n 个 find 换成 replace」造出改后那份和逐处的位置，就是本机切好给网页的样子。
 */
import type { FileChange } from "./fileChanges";

export function edited(before: string, edits: [find: string, replace: string, nth?: number][]): { before: string; after: string; changes: FileChange[] } {
  const spots = edits.map(([find, replace, nth = 0], index) => {
    let at = -1;
    for (let n = 0; n <= nth; n += 1) at = before.indexOf(find, at + 1);
    if (at < 0) throw new Error(`没找到 ${find}`);
    return { id: `c${index + 1}`, start: at, end: at + find.length, replace };
  }).sort((x, y) => x.start - y.start);
  let after = "";
  let cursor = 0;
  const changes: FileChange[] = [];
  for (const spot of spots) {
    after += before.slice(cursor, spot.start);
    const from = after.length;
    after += spot.replace;
    changes.push({ id: spot.id, before: { start: spot.start, end: spot.end }, after: { start: from, end: after.length } });
    cursor = spot.end;
  }
  after += before.slice(cursor);
  return { before, after, changes };
}

/** 验收第 10 条的周报（照示意）：改前那份。 */
export const REPORT = [
  "# 十一月第二周周报", "", "这一周把主循环的问题排了一遍，先修再上线。", "",
  "## 一、本周做了什么", "", "主循环这一批的接口约定交了，云端、本机、网页三边同时开工。执行方遇到要登录、验证码的事不再绕，做不了的标成要本人补。", "",
  "子会话停下的报告不再让管线回话，项目对话安静了不少。", "",
  "## 二、卡在哪", "", "普通文件夹的兜底还在做：改之前先留一份，改坏了能恢复。周日前合进来。", "",
  "## 三、上线安排", "", "新首页定在 11 月 13 日（周五）上线，Nexus 的切换跟着走。", "", "上线前一天在预发走一遍全链。每一步部署照旧要本人点头。", "",
  "## 四、要协调的", "", "溪南：预发全链的时间。晨星：一次运行的合同，和 Chat 新接口里要留的字段。", "",
  "## 五、各项评估", "", "| 项 | 评估 |", "| --- | --- |", "| 交付质量 | 良好 |", "| 进展评估 | 良好 |", "| 协作 | 良好 |", "",
  "## 六、下周", "", "照整版清单在本地测一遍，过了进预发。", "",
].join("\n");
