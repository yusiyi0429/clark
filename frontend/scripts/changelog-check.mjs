/**
 * 干了活有没有入账 —— 更新日志漏记的兜底。
 *
 *   pnpm changelog:check
 *
 * 它不猜内容，只回答一个问题：**上一次改更新日志之后，又提交了些什么**。
 * 办法是 `git log <日志上次被提交的那个提交>..HEAD` —— 不需要在日志里记 sha，
 * 也不需要任何人维护「上次记到哪儿」这个游标：那个游标就是这个文件自己的提交历史。
 *
 * 所以约定是**日志跟着那次改动一起提交**（同一个 commit）。照这么走，这条命令永远
 * 报 0 条；一旦有人连着提交了三次都没碰日志，它就把那三条列出来。
 *
 * 退出码：有漏记 = 1（能当上线前的一道闸），干净 = 0。工作区里已经在改日志了
 * 也算 0 —— 那说明账正在补，不是漏。
 */
import { execFileSync } from "node:child_process";

const LOG_FILE = "src/lib/changelog.ts";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const base = git("log", "-1", "--format=%H", "--", LOG_FILE);
if (!base) {
  console.error(`${LOG_FILE} 还没进过任何提交 —— 先把它提交一次，这条命令才有起点。`);
  process.exit(1);
}

// `--no-merges`：合并提交本身不带产出，它带进来的那些提交在这份列表里各自出现。
const pending = git("log", "--no-merges", "--format=%h  %ad  %s", "--date=short", `${base}..HEAD`)
  .split("\n")
  .filter(Boolean);

const dirty = git("status", "--porcelain", "--", LOG_FILE) !== "";

console.log(`更新日志上次入账：${git("log", "-1", "--format=%h  %ad  %s", "--date=short", base)}`);

if (pending.length === 0) {
  console.log(dirty ? "之后没有新提交；日志正在改（工作区里有未提交的改动）。" : "之后没有新提交 —— 账是平的。");
  process.exit(0);
}

console.log(`\n之后有 ${pending.length} 个提交没进日志：\n`);
for (const line of pending) console.log(`  ${line}`);

if (dirty) {
  console.log(`\n${LOG_FILE} 工作区里已有改动 —— 当成正在补账，不拦。`);
  process.exit(0);
}

console.log(`\n把这些写成一条（或几条）加到 ${LOG_FILE} 最前面，`);
console.log("并把 package.json 的 version 跟着改（changelog.test.ts 盯着这一条）。");
process.exit(1);
