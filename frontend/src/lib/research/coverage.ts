/**
 * 覆盖判定。**一条命题够不够，看它有几个独立且可引用的来源。**
 *
 * 两道门，缺一不可：
 *
 *  · **独立** —— 组由 `independence.assign` 折出来。转载折回原出处，同组只算一次。
 *  · **可引用** —— 这个来源背后有没有一个会为这句话负责的机构。
 *
 * 门槛是 ≥2 组。1 组不是「有证据」，是「有一个说法」。
 *
 * ## 这张表判的是「有没有人署名」，不是「来源档次高不高」
 *
 * 表里那些站点不是"质量差"，是**结构上没人担责**：知乎回答、微博、公众号转载、文库
 * 上传的 PPT —— 内容可能完全正确，但没有任何机构为它署名，于是它不能成为「两个独立
 * 来源互相印证」里的一个。判档次是 `sourceTier` 的事（A/B/C/D），这里判的是能不能计数。
 *
 * ## 混合门户故意不在表里
 *
 * 搜狐、网易、新浪既有自家采编也有个人号；阿里云、腾讯云开发者社区同理。按路径判会
 * 不稳（同一个站两条路径两种结论），所以一律放过，交给独立性折叠去处理转载。宁可多算
 * 一个可引用来源，也不要一条判定规则今天成立明天不成立。
 */

/** 内容由个人发布、平台不担责。 */
const SELF_PUBLISHED = [
  "zhihu.com",
  "reddit.com",
  "twitter.com",
  "x.com",
  "weibo.com",
  "xiaohongshu.com",
  "quora.com",
  "medium.com",
  "tieba.baidu.com",
  "douban.com",
  "v2ex.com",
  "linux.do",
  "stackexchange.com",
  "juejin.cn",
  "woshipm.com",
  "csdn.net",
  "jianshu.com",
  "cnblogs.com",
  "segmentfault.com",
  "toutiao.com",
  "t.cj.sina.com.cn",
  /*
   * 百家号与雪球。**和上面两条是同一种东西**：整个子域（或整个站）都是用户发布，平台
   * 不为内容署名。它们不属于下面那条「混合门户」豁免 —— 那一条豁免的是搜狐/网易/新浪
   * 主站（同站既有采编又有个人号，按路径判会不稳）；这两个按子域判是稳的，正是
   * `t.cj.sina.com.cn` 已经在用的判法。
   *
   * 补这两条是从一轮真运行里来的：69 条证据里 24 条百家号，全部被当成「可计入印证的
   * 来源」，于是一批只有自媒体转载撑着的断言通过了覆盖判定。补上之后可担责的组从 43
   * 掉到 31 —— 掉下去的那 12 组本来就不该算数。
   */
  "baijiahao.baidu.com",
  "xueqiu.com",
];

/** 文库：用户上传的 PPT 与报告扫描件，原始出处通常已丢失。 */
const DOC_FARMS = ["book118.com", "doc88.com", "docin.com", "wenku.baidu.com", "renrendoc.com", "shangxueba.com"];

/** 电商与批发页。上面的数字是报价，不是统计。 */
const COMMERCE = ["taobao.com", "51sole.com", "1688.com"];

/** 采集站。 */
const CONTENT_FARMS = ["shuiyinyun.com", "php.cn", "netkao.com"];

/** 低可信聚合与"研报"贩卖站。 */
const LOW_TRUST = ["233.com", "51test.net", "2265.com", "sgpjbg.com", "yjpoo.com"];

const UNATTRIBUTABLE = [...SELF_PUBLISHED, ...DOC_FARMS, ...COMMERCE, ...CONTENT_FARMS, ...LOW_TRUST];

/** 这个域名背后有没有会为内容署名的机构。子域一并算（`xxx.zhihu.com` 也是知乎）。 */
export function attributable(domain: string): boolean {
  const d = domain.toLowerCase();
  return !UNATTRIBUTABLE.some((bad) => d === bad || d.endsWith(`.${bad}`));
}

export type CoverageInput = { propositionId: string; group: string; sourceDomain: string };

export type Tally = {
  propositionId: string;
  /** 折叠后一共几组。 */
  groups: number;
  /** 其中背后有机构担责的几组 —— 达标只数这个。 */
  citableGroups: number;
  /** 只有个人发布来源，一组可引用的都没有。沿用实验台的字段名。 */
  ugcOnly: boolean;
};

/** 达标线。1 组只是「有一个说法」。 */
const MIN_GROUPS = 2;

/**
 * 按命题清点。
 *
 * `groups` 和 `citableGroups` **两个都留着**：「找到 4 组，可引用 0 组」和「找到 0 组」
 * 是完全不同的两件事 —— 前者要换检索方向（去找有人署名的源），后者要换问法。漏斗上
 * 只留一个数就分不出该做哪件。
 */
export function tally(items: CoverageInput[]): Tally[] {
  const byProp = new Map<string, { all: Set<string>; citable: Set<string> }>();
  for (const it of items) {
    let bucket = byProp.get(it.propositionId);
    if (!bucket) {
      bucket = { all: new Set(), citable: new Set() };
      byProp.set(it.propositionId, bucket);
    }
    bucket.all.add(it.group);
    if (attributable(it.sourceDomain)) bucket.citable.add(it.group);
  }
  return [...byProp.entries()].map(([propositionId, b]) => ({
    propositionId,
    groups: b.all.size,
    citableGroups: b.citable.size,
    ugcOnly: b.all.size > 0 && b.citable.size === 0,
  }));
}

/** 够了。 */
export function satisfied(t: Tally): boolean {
  return t.citableGroups >= MIN_GROUPS;
}

/**
 * 差在哪。一句人话，直接进漏斗和报告的「未能核实」一节。
 *
 * `searched` 为假时那句话**必须换一句**：这条压根没发出去过检索。2026-09-07（ISS-239
 * §3.B）补的 —— 在那之前两种情况共用「没找到任何来源」这一句，而它读起来像是查过了。
 * 报告照抄这句话之后，屏幕上「我们没查」和「外面没有」就再也分不开了，而后者是结论，
 * 前者是欠账。
 *
 * 默认 `true`：老调用点（`props.ts` 的 `judge`）拿到的命题都是真的发过检索的 —— 那一层
 * 是在一波取证之后算的。所以不传就是原来那句话，一个字不变。
 */
export function weakness(t: Tally, o: { searched?: boolean } = {}): string {
  if (satisfied(t)) return "";
  if (o.searched === false) return "这一轮没有为它发出过检索 —— 没搜过，不是外面没有";
  if (t.groups === 0) return "没找到任何来源";
  if (t.ugcOnly) return `找到 ${t.groups} 组来源，但全是个人发布、没有机构为其署名，一组都不能计入印证`;
  if (t.citableGroups === 1) return "只有一个独立来源，够不上互相印证";
  return `找到 ${t.groups} 组来源，其中可计入印证的 ${t.citableGroups} 组，不足 ${MIN_GROUPS} 组`;
}
