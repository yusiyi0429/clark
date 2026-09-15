/**
 * 独立性折叠。**回答的是「这几条到底是几个来源」，不是「这几条来自几个网站」。**
 *
 * 中文网络的转载密度下，同一个工信部数字会以十几个「来源」入库。按域名数数，那叫
 * 交叉验证；按出处数数，那是**一个**来源被抄了十二遍。互相印证只对独立源计数
 * （ST-5b），所以这一层必须在覆盖判定之前跑完。
 *
 * ## 三级判定，先到先得
 *
 * 1. `src:` **出处归因** —— 正文里自己写了「据新华社」「来源：国家统计局」。这是最硬的
 *    信号：转载稿通常诚实地留着原出处，而那个出处才是该被计一次的东西。
 * 2. `sim:` **正文近重复** —— 没写出处，但正文和已收的某一条几乎一样。simhash 折叠。
 * 3. `dom:` **域名兜底** —— 既没署名也不像抄的，只好按站点算一个。
 *
 * 顺序不能换。域名放最后是因为它最容易把「两个站各自采访」误判成两个来源、也最容易
 * 把「同一家的两个子域」算成两个 —— 它只是兜底，不是判据。
 */

import { createHash } from "node:crypto";

/**
 * 只认这几种引出方式。宽到「某机构表示」那一档就会把正文里随便一个人名当出处。
 *
 * ## 光杆的「据」要卡两头，另外三种一个字都不动
 *
 * 「据」是个字，不只是个词：**数**据、票**据**、根**据**、单**据**、证**据**、依**据**
 * 里都有它。中文产业稿里「数据显示，」几乎每篇都有一句，于是这条正则会把一批互不相干
 * 的稿子折成同一个 `src:显示` 组 —— 真运行里量到过一次，贵州省大数据局、新华网、百家号
 * 三条稿子被并成一个「署名出处」。
 *
 * **这种错的危害是反的**：假合并让独立来源被**少算**，覆盖判定因此比设计的更严，
 * 一条本该达标的命题被判成「只有一个独立来源」。而屏幕上只写「够不上互相印证」，
 * 没有任何一处会说这是折叠折错了 —— 比多算更难发现。
 *
 * 所以前面加一道否定回顾（不能紧跟在那六个字后面），后面再挡掉「据实/据此/据悉/据称」
 * 这几个副词用法（它们后面跟的不是机构名）。
 *
 * **约束只加在光杆的「据」上。** `来源[:：]` / `转自` / `源自` 前面常常带着「图片」
 * 「信息」「数据」这类词（`图片来源：火山引擎`），给它们也加同一道边界会把最硬的署名
 * 信号一起误伤 —— 那是修这个 bug 时第一版真踩到的坑。
 *
 * 否定回顾（`(?<!…)`）是 ES2018 的**运行时**特性，不是 TypeScript 会降级的语法，所以
 * 这个仓的 `target: ES2017` 不影响它（`tsc --noEmit` 也不会拦）—— 和下面 simhash 那段
 * 避开 `bigint` 是两件事：那边躲的是编译不过，这边只要跑的地方支持就行，Node 与当前
 * 各家浏览器都支持。
 */
const ATTRIB =
  /(?:(?<![数票根收单证依])据(?![实此悉称])|转自|源自|来源[:：]\s*)([一-鿿 A-Za-z]{2,14})(?=[，。,、\s）)】]|$)/;

/**
 * 「据新华社报道」里的「报道」不是机构名的一部分，得剥掉，不然同一家会因为
 * 「据新华社」「据新华社报道」分成两组。
 *
 * **「社」不剥** —— 剥了「新华社」就成「新华」，而「新华社」和「新华网」是两家。
 */
const SUFFIX = ["报道", "消息", "讯", "电"];

function attribution(text: string): string {
  const m = ATTRIB.exec(text.slice(0, 400));
  if (!m) return "";
  let org = m[1].trim();
  for (const s of SUFFIX) {
    if (org.length > s.length + 1 && org.endsWith(s)) org = org.slice(0, -s.length);
  }
  return org.length >= 2 ? org : "";
}

/* -------------------------------------------------------------------------- */
/* simhash                                                                     */
/* -------------------------------------------------------------------------- */

/** 字符二元组。中文没有空格，按词切要分词器，按二元组切够用且确定性。 */
function bigrams(text: string): string[] {
  const t = text.replace(/\s+/g, "");
  const out: string[] = [];
  for (let i = 0; i + 1 < t.length; i += 1) out.push(t.slice(i, i + 2));
  return out;
}

/**
 * 64 位 simhash。md5 取前 8 字节当特征哈希 —— 这里要的是散得开，不是抗碰撞。
 *
 * 指纹用**一个字节一位**的 `Uint8Array` 装，不用 `bigint`：这个仓的 `target` 是 ES2017，
 * `1n` 那种字面量编译不过。64 个字节换来一段不用位运算的汉明距离，页数是个位数，
 * 这点开销不值得为它去动全局编译目标。
 */
export function simhash64(text: string): Uint8Array {
  const bits = new Array<number>(64).fill(0);
  for (const g of bigrams(text)) {
    const h = createHash("md5").update(g).digest();
    for (let b = 0; b < 64; b += 1) {
      // 第 b 位落在第 b>>3 个字节的第 b&7 位（从高位数起）。
      const on = (h[b >> 3] >> (7 - (b & 7))) & 1;
      bits[b] += on ? 1 : -1;
    }
  }
  const sig = new Uint8Array(64);
  for (let b = 0; b < 64; b += 1) sig[b] = bits[b] > 0 ? 1 : 0;
  return sig;
}

function hamming(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < 64; i += 1) if (a[i] !== b[i]) n += 1;
  return n;
}

/**
 * 判「同一篇」的汉明距离阈值。
 *
 * 6 是从实验台带过来的经验值：改标题、加编者按、删两段的转载还在 6 以内；两篇各自
 * 写的同题报道通常远超 6。放宽会把独立报道折成一组（少算了真交叉验证），收紧会让
 * 转载各自成组（把循环引用当交叉验证）。两种错都有代价，后一种更危险。
 */
const NEAR = 6;

/* -------------------------------------------------------------------------- */

export type Attributable = { url: string; sourceDomain: string; text: string };

/** 每条属于哪一组，以及凭什么。`why` 要能上屏 —— 「这两条为什么只算一个来源」得答得出。 */
export type Grouped = { url: string; group: string; why: string };

/**
 * 给一批页面分组。同 `group` 的在覆盖判定里**只算一个来源**。
 *
 * 传入顺序会影响 `sim:` 组的代表页是谁，但不影响谁和谁同组。
 */
export function assign(items: Attributable[]): Grouped[] {
  const out: Grouped[] = [];
  const seen: { hash: Uint8Array; group: string }[] = [];
  for (const it of items) {
    const org = attribution(it.text);
    if (org) {
      out.push({ url: it.url, group: `src:${org}`, why: `正文署名出处「${org}」` });
      continue;
    }
    const h = simhash64(it.text);
    const near = seen.find((s) => hamming(s.hash, h) <= NEAR);
    if (near) {
      out.push({ url: it.url, group: near.group, why: "正文与已收的一条近似重复，按转载折叠" });
      continue;
    }
    const group = `dom:${it.sourceDomain}`;
    seen.push({ hash: h, group });
    out.push({ url: it.url, group, why: `无署名出处，按站点 ${it.sourceDomain} 计一个来源` });
  }
  return out;
}
