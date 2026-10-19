import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { loadPeople } from "../src/peopleDirectory.js";
import { mergeImportedWeeks, parseWeeklyReviewDoc, writeImportedWeeks, type ImportDoc, type ImportedWeek } from "../src/weeklyReviewImport.js";

/**
 * 10 月历史周复盘一次性导入（D-01）。用本机 lark-cli 以本人身份（--as user）只读飞书知识库，按周拆好写进 weekly_reviews，
 * 状态为「已提交（导入）」。默认 dry-run：只读飞书、解析、打印统计（多少人、多少周），不连数据库；加 --write 才写库。
 * 格式与来源见 .scratch/weekly-review/导入说明.md。
 *
 *   pnpm --filter @warmap/api weekly-reviews:import                     # dry-run
 *   pnpm --filter @warmap/api weekly-reviews:import --out parsed.json   # dry-run，并把解析结果存成文件逐份核对
 *   pnpm --filter @warmap/api weekly-reviews:import --write             # 写库（需要 DATABASE_URL；已有的周不覆盖）
 *
 * 需要 COMPANY_PEOPLE_SEED（飞书上的姓名对到天枢的人）；lark-cli 位置可用 LARK_CLI 指定。
 */

const SPACE = "7687912552839252968";
/** 知识库「责任单元 / 业务域」和「战场划分」两棵树。 */
const ROOTS = ["YEhVwPN9liTZzGk0ZgDcvouInhg", "ONFQwrJPbiAvMnkBQDPcb3ctn2d"];
const TITLE = /周复盘|周度复盘|weekly[\s_-]*review/i;
const SINCE = "2026-09-28";
const HOST = "https://tokenking.feishu.cn";

const larkCli = process.env.LARK_CLI ?? (process.platform === "win32"
  ? join(process.env.APPDATA ?? "", "npm/node_modules/@larksuite/cli/bin/lark-cli.exe") : "lark-cli");
function lark(args: string[]): any {
  // 不走 shell：分页标记里有引号。
  const out = execFileSync(larkCli, [...args, "--as", "user", "--format", "json"], { encoding: "utf8", maxBuffer: 64 << 20 });
  const parsed = JSON.parse(out);
  if (parsed.ok === false) throw new Error(`lark-cli ${args.slice(0, 2).join(" ")} 失败：${parsed.error?.message ?? out.slice(0, 200)}`);
  return parsed.data;
}

/** via：mission-card 是挂在本人 Mission Card 节点下、标题合「姓名｜DRI 周度复盘｜日期」的；tree 是树里别处按关键词找到的；search 是云空间搜索兜底。 */
type Candidate = { token: string; objToken: string; title: string; url: string; path: string; via: "mission-card" | "tree" | "search"; ownerName?: string; ownerId?: string; createdAt?: string; editedAt?: string | null };

/** 本人当月 Mission Card 的知识库节点（「姓名｜2026 年 10 月 Mission Card」这类）。 */
const MISSION_CARD = /mission\s*card/i;
/** 周复盘的标题：「姓名｜DRI 周度复盘｜2026.10.12–10.18」。 */
const WEEKLY_TITLE = /^[^｜|]+\s*[｜|]\s*DRI\s*周度?复盘\s*[｜|]/;

/**
 * 先找每个人的 Mission Card 节点（业务域 › 某域 › 本人的 Mission Card），按标题格式匹配它下面的周复盘；
 * 树里别处按关键词匹配到的也收下（via=tree），只是不算主路径。
 */
function walk(parent: string, path: string, depth: number, found: Map<string, Candidate>, cards: Map<string, string>, underCard = false) {
  let pageToken = "";
  do {
    const data = lark(["wiki", "+node-list", "--space-id", SPACE, "--parent-node-token", parent, ...(pageToken ? ["--page-token", pageToken] : [])]);
    for (const node of data.nodes ?? []) {
      const here = `${path} / ${node.title}`;
      const isCard = MISSION_CARD.test(node.title);
      if (isCard) cards.set(node.node_token, here);
      if (node.obj_type === "docx" && TITLE.test(node.title) && !isCard) {
        found.set(node.node_token, { token: node.node_token, objToken: node.obj_token, title: node.title, url: `${HOST}/wiki/${node.node_token}`, path: here,
          via: underCard && WEEKLY_TITLE.test(node.title) ? "mission-card" : "tree" });
      }
      if (node.has_child && depth < 6) walk(node.node_token, here, depth + 1, found, cards, underCard || isCard);
    }
    pageToken = data.has_more ? data.page_token : "";
  } while (pageToken);
}

/** 云空间搜索兜底：不在这两棵树里的（例如直接放在云盘的），按关键词搜 9/28 以后建的。 */
function search(query: string, found: Map<string, Candidate>) {
  let pageToken = "";
  for (let page = 0; page < 10; page += 1) {
    const data = lark(["drive", "+search", "--query", query, "--created-since", SINCE, "--page-size", "20", ...(pageToken ? ["--page-token", pageToken] : [])]);
    for (const result of data.results ?? []) {
      const meta = result.result_meta ?? {};
      const title = String(result.title_highlighted ?? "").replace(/<\/?h>/g, "");
      if (!TITLE.test(title) || !/docx|wiki/i.test(`${result.entity_type} ${JSON.stringify(meta.doc_types ?? "")}`)) continue;
      const known = [...found.values()].find((item) => item.token === meta.token || item.objToken === meta.token);
      if (known) { known.ownerName ??= meta.owner_name; continue; }
      found.set(meta.token, { token: meta.token, objToken: meta.token, title, url: meta.url ?? `${HOST}/docx/${meta.token}`, path: "云空间搜索", via: "search",
        ownerName: meta.owner_name, createdAt: meta.create_time_iso, editedAt: meta.update_time_iso ?? null });
    }
    if (!data.has_more) break;
    pageToken = data.page_token;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const outAt = args.indexOf("--out");
  const out = outAt >= 0 ? args[outAt + 1] : undefined;
  if (args.includes("--help")) { console.log("用法：weekly-reviews:import [--out parsed.json] [--write]"); return; }
  const peopleSeed = process.env.COMPANY_PEOPLE_SEED;
  if (!peopleSeed) throw new Error("missing env COMPANY_PEOPLE_SEED");
  const people = loadPeople(peopleSeed);
  const byName = new Map(people.map((person) => [person.displayName, person.personId]));

  const found = new Map<string, Candidate>();
  const cards = new Map<string, string>();
  for (const root of ROOTS) walk(root, root === ROOTS[0] ? "业务域" : "战场划分", 0, found, cards);
  for (const query of ["周复盘", "Weekly Review"]) search(query, found);

  const docs: { candidate: Candidate; personId: string | null; weeks: ImportedWeek[]; doc: ImportDoc }[] = [];
  const names = new Map<string, string>();
  for (const candidate of found.values()) {
    if (candidate.via !== "search") {
      const node = lark(["wiki", "+node-get", "--node-token", candidate.token]);
      candidate.ownerId = node.owner;
      candidate.createdAt = new Date(Number(node.obj_create_time) * 1000).toISOString();
      candidate.editedAt = new Date(Number(node.obj_edit_time) * 1000).toISOString();
    }
    if (candidate.createdAt && candidate.createdAt.slice(0, 10) < SINCE) continue;
    if (!candidate.ownerName && candidate.ownerId) {
      if (!names.has(candidate.ownerId)) names.set(candidate.ownerId, lark(["contact", "+search-user", "--user-ids", candidate.ownerId]).users?.[0]?.localized_name ?? "");
      candidate.ownerName = names.get(candidate.ownerId) || undefined;
    }
    // 标题里写了人名的（「于斯一｜DRI周复盘｜…」）以标题为准：文档可能是别人代建的。
    const titled = people.find((person) => candidate.title.startsWith(person.displayName));
    const personId = titled?.personId ?? (candidate.ownerName ? byName.get(candidate.ownerName) ?? null : null);
    const markdown = String(lark(["docs", "+fetch", "--doc", candidate.token, "--doc-format", "markdown"]).document?.content ?? "");
    const doc: ImportDoc = { title: candidate.title, url: candidate.url, markdown, editedAt: candidate.editedAt ?? null };
    docs.push({ candidate, personId, weeks: parseWeeklyReviewDoc(doc), doc });
  }

  const usable = docs.filter((item) => item.personId && item.weeks.length);
  // 同一人同一周有几份（例如 RU 一份、Mission 一份）：拼成一份，每份前面一行来源。
  const groups = new Map<string, { personId: string; parts: { doc: ImportDoc; week: ImportedWeek }[] }>();
  for (const item of usable) for (const week of item.weeks) {
    const key = `${item.personId}:${week.weekStart}`;
    const group = groups.get(key) ?? { personId: item.personId!, parts: [] };
    group.parts.push({ doc: item.doc, week });
    groups.set(key, group);
  }
  const rows = new Map([...groups].map(([key, group]) => [key, { personId: group.personId, ...mergeImportedWeeks(group.parts) }]));
  const via = (kind: Candidate["via"]) => [...found.values()].filter((item) => item.via === kind).length;
  console.log(`Mission Card 节点 ${cards.size} 个；候选 ${found.size} 份（Mission Card 下 ${via("mission-card")} 份、树里别处 ${via("tree")} 份、搜索兜底 ${via("search")} 份），9/28 以后建的 ${docs.length} 份`);
  for (const item of docs) {
    console.log(`- [${item.candidate.via}] ${item.candidate.ownerName ?? "?"} → ${item.personId ?? "对不上人"} | ${item.candidate.title} | ${item.candidate.path} | 周：${item.weeks.map((week) => `${week.weekStart}(${week.lines} 行)`).join("、") || "没有 10 月的周"}`);
  }
  const persons = new Set([...rows.values()].map((row) => row.personId));
  const weeks = [...new Set([...rows.values()].map((row) => row.week.weekStart))].sort();
  console.log(`\n可导入：${persons.size} 人、${rows.size} 份周复盘（${weeks.map((week) => `${week} 周 ${[...rows.values()].filter((row) => row.week.weekStart === week).length} 份`).join("，")}）`);
  const merged = [...groups.values()].filter((group) => group.parts.length > 1);
  if (merged.length) console.log(`同一人同一周有几份、已拼成一份：${merged.map((group) => `${group.personId} ${group.parts[0].week.weekStart}（${group.parts.map((part) => part.doc.title).join(" + ")}）`).join("；")}`);
  const unmatched = docs.filter((item) => !item.personId);
  if (unmatched.length) console.log(`对不上人：${unmatched.map((item) => `${item.candidate.title}（${item.candidate.ownerName ?? "没有所有者姓名"}）`).join("；")}`);
  if (out) writeFileSync(out, JSON.stringify([...rows.values()].map((row) => ({ personId: row.personId, title: row.doc.title, url: row.doc.url, ...row.week })), null, 2));

  if (!write) { console.log("\ndry-run：没有写库。核对无误后加 --write 写入。"); return; }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("missing env DATABASE_URL");
  const pool = new Pool({ connectionString: url, max: 2 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const written = await writeImportedWeeks(client.query.bind(client), [...rows.values()], new Date());
    await client.query("COMMIT");
    console.log(`写入 ${written} 份，已有的 ${rows.size - written} 份没有覆盖`);
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); await pool.end(); }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
