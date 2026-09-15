/**
 * 从本体的 TriG 实例文件生成前端种子。
 *
 *   node scripts/gen-seed-from-ontology.mjs <本体仓库路径> [> src/lib/data/seed-tokenking.ts]
 *   例：node scripts/gen-seed-from-ontology.mjs ../Ontology-API-main1
 *
 * 为什么要生成而不是手写：CEO 在屏幕上看到的，和 agent 从本体读到的，必须是同一份
 * 事实。手写一份种子，本体一更新两边就开始漂移 —— 而这种漂移在演示时表现为「agent
 * 说的和界面上写的不一样」，是最难看的一种失败。
 *
 * 边界要说清楚：**本体里没有产品运行态对象。** 对话、判断链路图上的 Point、研究报告、
 * 闭环单 —— 这些本来就该由 agent 在运行时产生，不该 seed。所以生成出来的种子里那几个
 * 集合是空的，前端点进议题会是空的，直到 A3 / A6 真跑起来。这是对的，不是缺陷。
 *
 * 这是构建期工具，不是运行时路径：它直接读 .trig，绕过了本体 API 的准入策略与
 * 有效期门禁。运行时取 Context 一律走 lib/ontology/client.ts。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 「议题动摇哪条判断」的关联。本体里没有这层关系 —— 但它是产品的核心回路
 * （四段式第三段就是它，为空则出卡门槛失效）。所以由模型提案、单独成文件、
 * 标为待确认，符合产品自己的原则：Agent 提案，人确认。
 * 文件不存在时 judgmentRefs 为空 —— 那是诚实的空，不是猜。
 */
const LINKS_FILE = "scripts/issue-judgment-links.json";

const root = process.argv[2];
if (!root) {
  console.error("用法: node scripts/gen-seed-from-ontology.mjs <本体仓库路径>");
  process.exit(1);
}

// ---------------------------------------------------------------- 解析 TriG
// 实例文件的形状很规整：`tkos:<id> a <types> ; <谓词> "字面量" / tkos:<引用> ... .`
// 这里用正则而不是完整 RDF 解析器 —— 构建期工具，够用且没有依赖。
// 如果本体开始用 blank node、集合语法或多行字面量，这里要换成真解析器。
const dir = join(root, "data", "instances");
const text = readdirSync(dir)
  .filter((f) => f.endsWith(".trig"))
  .sort()
  .map((f) => readFileSync(join(dir, f), "utf8"))
  .join("\n");

const objs = new Map();
const blockRe = /tkos:([a-z0-9-]+)\s+a\s+([^;]+);(.*?)(?=\n\s*(?:tkos:[a-z0-9-]+\s+a\s|\}))/gs;
for (const m of text.matchAll(blockRe)) {
  const [, id, types, body] = m;
  const cur = objs.get(id) ?? { id, types: [], body: "" };
  cur.types.push(...[...types.matchAll(/tkos:([A-Za-z]+)/g)].map((x) => x[1]));
  cur.body += body;
  objs.set(id, cur);
}

const lit = (o, p) => o?.body.match(new RegExp(`tkos:${p}\\s+"((?:[^"\\\\]|\\\\.)*)"`))?.[1] ?? null;
const ref = (o, p) => o?.body.match(new RegExp(`tkos:${p}\\s+tkos:([a-z0-9-]+)`))?.[1] ?? null;
const status = (o) => {
  const s = ref(o, "hasConfirmationStatus");
  return s ? s.replace(/^.*[:#]/, "") : null;
};
const of = (t) => [...objs.values()].filter((o) => o.types.includes(t));
const get = (id) => objs.get(id);
const day = (iso) => (iso ? iso.slice(0, 10) : "2026-08-01");

// 生成的 id → 本体 member id。压缩器和 Point 溯源用它把 [member:xxx] 换回短码。
const refMap = {};
const link = (code, memberId) => {
  if (memberId) refMap[code] = memberId;
  return code;
};

const esc = (s) => (s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ").trim();
const q = (s) => `"${esc(s)}"`;

/**
 * **不进产品的域。** 2026-08-31 一号位定的：01 方向与经营选择、02 Transformation 连同
 * 挂在它们下面的东西一起去掉。
 *
 * 代价当时查清楚了，是他看着这个数点的头：那 27 条判断是**整个预载案例库的溯源落点**
 * （D-01 是「方向与经营选择」，案例讲的正是这些议题在晃公司的哪条战略判断）。去掉之后
 * 判断板从 35 条剩 8 条，预载案例里那些指向 `01-J*` 的溯源一律摘掉。
 *
 * 要它们回来：把这个 Set 清空，重跑一次生成器。
 *
 * 挂在被去掉的域上的**判断也一起去掉**，而不是留成孤儿：`findJudgment` 找不到就抛，
 * 而一条指向不存在判断的议题在屏幕上的样子是整页白掉 —— 那和「这一页还没做」看起来
 * 一模一样。所以下面出判断、出议题、出 Mission 的地方都过一遍这张表。
 *
 * 写在这里而不是删生成物：删了下一次重跑就全回来了（同上面那张校准表的理由）。
 * 要它们回来就删掉这一行，重跑一次。
 */
const DROPPED_DOMAINS = new Set(["01", "02"]);

/**
 * 域去掉了、**判断本身留下**的那几条。
 *
 * 演示内容包（王总那一场）的判断层整个建在这六条战略判断上 —— 卡面上「动摇哪一条」、
 * 板上在晃的那几条、报告里的溯源芯片，指的都是它们。它们和「01 / 02 这两个域不要了」
 * 是两回事：域是组织分工，判断是公司押的那几句话，后者不因为前者被撤而不成立。
 *
 * 留下来的这几条**不属于任何域**（`domainId` 空着）。那不是数据缺失，是它此刻真实的
 * 样子 —— 屏幕上照实说「不属于任何业务域」，别拿一个还在的域顶上去。
 */
const KEPT_JUDGMENTS = new Set(["01-J1", "01-J5", "01-J7", "01-J11", "01-J12", "01-J13"]);
const kept = (code) => !DROPPED_DOMAINS.has(code);

// ------------------------------------------------------------------ 组织骨架
const domainSrcAll = of("Domain").sort((a, b) => (lit(a, "displayName") ?? "").localeCompare(lit(b, "displayName") ?? ""));
const personSrc = of("Person");
const assignSrc = of("RoleAssignment");

// domain slug -> 两位编号。本体的 displayName 形如「Domain 05 · Foundry & Engine（FE）」。
const domainCode = (o) => (lit(o, "displayName") ?? "").match(/Domain\s+(\d+)/)?.[1] ?? "00";
const domainNameRaw = (o) => (lit(o, "displayName") ?? "").replace(/^Domain\s+\d+\s*·\s*/, "");
/** 屏幕上的域名。校准表优先（见上面那段），没校准的用本体原名。 */
const domainName = (o) => DOMAIN_NAME[domainCode(o)] ?? domainNameRaw(o);
/** 真正进产品的那几个域。被去掉的那两个（`DROPPED_DOMAINS`）从这里就不在了。 */
const domainSrc = domainSrcAll.filter((o) => kept(domainCode(o)));

const personCode = new Map();
personSrc.forEach((p, i) => personCode.set(p.id, `PSN-${String(i + 1).padStart(2, "0")}`));

/*
 * 人名。
 *
 * 本体是**故意**把具名 DRI 换成岗位的（`2026-08-12-strategy-distillation.trig`：
 * 「DRI role entities (replace named-person DRIs)」），六个岗位实体的
 * scopeDescription 里都写着「在位人待确认」。所以这里不替谁填名字。
 *
 * 但也不要把「角色（DRI 岗位）」这五个字端到屏幕上 —— 那是本体给实体起名的方式，
 * 一号位读到的该是「DRI · 产品负责人」，不是「DRI · 产品负责人角色（DRI 岗位）」。
 * 「在位人待确认」原样留在 title 里，点得到。
 */
const personName = (p) => (lit(p, "displayName") ?? "").replace(/角色（DRI 岗位）$/, "");

/*
 * ---------------------------------------------------------------- 在位人校准
 *
 * 本体是**故意**把具名 DRI 换成岗位实体的（见上面 `personName` 那段：六个岗位的
 * scopeDescription 里都写着「在位人待确认」）。这张表就是那句「待确认」的答案 ——
 * 2026-08-31 一号位当面给的，本体还没跟上。
 *
 * ## 为什么写在这儿，不写进本体，也不去手改生成物
 *
 * · **不写进本体**：`data/instances/*.trig` 是按日期记的会议蒸馏记录。往里塞一条
 *   「唐巨杰是 Finance & Compliance 的 DRI」等于往某次会议记录里加一句那次会上没说过
 *   的话 —— 那是伪造证据，而不是更新事实。本体该长出一份「当前在位」的实例文件，
 *   那一天到了就删掉这张表。
 *
 * · **不手改生成物**：`seed-tokenking.ts` 头一行写着不要手改，而且那不是一句口号 ——
 *   仓库里那份此刻就带着一次手改（D-07 被改成「HR」、D-08 被改成「Finance」），
 *   下一次重跑会静默地把它们改回本体里的中文长名。写在这里，重跑保得住。
 *
 * 名字对不上的时候**当场报错**，不静默跳过：拼错一个字的后果是那个域悄悄回到「本体里
 * 那个岗位实体」，而屏幕上「数据负责人」和「刘人豪、于斯一」都像是真的。
 */
const CALIBRATED_AT = "2026-08-31";

/** 域编号 → 屏幕上的名字。本体里是中文长名，一号位读的是这一套。 */
const DOMAIN_NAME = {
  "05": "Engine & Ontology",
  "06": "TokenOps",
  "07": "Organization & Talent",
  "08": "Finance & Compliance",
};

/**
 * 域编号 → 在位的负责人，按交上来的顺序。**空数组 = 当前无人负责**，那不是漏填。
 *
 * 没列出来的域（01、02）不动，照旧跟着本体的 RoleAssignment 走。
 */
const DOMAIN_DRIS = {
  "03": ["白田田"],
  "04": ["陈溪南", "孙铭泽"],
  "05": ["刘人豪", "于斯一"],
  "06": [],
  "07": ["秦梦怡"],
  "08": ["唐巨杰"],
};

/** 本体里还没有的人。他们是真人，只是还没进任何一份蒸馏记录。 */
const EXTRA_PEOPLE = ["唐巨杰", "秦梦怡", "于斯一", "陈溪南"];

// 谁是这个域的 DRI：RoleAssignment 的 scope 指向域、holder 指向人或岗位。
const driOf = (domId) => {
  for (const a of assignSrc) {
    if (ref(a, "assignmentScope") !== domId) continue;
    const holder = ref(a, "assignmentHolder");
    if (holder && personCode.has(holder)) return personCode.get(holder);
  }
  return personCode.get(personSrc[0]?.id) ?? "PSN-01";
};

/*
 * 校准表里那几个人各自是谁。本体里已经有的按名字认，没有的（`EXTRA_PEOPLE`）在这里补号，
 * 接着本体那批往下排。
 */
const codeByName = new Map(personSrc.map((p) => [personName(p), personCode.get(p.id)]));
const extra = EXTRA_PEOPLE.map((name, i) => ({
  name,
  code: `PSN-${String(personSrc.length + i + 1).padStart(2, "0")}`,
}));
for (const e of extra) codeByName.set(e.name, e.code);

/**
 * 这个域的负责人名单。校准表说了算；没被校准的域照旧走本体的 RoleAssignment。
 *
 * 名字认不出来就**当场停**：静默跳过的后果是那个域悄悄退回本体里那个岗位实体，
 * 而屏幕上「数据负责人」和「刘人豪、于斯一」都像是真的。
 */
const driIdsOf = (code, ontoDomainId) => {
  const listed = DOMAIN_DRIS[code];
  if (!listed) return [driOf(ontoDomainId)];
  return listed.map((name) => {
    const id = codeByName.get(name);
    if (!id) throw new Error(`校准表里的「${name}」在本体里没有，也不在 EXTRA_PEOPLE 里`);
    return id;
  });
};

const domainOf = new Map(); // 本体 domain slug -> D-xx
domainSrc.forEach((d) => domainOf.set(d.id, `D-${domainCode(d)}`));

// ---------------------------------------------------------------------- 判断
// StrategyContent 是公司对自己的战略判断，OperatingPrinciple 是工作方法上的原则。
// 它们正是议题要去「动摇」的那个对象 —— 产品的核心就转在这上面。
const judgmentSrc = [
  ...of("StrategyContent").map((o) => ({ o, dom: "01", kind: "strategy" })),
  ...of("OperatingPrinciple").map((o) => ({ o, dom: "03", kind: "strategy" })),
];
const judgments = [];
const perDom = {};
for (const { o, dom, kind } of judgmentSrc) {
  /*
   * **先编号，再决定出不出。**
   *
   * 编号是按本体里的出现顺序数出来的，而屏幕上、演示内容包里、映射文件里到处按编号
   * 互相引用。过滤放在编号前面的话，剩下那几条会往前挪 —— `01-J5` 悄悄变成 `01-J2`，
   * 而所有指着 `01-J5` 的地方指到了另一句话上。那种错没有任何症状。
   */
  perDom[dom] = (perDom[dom] ?? 0) + 1;
  const code = link(`${dom}-J${perDom[dom]}`, o.id);
  // 被去掉的域上的判断不出，`KEPT_JUDGMENTS` 里点名留下的那几条除外。
  if (!kept(dom) && !KEPT_JUDGMENTS.has(code)) continue;
  const st = status(o);
  const src = get(ref(o, "sourcedFrom"));
  judgments.push({
    id: code,
    // 域被去掉、判断留下的那几条不属于任何域（见 `KEPT_JUDGMENTS`）。
    domainId: kept(dom) ? `D-${dom}` : "",
    kind,
    statement: lit(o, "displayName"),
    version: Number(lit(o, "version") ?? 1),
    // Candidate 在产品里就是「还没被确认过的判断」。不要美化成 confirmed ——
    // 本体当前一条 Confirmed 都没有，写成 confirmed 等于替 CEO 签了字。
    standing: st === "PreliminarilyConfirmed" ? "confirmed" : "unverified",
    confirmedBy: st === "PreliminarilyConfirmed" ? "初步确认" : "",
    confirmedAt: lit(o, "validFrom") ?? "2026-07-01T00:00:00+08:00",
    freshUntil: day(lit(o, "validUntil") ?? "2026-10-31"),
    basis: lit(o, "scopeDescription")
      ? [{ text: lit(o, "scopeDescription"), src: src ? { id: src.id, name: lit(src, "displayName") } : null }]
      : [],
    reopenTriggers: [],
    shakenBy: [],
  });
}

// ---------------------------------------------------------------------- 议题
/** 这一轮真的出了的判断。`judgmentRefs` 只留这里面有的。 */
const liveJudgments = new Set(judgments.map((j) => j.id));

const linkMap = new Map();
if (existsSync(LINKS_FILE)) {
  for (const l of JSON.parse(readFileSync(LINKS_FILE, "utf8")).links ?? []) {
    linkMap.set(l.issue, l.judgments ?? []);
  }
}
const issueSrc = of("StrategicIssue").filter((o) => o.id.startsWith("issue-"));
const issues = issueSrc.map((o, i) => {
  const code = link(`ISS-${String(i + 1).padStart(3, "0")}`, o.id);
  const at = lit(o, "validFrom") ?? "2026-07-01T00:00:00+08:00";
  return {
    id: code,
    title: lit(o, "displayName"),
    scope: lit(o, "scopeDescription"),
    /*
     * 本体里这些议题**全部**是 `hasConfirmationStatus tkos:Candidate` —— 已识别、
     * 待一号位确认是否值得投入认知资源。产品里对应的就是 `Candidate`：还在提请台上
     * 等他按那三个键，没有一件已经在办。
     *
     * 上一版这里写死 `Watching`，等于替他把十件事都「决定要盯着」了 —— 于是首页
     * 一打开「进行中」就坐着十条他从没看过一眼的东西，而提请台是空的。一切的起点
     * 是提请台，这一行就是那句话在数据上的样子。
     */
    state: "Candidate",
    /*
     * **只留还在的那几条判断。**
     *
     * 这份映射（`issue-judgment-links.json`）是另外维护的一份文件，它认不出这一轮哪些
     * 判断被去掉了（`DROPPED_DOMAINS`），也认不出它自己有没有写错编号 —— 现成就有一条
     * `01-J11`，本体里从来没有过。两种情况的下场是同一个：`findJudgment` 找不到就抛，
     * 而一条指向不存在判断的议题在屏幕上是整页白掉，看起来和「这一页还没做」一样。
     */
    judgmentRefs: (linkMap.get(code) ?? []).filter((r) => liveJudgments.has(r)),
    raisedAt: at,
  };
});

// ---------------------------------------------------------------------- 文档
const docSrc = of("SourceRecord");
const docs = docSrc.map((o, i) => {
  const code = link(`DOC-${String(i + 1).padStart(2, "0")}`, o.id);
  return {
    id: code,
    title: lit(o, "displayName"),
    body: lit(o, "scopeDescription") ?? "",
    ext: lit(o, "externalSourceIdentifier") ?? "",
    at: lit(o, "recordedAt") ?? lit(o, "validFrom") ?? "2026-08-01T00:00:00+08:00",
  };
});
const docByOnto = new Map(docSrc.map((o, i) => [o.id, `DOC-${String(i + 1).padStart(2, "0")}`]));

// -------------------------------------------------------------- Mission 卡
const missionSrc = of("Mission");
const missions = missionSrc.map((o, i) => {
  const code = link(`MC-${String(i + 1).padStart(2, "0")}`, o.id);
  const dom = domainOf.get(ref(o, "belongsTo")) ?? "D-05";
  return {
    id: code,
    domainId: dom,
    name: lit(o, "displayName"),
    driId: driOf(ref(o, "belongsTo") ?? ""),
    status: status(o) === "PreliminarilyConfirmed" ? "confirmed" : "pending",
  };
});

// ------------------------------------------------------------------ 输出
const out = [];
const w = (s = "") => out.push(s);

w(`/**`);
w(` * 词元云集的经营本体种子。**这个文件是生成的，不要手改。**`);
w(` *`);
w(` *   node scripts/gen-seed-from-ontology.mjs ../Ontology-API-main1 > src/lib/data/seed-tokenking.ts`);
w(` *`);
w(` * 数据源是本体仓库的 data/instances/*.trig，也就是 agent 运行时读的同一份事实。`);
w(` * 手改这里会让屏幕和 agent 说的话对不上 —— 要改内容，改本体。`);
w(` *`);
w(` * 本体里没有产品运行态对象（对话、Point、研究报告、闭环单），那些由 agent 运行时`);
w(` * 产生，所以这里生成不出来，也不该生成。`);
w(` */`);
w();
w(`import type {`);
w(`  Agent, Card, Company, CompanyOutcome, Doc, Domain, Issue, Judgment, JudgmentChange,`);
w(`  MissionCard,`);
w(`  Period, Person, Project,`);
w(`} from "./types";`);
w();
w(`// TODAY 是全站的「今天」，提请台按它筛当日摊开哪几张。`);
w(`import { TODAY } from "./shared";`);
w();
w(`/** 生成时刻的本体版本，用于排查「屏幕和 agent 对不上」。 */`);
w(`export const ONTOLOGY_SOURCE = ${q(`${readdirSync(dir).filter((f) => f.endsWith(".trig")).length} 个实例文件`)};`);
w();
w(`export const company: Company = { id: "CMP-tk", name: "北京词元云集人工智能科技有限公司", shortName: "词元云集" };`);
w();
w(`export const projects: Project[] = [`);
w(`  { id: "PRJ-tkos", companyId: "CMP-tk", name: "TKOS", intent: "让企业的判断成为可持续运行的对象，而不是活在人脑和聊天记录里。" },`);
w(`];`);
w();
w(`export const periods: Period[] = [`);
w(`  { id: "PRD-2026-08", projectId: "PRJ-tkos", label: "2026 年 8 月", startsOn: "2026-08-01", endsOn: "2026-08-31" },`);
w(`];`);
w();
w(`export const companyOutcomes: CompanyOutcome[] = [`);
for (const o of of("CompanyOutcome").concat(of("Outcome"))) {
  w(`  { id: ${q(link(`CO-${o.id.slice(0, 18)}`, o.id))}, periodId: "PRD-2026-08", statement: ${q(lit(o, "displayName"))}, dueOn: ${q(day(lit(o, "validUntil") ?? "2026-08-31"))} },`);
}
w(`];`);
w();
const ceo = personSrc.find((p) => lit(p, "displayName") === "刘明华") ?? personSrc[0];
w(`/** 这块屏幕是给谁看的。 */`);
w(`export const VIEWER_ID = ${q(personCode.get(ceo.id))};`);
w();
w(`export const people: Person[] = [`);
for (const p of personSrc) {
  const name = personName(p);
  const isCeo = p.id === ceo.id;
  w(`  { id: ${q(personCode.get(p.id))}, name: ${q(name)}, role: ${q(isCeo ? "ceo" : "dri")}, title: ${q(lit(p, "scopeDescription") ?? name)} },`);
}
/*
 * 校准表带进来的人。`title` 照实说他们从哪来 —— 本体里没有他们，而「屏幕上有、本体里
 * 没有」这件事查起来最费时间，写在对象自己身上最省事。
 */
for (const e of extra) {
  w(`  { id: ${q(e.code)}, name: ${q(e.name)}, role: "dri", title: ${q(`${e.name}（${CALIBRATED_AT} 在位人校准带进来，本体里还没有这个人）`)} },`);
}
w(`];`);
w();
w(`export const agents: Agent[] = people.map((p) => ({`);
w(`  id: p.id.replace("PSN-", "AGT-"), personId: p.id, kind: p.role, label: \`\${p.name} 的 Agent\`,`);
w(`}));`);
w();
w(`export const domains: Domain[] = [`);
for (const d of domainSrc) {
  const outcome = get(ref(d, "hasOutcome"));
  const dris = driIdsOf(domainCode(d), d.id);
  w(`  { id: ${q(link(`D-${domainCode(d)}`, d.id))}, projectId: "PRJ-tkos", code: ${q(`D-${domainCode(d)}`)}, name: ${q(domainName(d))}, outcome: ${q(lit(outcome ?? d, "displayName") ?? "")}, driIds: [${dris.map(q).join(", ")}], commitmentStatus: ${q(status(d) === "PreliminarilyConfirmed" ? "已确认" : "待确认")} },`);
}
w(`];`);
w();
w(`export const judgments: Judgment[] = [`);
for (const j of judgments) {
  w(`  {`);
  w(`    id: ${q(j.id)}, domainId: ${q(j.domainId)}, kind: ${q(j.kind)},`);
  w(`    statement: ${q(j.statement)},`);
  w(`    version: ${j.version}, standing: ${q(j.standing)},`);
  w(`    confirmedBy: ${q(j.confirmedBy)}, confirmedAt: ${q(j.confirmedAt)}, freshUntil: ${q(j.freshUntil)},`);
  if (j.basis.length) {
    const b = j.basis[0];
    const href = b.src ? docByOnto.get(b.src.id) : null;
    w(`    basis: [{ text: ${q(b.text)}, traces: [${b.src ? `{ kind: "int", source: ${q(b.src.name)}${href ? `, href: "/docs/${href}"` : ""} }` : ""}] }],`);
  } else {
    w(`    basis: [],`);
  }
  w(`    revisions: [], reopenTriggers: [], shakenBy: [], verifiedByTasks: 0,`);
  w(`  },`);
}
w(`];`);
w();
w(`/** 判断的变更流水。本体里还没有 —— 判断被改写会由 A10 写回时产生。 */`);
w(`export const judgmentChanges: JudgmentChange[] = [];`);
w();
w(`export const missionCards: MissionCard[] = [`);
for (const m of missions) {
  w(`  { id: ${q(m.id)}, domainId: ${q(m.domainId)}, code: ${q(m.id)}, name: ${q(m.name)}, driId: ${q(m.driId)}, status: ${q(m.status)}, milestone: "8 月" },`);
}
w(`];`);
w();
w(`/**`);
w(` * 战略议题。本体里全是 Candidate —— 已识别、待一号位确认是否值得投入认知资源。`);
w(` * 产品里就是 \`Candidate\`：还在提请台上等他按三个键，一件在办的都没有。`);
w(` *`);
w(` * **没有 domainId。** 本体的 StrategicIssue 上没有「属于哪个域」这层关系（ISS-009`);
w(` * 的原文自己写着「当前材料未给出具体 Domain」）。所以议题落在哪个域，是他在提请台`);
w(` * 上采信那一刻由卡片带过去的（\`disposeCard\`），不是这里编出来的。`);
w(` *`);
w(` * judgmentRefs 来自 ${LINKS_FILE}：本体没有「议题动摇哪条判断」这层关系，那一条`);
w(` * 由模型提案、待人确认。空数组是诚实的空 —— 有议题确实不动摇任何在版判断。`);
w(` *`);
w(` * **\`store.ts\` 上线第一天不装这一批。** 生成器照本体如实生成，那是它的职责；`);
w(` * 装不装是产品决定，写在 \`store.ts\` 的初始化里。第一天连潜在议题那一屏也是空的：`);
w(` * 每一件进来的事都得有一条真实的来路（雷达抓的 / DRI 押上名字递的 / 他自己提的），`);
w(` * 预置九条「已经摊在提请台上」等于替这三条来路各编了一次来历。`);
w(` */`);
w(`export const issues: Issue[] = [`);
for (const i of issues) {
  w(`  {`);
  w(`    id: ${q(i.id)}, title: ${q(i.title)},`);
  w(`    state: ${q(i.state)}, origin: "signal",`);
  w(`    judgmentRefs: [${i.judgmentRefs.map(q).join(", ")}],`);
  w(`    nextActionForUser: null,`);
  w(`    raisedAt: ${q(i.raisedAt)}, updatedAt: ${q(i.raisedAt)},`);
  w(`  },`);
}
w(`];`);
w();
/*
 * 潜在议题卡。九条议题在本体里都是 Candidate = 已识别、待一号位确认是否值得
 * 投入认知资源 —— 在产品里就是提请台上等他做三键处置的那张卡。
 *
 * 四段式里只有两段能从本体生成：
 *   · 发生了什么   ← 议题的 scopeDescription
 *   · 影响哪条判断 ← judgmentRefs（模型提案的关联，待确认）
 * 另外两段（为什么现在重要、建议如何处理）要靠 A3 预研跑完才有实质内容 ——
 * 本体里没有「为什么是现在」这种时效判断。所以这里先放诚实的占位，
 * 预研一跑完，signal-view 展示的就是预研的 take 和 soWhat。
 *
 * ## 这九条是谁递上来的：`ceo`，不是 `radar`
 *
 * 上一版全部标 `radar`。那是**伪造了一个可信度来源** —— 「雷达捕捉」的可信来自
 * 「有人在外面盯着变化」，而自动抓取这一整条还没接（首页那台雷达的注释里写着
 * 同一句话）。屏幕上写着雷达抓的、实际是从公司文档里蒸出来的，这种谎最难查。
 *
 * 也不能标 `dri`。本体里确实有两份材料的名字以「DRI」开头（「DRI 对 CEO Agent
 * 入口…的更新」「DRI 提供的 FE 真实议题与当前 Outcome」），但**都没写是哪个 DRI**。
 * 而 `dri` 那一档的可信度全在名字上（`cardSourceLabel`：「所以要写名字，不写团队」）
 * —— 没有名字就不该用它。
 *
 * 剩下的是 `ceo`：这些议题是从一号位自己的战略材料（路演稿、讨论稿、汇报版、
 * 飞书方案、周会复盘）里萃出来的，本来就是他自己在想的问题。
 */
const domainOfJudgment = new Map(judgments.map((j) => [j.id, j.domainId]));

w(`/**`);
w(` * 潜在议题卡，一条议题一张。来路是 \`ceo\`（这些议题萃自他自己的战略材料）——`);
w(` * 不是 \`radar\`：自动抓取还没接，写 radar 就是伪造「有人在外面盯着变化」这个可信度。`);
w(` *`);
w(` * 和 \`issues\` 一样，\`store.ts\` 上线第一天不装 —— 见上面那段注释。`);
w(` */`);
w(`export const cards: Card[] = [`);
for (const i of issues) {
  const j = i.judgmentRefs[0];
  const jm = judgments.find((x) => x.id === j);
  /*
   * 这张卡碰的是哪个域。本体没有议题→域这层关系，但有议题→判断（模型提案的那层）
   * 和判断→域（本体自带），两跳接得起来。一条判断都关联不上时发空数组 ——
   * ISS-009 就是这一档，它的原文自己写着「当前材料未给出具体 Domain」。
   */
  const doms = [...new Set(i.judgmentRefs.map((r) => domainOfJudgment.get(r)).filter(Boolean))];
  const src = get(ref(get(issueSrc.find((o) => refMap[i.id] === o.id)?.id ?? ""), "sourcedFrom"));
  w(`  {`);
  w(`    id: ${q(i.id.replace("ISS-", "CARD-"))}, issueId: ${q(i.id)},`);
  w(`    headline: ${q(i.title)},`);
  w(`    source: { kind: "ceo" },`);
  w(`    what: [{ text: ${q(i.scope)}, traces: [{ kind: "int", source: ${q(src ? lit(src, "displayName") : "企业本体")}${src && docByOnto.get(src.id) ? `, href: "/docs/${docByOnto.get(src.id)}"` : ""} }] }],`);
  w(`    why: "预研还在跑。跑完这里会写清楚为什么是现在。",`);
  w(`    strategyRef: { id: ${q(j ?? "")}, statement: ${q(jm ? jm.statement : "本体里暂未关联到在版判断")} },`);
  w(`    suggestion: { text: "等预研跑完再给处置建议。", traces: [{ kind: "agent", source: "您的 Agent · 预研中" }] },`);
  // 出处。本体的 SourceRecord 没有这个字段 —— 生成不出来就发空数组，
  // 屏幕上照实不显示「来源」那一行，而不是编一个出处出来。
  w(`    refs: [],`);
  w(`    domainIds: [${doms.map(q).join(", ")}],`);
  w(`    createdAt: ${q(i.raisedAt)},`);
  w(`  },`);
}
w(`];`);
w();
w(`/** 提请台那一天摊开哪几张。跟上面 \`issues\` / \`cards\` 一样，live 那一档不装 —— 见 \`issues\` 的注释。 */`);
w(`export const digests = [{ date: TODAY, cardIds: [${issues.map((i) => q(i.id.replace("ISS-", "CARD-"))).join(", ")}] }];`);
w();
w(`/** 议题的范围与背景。喂给 A3 预研，不进 Issue 类型（那是屏幕对象）。 */`);
w(`export const issueScopes: Record<string, string> = {`);
for (const i of issues) w(`  ${q(i.id)}: ${q(i.scope)},`);
w(`};`);
w();
w(`export const docs: Doc[] = [`);
for (const d of docs) {
  w(`  { id: ${q(d.id)}, title: ${q(d.title)}, folder: "本体来源", source: "clark", mirrorOf: ${q(d.ext)}, updatedAt: ${q(d.at)}, body: ${q(d.body)}, citedBy: [] },`);
}
w(`];`);
w();
w(`/**`);
w(` * 短码 → 本体 member id。`);
w(` *`);
w(` * 屏幕和正文里用短码（01-J2 / ISS-003），因为 CEO 读的是句子不是 slug；本体那边`);
w(` * 用的是 slug。这张表让 lib/ontology 的压缩器能把 [member:xxx] 换回短码，也让`);
w(` * Point 的溯源能落回本体对象。`);
w(` */`);
w(`export const ontologyRefs: Record<string, string> = {`);
for (const [k, v] of Object.entries(refMap)) w(`  ${q(k)}: ${q(v)},`);
w(`};`);
w();

process.stdout.write(out.join("\n"));
console.error(
  `[gen] 域 ${domainSrc.length} · 人 ${personSrc.length} · 判断 ${judgments.length} · 议题 ${issues.length} · 文档 ${docs.length} · Mission ${missions.length} · 映射 ${Object.keys(refMap).length} 条`
);
