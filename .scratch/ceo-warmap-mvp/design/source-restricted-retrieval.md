# CEO WarMap · 检索与预研的信源限定

Type: design
Status: proposal（未实现，不含任何源码改动）
Date: 2026-09-18
Scope: Radar 采集、Issue 预研、全局对话三条链路的「只在指定 7 家媒体内检索」能力

---

## 0. 先给结论

**用户要求的机制（在这 7 家媒体内检索）用当前唯一的检索 Provider 无法实现，而且用户以为已经实现的东西并没有生效。**

三条实测结论：

1. **博查不支持域名限定。** `site:` 写在 query 里被完全忽略（一个不存在的域名返回了 19 条无关结果）；作为 body 参数传 `site` / `includeDomains` 也被忽略；`include` / `exclude` 参数被服务端 400 拒绝（`code=500, "Missing request body"`）。对照组证明博查**确实解析** body——`count` 与 `freshness` 都精确生效。所以这不是传输问题，是这个接口没有这个能力。
2. **`WebSearchInput.domains` 是一个静默失效的功能。** `apps/api/src/webSearch.ts:65-67` 会把 `domains` 拼成 `query site:a OR site:b` 发出，但那个串对博查毫无作用。Radar 链路（`apps/api/src/radar.ts:156`、`radarSources.ts:24`）已经把这个参数一路传到底，结果和全网检索逐条一致。配了 domains 的 site source 现在会给出「看起来被限定了」的错觉。这是本次调研顺带发现的既有缺陷，与新增需求独立。
3. **博查的索引里没有这 7 家。** 10 个查询、`count=50`、共 **299 条**结果，命中白名单 8 个域 **0 条（0.0%）**。把 `reuters.com` / `Bloomberg` / `WSJ 华尔街日报` 直接写进 query 也一条都没有。所以「白名单 + 事后按域名过滤」这条路召回恒为 0，不是「可能偏低」，是必然为空。

**可行的路径只剩「发布方级来源」：直接取这 7 家自己的 feed，在本地做关键词相关性过滤。** 实测 7 家里 5 家有新鲜可用的 RSS（BBC / Bloomberg / FT / CNBC / Economist），Reuters 有可用 news-sitemap（无摘要），WSJ 的 RSS 是死的（内容停在 2025-01-27，已停滞 20 个月）。

这个结论和项目既有约束是同一条原则的两面——`docs/technical/ceo-warmap/03-Radar与Issue预研.md:20` 写「公众号必须走真实账号渠道，不能用站点搜索冒充」。7 家媒体同样是发布方级来源，同样不能用站点搜索冒充。**本次方案不与该约束冲突，而是把该约束从「公众号」泛化到「发布方」。**

推荐 **方案 A（发布方级来源 `outlets`）**；方案 B（引入支持域名限定的检索 Provider）是唯一保留「关键词检索」语义的路，但要人决定新增境外依赖与凭据；方案 C（把媒体名写进 query 提示词）是零成本但是冒充，被既有约束否决。

---

## 1. 实测证据

环境：2026-09-18，`https://api.bochaai.com/v1/web-search`，凭据来自 `infra/.env` 的 `BOCHA_API_KEY`（未输出、未入库、未写进本文件）。全程无重试。

### 1.1 `site:` 在 query 里被忽略

固定 query `Nvidia earnings`，`count=20`，`freshness=oneMonth`。

| # | 实际发出的 query | HTTP/code | 返回条数 | 命中白名单 |
|---|---|---|---|---|
| A | `Nvidia earnings`（无限定，对照） | 200/200 | 16 | — |
| B | `Nvidia earnings site:reuters.com` | 200/200 | 17 | **0** |
| C | `Nvidia earnings site:reuters.com OR site:bbc.com` | 200/200 | 16 | **0** |
| D | `Nvidia earnings (site:reuters.com OR site:bbc.com)` | 200/200 | 16 | **0** |
| E | `Nvidia earnings site:no-such-domain-xyz-99999.com` | 200/200 | **19** | **0** |

E 是关键判据：一个**保证不可能存在**的域名，返回条数（19）比不加限定（16）还多，主机分布全是 `seekingalpha.com`、`news.163.com`、`news.qq.com`、`topnews.cn` 之流。如果 `site:` 有任何过滤效果，E 必须是 0 条。结论：`site:` 被当作无意义 token 丢弃，既不缩小也不扩大语料。

A 的主机分布（用于对照，证明 A 与 B/C/D 的结果池是同一个）：

```
news.futunn.com×1, techcentral.co.za×2, citynewsservice.cn×1, topnews.cn×1,
theverge.com×1, urdupoint.com×1, zhiding.cn×1, finance.sina.com.cn×1, cctime.com×1,
businesskorea.co.kr×1, english.news.cn×1, m.12365auto.com×1, seekingalpha.com×1,
d1ev.com×1, m.163.com×1
```

### 1.2 body 参数：不认识的被拒或被吞，认识的精确生效

同一 query，`count=20`，`freshness=oneMonth`，只加一个额外参数。

| 额外参数 | HTTP/code | 返回条数 | 主机分布 vs 对照 | 判定 |
|---|---|---|---|---|
| （无，对照） | 200/200 | 16 | — | — |
| `site: ["reuters.com"]` | 200/200 | 16 | **与对照完全相同** | 被忽略 |
| `includeDomains: ["reuters.com"]` | 200/200 | 16 | **与对照完全相同** | 被忽略 |
| `include: ["reuters.com"]` | **400/500** | 0 | — | 参数被拒（`Missing request body`） |
| `exclude: ["theverge.com"]` | **400/500** | 0 | — | 参数被拒（`Missing request body`） |

对照实验（证明博查确实解析 body，因此上面不是「body 没送达」）：

| 参数 | 返回条数 | `publishedAt` 范围 |
|---|---|---|
| `count=5` | 5 | 2026-08-24 .. 2026-08-28 |
| `count=50` | 36 | 2026-08-24 .. 2026-08-31 |
| `freshness=oneDay` | 18 | 2026-09-17 .. 2026-09-18 |
| `freshness=oneYear` | 13 | 2025-11-20 .. 2026-08-12 |
| `freshness=noLimit` | 17 | **2017-11-09** .. 2026-05-22 |

`count` 与 `freshness` 都精确生效。所以接口读 body，只是它**没有**域名限定这个参数。

`/v1/ai-search` 端点同样存在，同样忽略 `site:`，同样以 400 拒绝 `include`。没有第二条路。

**由此：`apps/api/src/webSearch.ts` 的 domains 拼接是死代码路径，`WebSearchInput.domains` / `RadarSiteSource.domains` 是永远不生效的字段。**

### 1.3 博查索引对这 7 家的覆盖：299 条里 0 条

`count=50`，`freshness=oneYear`。白名单判定：`host === d` 或 `host.endsWith("." + d)`，`d ∈ {bbc.com, bbc.co.uk, wsj.com, bloomberg.com, reuters.com, ft.com, cnbc.com, economist.com}`。

| query | 返回条数 | 白名单命中 | 头部主机 |
|---|---|---|---|
| `英伟达 财报` | 33 | 0 | news.qq.com×2, 163.com×2, tech.ifeng.com×2, finance.sina.com.cn×2, 36kr.com×2 |
| `Nvidia earnings` | 32 | 0 | ecns.cn×2, interfax.ru×2, fortune.com×2, eetrend.com×2, longportapp.cn×2 |
| `美联储 降息` | 35 | 0 | news.qq.com×2, 163.com×2, m.gmw.cn×2, toutiao.com×2, cj.sina.com.cn×2 |
| `OpenAI 融资` | 27 | 0 | k.sina.com.cn×2, m.163.com×2, news.qq.com×2, news.china.com×2 |
| `关税 政策` | 43 | 0 | news.163.com×2, sohu.com×2, toutiao.com×2, news.qq.com×2 |
| `reuters.com Nvidia` | 14 | 0 | news.163.com, developer.nvidia.com, cnblogs.com, arxiv.org, seekingalpha.com |
| `Reuters exclusive Nvidia` | 32 | 0 | news.163.com, notebookcheck.net, digitimes.com, m.zol.com.cn |
| `Bloomberg Nvidia` | 30 | 0 | longportapp.cn, jianshu.com, news.futunn.com, cryptonews.net, seekingalpha.com |
| `BBC 英国经济` | 24 | 0 | qqthj.com, topnews.cn, 100ppi.com, d.qianzhan.com |
| `WSJ 华尔街日报 报道` | 29 | 0 | news.163.com, qqthj.com, touch.shio.gov.cn, yoojia.com, daily.co.jp |

**合计 299 条，命中 0 条。**

这决定了方案空间：博查返回的语料里没有这 7 家（连 `reuters.com` 当关键词硬写进去都捞不到），所以「先全网检索、再按白名单域名过滤」的召回上限是 **0**，与过滤代码写得多好无关。

### 1.4 发布方自己的渠道：实测可用性

| 来源 | 渠道 URL | HTTP | 条数 | 最新条目 | 有摘要 | 判定 |
|---|---|---|---|---|---|---|
| BBC news | `feeds.bbci.co.uk/news/rss.xml` | 200 | 35 | 2026-09-18T04:58Z | 有 | 可用 |
| BBC business | `feeds.bbci.co.uk/news/business/rss.xml` | 200 | 53 | 2026-09-18T06:52Z | 有 | 可用 |
| BBC world | `feeds.bbci.co.uk/news/world/rss.xml` | 200 | 41 | 2026-09-17T12:27Z | 有 | 可用 |
| **WSJ world** | `feeds.a.dj.com/rss/RSSWorldNews.xml` | 200 | 20 | **2025-01-27T14:24-05:00** | 有 | **已死（停滞 20 个月）** |
| **WSJ markets** | `feeds.a.dj.com/rss/RSSMarketsMain.xml` | 200 | 20 | **2025-01-27T14:27-05:00** | 有 | **已死** |
| **WSJ tech** | `feeds.a.dj.com/rss/RSSWSJD.xml` | 200 | 20 | **2025-01-27T13:18-05:00** | 有 | **已死** |
| Bloomberg markets | `feeds.bloomberg.com/markets/news.rss` | 200 | 20 | 2026-09-18T03:03Z | 有 | 可用 |
| Bloomberg politics | `feeds.bloomberg.com/politics/news.rss` | 200 | 20 | 2026-09-17T17:28Z | 有 | 可用 |
| Reuters（旧) | `feeds.reuters.com/reuters/topNews` | DNS 失败 | — | — | — | 不存在 |
| Reuters agency | `reutersagency.com/feed/` | 404 | — | — | — | 不存在 |
| Reuters Arc RSS | `reuters.com/arc/outboundfeeds/rss/?outputType=xml` | 404 | — | — | — | 不存在 |
| **Reuters sitemap** | `reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml` | **200** | **50** | **2026-09-18T07:06Z** | **无** | 可用（缺摘要） |
| FT home | `ft.com/rss/home` | 200 | 9 | 2026-09-18T03:26Z | 有 | 可用 |
| FT world | `ft.com/world?format=rss` | 200 | 25 | 2026-09-18T05:30Z | 有 | 可用 |
| CNBC top | `cnbc.com/id/100003114/device/rss/rss.html` | 200 | 30 | 2026-09-18T06:23Z | 有 | 可用 |
| CNBC world | `cnbc.com/id/100727362/device/rss/rss.html` | 200 | 30 | 2026-09-18T06:23Z | 有 | 可用 |
| Economist latest | `economist.com/latest/rss.xml` | 200 | 300 | 2026-09-18T06:56Z | 有 | 可用 |
| Economist finance | `economist.com/finance-and-economics/rss.xml` | 200 | 300 | 2026-09-17T17:09Z | 有 | 可用 |

Reuters 的 news-sitemap 条目结构（`<url>` × 50）：

```xml
<loc>https://www.reuters.com/business/energy/aramco-boost-exports-...-2026-09-18/</loc>
<lastmod>2026-09-18T07:06:07.592Z</lastmod>
<news:publication_date>2026-09-18T07:06:07.592Z</news:publication_date>
<news:title><![CDATA[Aramco to boost exports from Strait of Hormuz to 60 million bbl ...]]></news:title>
<news:keywords><![CDATA[VGUID:...<news:stock_tickers>2222.SE
```

有 URL、有标题、有发布时间、有股票代码，**没有摘要**。这一点直接冲击 Radar：`RadarSourceItem.excerpt` 是 `minLength: 1` 必填，且 assess 要求决策引文必须是 excerpt 的连续子串（`03-Radar与Issue预研.md` §6）。所以 Reuters 走 sitemap 时，excerpt 只能是标题本身，能承载的引文也就只有标题。

### 1.5 域名边界（决定白名单里该写几个域）

| 域名 | 探测结果 | 归属判定 |
|---|---|---|
| `bbc.com` | 301 → `www.bbc.com` | BBC 主体 |
| `bbc.co.uk` | 301 → `www.bbc.co.uk` | BBC 主体（英国站，与 .com 同源不同站） |
| `feeds.bbci.co.uk` | 根路径 404 | **feed 主机**，不是文章主机 |
| `wsj.com` | 301 → `www.wsj.com` | WSJ 主体 |
| `feeds.a.dj.com` | 根路径 403 | **feed 主机**（Dow Jones），文章链接指向 `wsj.com` / `online.wsj.com` |
| `bloomberg.com` | 301 → `www.bloomberg.com` | Bloomberg 主体 |
| `feeds.bloomberg.com` | 302 → `www.bloomberg.com` | **feed 主机** |
| `bloomberg.co.jp` | 301 → `www.bloomberg.co.jp` | 独立日文版（独立编辑部） |
| `bloomberglaw.com` | 301 → `www.bloomberglaw.com` | 独立产品线（法律），非本任务所指 Bloomberg |
| `reuters.com` | 301 → `www.reuters.com` | Reuters 主体 |
| `jp.reuters.com` | 301 → `www.reuters.com/jp/` | 同站日文版 |
| `ft.com` | 301 → `www.ft.com` | FT 主体 |
| `ftalphaville.ft.com` | 301 → `www.ft.com/alphaville` | **子域，后缀匹配自动覆盖** |
| `cnbc.com` | 301 → `www.cnbc.com` | CNBC 主体 |
| `cnbctv18.com` | 301 → `www.cnbctv18.com` | **无关被许可方**（印度 CNBC-TV18），不应纳入 |
| `economist.com` | 301 → `www.economist.com` | Economist 主体 |
| `espresso.economist.com` | **530** | 已下线 |

feed 里的文章链接主机（实测）：

```
WSJ        www.wsj.com, online.wsj.com
Bloomberg  bloomberg.com, www.bloomberg.com
BBC        www.bbc.co.uk
FT         www.ft.com
CNBC       www.cnbc.com
Economist  www.economist.com
```

---

## 2. 信源白名单建模

### 2.1 建议清单

匹配规则统一为 **`host === d || host.endsWith("." + d)`**，这样 `ftalphaville.ft.com`、`online.wsj.com` 自动覆盖，不需要逐个列举子域。

| outletId | 建议域名集合 | 覆盖依据 |
|---|---|---|
| `bbc` | `bbc.com`, `bbc.co.uk` | 两个 301 各自指向自己，都是主体站；feed 链接落在 `www.bbc.co.uk` |
| `wsj` | `wsj.com` | `online.wsj.com` 被后缀规则覆盖 |
| `bloomberg` | `bloomberg.com` | `co.jp` 是独立日文版、`bloomberglaw.com` 是独立产品线，都不是 CEO 语义下的「彭博」 |
| `reuters` | `reuters.com` | `jp.reuters.com` 被后缀规则覆盖 |
| `ft` | `ft.com` | `ftalphaville.ft.com` 被后缀规则覆盖；`ftchinese.com` 是独立中文品牌，不纳入 |
| `cnbc` | `cnbc.com` | `cnbctv18.com` 是被许可方，排除 |
| `economist` | `economist.com` | `espresso.economist.com` 已 530，不纳入 |

**7 家 → 8 个域名**（BBC 占两个）。这个 8 个域的集合是纯数据，不需要表达能力，用前缀匹配即可，不需要正则、不需要 PSL 库、不新增依赖。

排除项必须写进注释，否则后人会把 `cnbctv18.com` / `bloomberglaw.com` 当成漏配补进去——它们是**别的编辑部**，补进去会直接把 CEO 的信源限定变成「看起来更大」的假象，和本次要修的 site: 缺陷是同一类错误。

### 2.2 域名集合与「渠道」是两件事

关键区分：**白名单域名集合用于校验取回条目的归属；渠道（feed/sitemap）用 于取回条目。** 两者不能混为一谈——`feeds.bbci.co.uk`、`feeds.a.dj.com`、`feeds.bloomberg.com` 是渠道主机，**绝不能**进白名单域名集合。如果把它们写进去，就等于对外声明「bbc 的文章发布在 feeds.bbci.co.uk」，后面任何人按白名单校验归属都会得到错的答案。

因此建模必须是两条并列字段：

```
outletId → { name, articleDomains: string[], channels: { kind: "rss" | "news-sitemap", url: string }[] }
```

articleDomains 做归属校验，channels 做取回。二者永不互换。

### 2.3 白名单放哪

建议放在 `packages/contracts/src/` 作为 pure data（一个新文件或挂在 radar.ts 里），因为 Web 也要展示来源名。**不放 DB**：这是 7 家固定的媒体身份，不是运营配置，写进 DB 就要处理「改版后旧值」的迁移问题，而它一辈子不会变。放 contracts 的好处是 API 与 Web 共用同一个 outletId → 展示名映射，避免 Web 里再手写一份「彭博 / Bloomberg」。

---

## 3. 接入点设计

### 3.1 两种机制的适用判据

| | 配置驱动（DB `radar_config.sources`） | Agent 工具参数（`web_search` 的 `domains`） |
|---|---|---|
| 谁决定 | CEO 在配置里设一次，所有扫描共用 | 模型逐次提问时决定 |
| 生命周期 | 持久、跨进程、跨重启 | 单次调用 |
| 可审计 | 有版本号、有 `updated_at`、单元可测 | 只留在 conversation 里 |
| 适合的语义 | **「这家媒体的内容我要长期持续监测」** | **「这一问只在这些来源里找」** |
| 现状 | 已有 `sites` / `wechatAccounts` 两类，`sources` 无 Action（只能直接改 DB） | schema 已有 `domains`，但实测无效 |

判据：**要「持续监测」的用配置；要「这一次」的用工具参数。** 7 家媒体属于前者——用户说的是「新增只在这 7 家媒体内检索的能力」，是能力/常设来源，不是一次性提问。所以 Radar 走配置驱动。

但两条链路都必须存在，因为它们服务的动作不同：

### 3.2 Radar：配置驱动（推荐）

新增第三类来源 `outlets`，与 `sites`、`wechatAccounts` 并列。

- 采集循环加一层：`for (outlet of sources.outlets.filter(enabled))` → 抓该 outlet 的 channels → 规范化 → 时间窗过滤（复用现有 `lookback_hours`）→ 关键词相关性过滤 → 生成 `TRadarSourceItem`。
- **不按 anchor × outlet 相乘。** feed 是整份最新列表，与 anchor 无关；抓一次 7 家（约 9 个 HTTP），再在本地对每个 anchor 做相关性判定。这是它相对「7 个 site source」的关键结构差异，见 §3.5。
- 与 `sites` 的 `domains` 字段**不共用**：`sites` 是「全网关键词来源」，`outlets` 是「发布方级来源」。这正是既有 spec 对公众号划的那条线。

### 3.3 预研 Agent：恢复 spec 里本就有的 web_search，但受限

`docs/technical/ceo-warmap/03-Radar与Issue预研.md` §10 明写预研输入包含 **Web Search Tool**，而 `apps/api/src/researchAgent.ts` 现在完全没有（代码里那条 ponytail 注释标为刻意省略）。所以给预研加检索不是新增范围，是**补齐 spec 与代码的既有偏差**；但补的时候必须补成正的——如果照抄全局对话的 `web_search`，模型会拿到一个 `domains` 参数然后发现它不起作用。

预研的使用语义是「这一次预研要外部佐证」，属于工具参数场景，所以：
- 给预研的 `web_search` 暴露**受限**形式：要么不接受 `domains`（避免教模型用一个失效参数），要么 `domains` 在 adapter 里真正生效。
- 预研同时需要「这 7 家怎么报道」这种发布方视角 → 需要一个按 outlet 取回的能力，而不是一个无约束的全网搜索。

### 3.4 全局对话 Agent：schema 已有字段，但必须诚实

`apps/api/src/piConversationRuntime.ts` 的 `web_search` 工具 schema 含 `domains`，但 system prompt 从未告诉模型可以用（第 69、77、79 行只讲「检索公开来源」）。当前状态是：**字段存在、模型不知道、且即使知道了也不起作用**。三重失效。

两种处理，必须在方案里选一个：
- **修正**：adapter 里对结果做域名过滤，并把「过滤后为 0」写进 `warnings`；prompt 里明确说明 `domains` 用于限定来源、结果为 0 时如实报告。这让字段变成真的。
- **删除**：从 `WebSearchInput` 移除 `domains`，prompt 不提。这消除了「看起来能用」的陷阱，但下次真需要域名限定时要重新加。

不建议保留现状（字段在、无效、不文档化）——这是本次调研发现的既有缺陷，留着它下次还会有人踩。

### 3.5 为什么不能把 7 家建成 7 个 `sites`

具体代价可以算出来。Radar 循环是 `for site of enabled sites → for anchor of anchors → web.search(...)`。

- 今天：1 个 site（`site-web-all`）× 最多 20 个 anchor = 最多 **20 次**博查调用/扫描。
- 建成 7 个 site：7 × 20 = 最多 **140 次**/扫描，**7 倍配额**。
- 而这 7 倍调用返回的是**同一批全网结果**（`domains` 实测无效），再按 7 个白名单过滤后全部丢弃，命中 0（§1.3）。
- 附带风险：`scanTimeoutMs = 180_000`（`apps/api/src/radar.ts:92`），140 次串行外部调用有超时风险，失败会被记成 `Web source <name> failed` 的 warning 而非错误，形成「看起来在扫、其实什么都没拿到」的静默失败。

净效果：7 倍费用、7 倍超时风险、0 条新召回。这条路径必须显式否决，且否决理由要写进代码注释。

---

## 4. 候选方案

### 方案 A：发布方级来源 `outlets`（推荐）

**内容**：把 7 家建模为 `RadarSources.outlets`，由新的 outlet feed adapter 直取发布方渠道（RSS / news-sitemap），本地做关键词相关性过滤；同时把 7 家的白名单做成 contracts 里的 pure data。同一 adapter 以受限工具的形式供给预研与全局对话两个 Agent。

**改动范围**

| 文件 | 改动 |
|---|---|
| `packages/contracts/src/radar.ts` | 新增 `RadarOutletSource`；`RadarSources` 加 `outlets`；`RadarSourceRef` / `RadarSourceItem.sourceType` union 加 `"outlet"` |
| `packages/contracts/` 新文件（或 radar.ts 内） | `OUTLETS` 常量：7 个 outletId → `{name, articleDomains, channels}` |
| `apps/api/src/outletSources.ts`（新） | `createOutletFeedAdapter`：抓 channels、解析 RSS / news-sitemap、按 articleDomains 校验归属、按 lookback 过滤、按关键词过滤、输出 `TRadarSourceItem` |
| `apps/api/src/radar.ts` | 采集循环加 `outlets` 一支；`RadarWebAdapter` 之外新增 `RadarOutletAdapter` |
| `apps/api/src/radarSources.ts` 或装配处 | 装配新 adapter |
| `apps/api/src/researchAgent.ts` | 注入受限检索能力（阶段 2） |
| `apps/api/src/piConversationRuntime.ts` | prompt 说明 `domains` 语义（或按 §3.4 移除字段） |
| `apps/web/src/cards/SignalCard.tsx` | 来源标签三分支（现有是 `wechat-account` ? 微信公众号 : Web 的一个三元式） |
| `apps/web/src/lib/api/*` | `pnpm --filter @warmap/web gen:client` 重新生成（不得手改） |
| **migration** | **无**，前提是 `outlets` 声明为 `Type.Optional`。若声明为必填，线上 `{"sites":[...],"wechatAccounts":[]}` 会让 `Value.Check(RadarSources, config.sources)` 失败 → `throw new Error("RadarConfig is invalid")` → **整个 Radar 停摆**。这是本方案唯一的硬性契约陷阱 |

**对现有行为的影响**：`sites` / `wechatAccounts` 两条路径逐字节不变；`outlets` 默认缺省即关闭，所以上线后行为与今天完全一致，直到有人在 `sources` 里加 `outlets`。

**副作用与失败模式**

- RSS/sitemap 是「最新 N 条」快照，不是全档检索。168 小时 lookback 内若一家发帖超过 feed 容量（Economist 300 条足够，FT home 只有 9 条），会被截断且**无法察觉**。缓解：优先选条目多的 section feed（FT world 25 条），并把每条 feed 的实际条数写进 `lastRun.warnings`。
- WSJ 三路 RSS 都停在 2025-01-27（实测）。**WSJ 在这一方案下事实上不可用**，必须让它在 UI 上显示为「渠道无新增」而不是「本周无新闻」——两者含义完全不同。
- Reuters 无摘要（sitemap 只有 title）。`excerpt` 只能填标题 → assess 的「引文必须是 excerpt 连续子串」只能引标题 → 决策引文质量下降。
- 关键词匹配是**跨语言**问题：Radar 的 `anchor.query` 是中文（`英伟达 财报` 之类），而 feed 标题是英文。中文字串匹配英文标题命中必然为 0。且实测 `apps/api/src/radar.ts` **没有实现 spec §5 的 LIGHT_MODEL 查询规划步骤**（`anchor.query` 被直接使用，全仓无 planner），所以现在没有任何地方能产出英文查询。这是方案 A 最大的真实缺口，见 §6 分歧点 5。
- 7 个渠道都会在境外；`infra/staging` 部署环境的可达性未验证（本次探测从开发机发起）。若不可达，表现为 fetch 抛错 → 现有「部分 Source 失败保存 warning」规则覆盖，但会**静默地永远只报 warning**。需要在 providerStatus 里显式暴露 outlet 渠道健康度。
- 免费无配额，但有被单方面改版/关闭的风险（WSJ 已经是活生生的例子）。所以 adapter 必须把「渠道 200 但最新条目时间过旧」判定为一个独立状态，而不是成功。

**验证方式**

- 单元：用本次实测抓到的一段真实 RSS 与一段真实 news-sitemap 作为 fixture，断言解析出的 title / url / publishedAt / excerpt 正确，且 `online.wsj.com`、`ftalphaville.ft.com` 被 articleDomains 正确判定归属、`cnbctv18.com` 被正确拒绝。
- 契约：`Value.Check(RadarSources, {sites:[...], wechatAccounts:[]})`（无 `outlets`）必须为 `true` —— 这条断言直接防住上面那个「Radar 停摆」的失败模式。
- 端到端：在 staging 手动触发一次扫描，断言 `lastRun` 里 outlets 的 attempted/succeeded 与每家实际条目数，且 WSJ 被标为陈旧而非成功。
- 反例：构造一个所有 outlet 都匹配不到的 anchor，断言产出 warning 且**不回落**到全网检索。

---

### 方案 B：引入支持域名限定的检索 Provider

**内容**：新增一个真正支持域名限定/白名单的检索 provider（Google Programmable Search 的 `siteSearch`、Bing Web Search 的 `site:`/`siteSearch`、Brave Search 或 Tavily 的 `include_domains` 之类），限定到这 8 个域；博查退为兜底或只服务中文全网来源。

**改动范围**

| 文件 | 改动 |
|---|---|
| `packages/contracts/src/agentRuntime.ts` | `WebSearchInput.domains` 语义升级为「provider 级域名限定」，可能需要 `provider` 字段 |
| `apps/api/src/webSearch.ts` | 新增第二个 adapter；`createBochaWebSearchAdapter` 保持不动；装配处按可用凭据选择 |
| `apps/api/src/radarSources.ts` | `createBochaRadarWebAdapter` 需要泛化为「按 provider 选 adapter」 |
| `infra/.env.example` / `infra/staging/runbook.md` | 新凭据项 |
| `docs/` | 推翻 Ticket 16「唯一 Web Search Provider = 博查」的决策，需要新的 ADR |
| **migration** | 无 |
| **新依赖** | **无**（用 `fetch` 直调 HTTP 即可），但**新凭据 + 新费用 + 新外部依赖** |

**对现有行为的影响**：若不改装配策略，仅新增不启用，则行为不变。一旦启用，Radar `sites` 的召回集合会从博查索引换成另一家索引，**结果是不同的**（不是子集）——现有 Signal 会变化，指纹不同、历史对比会断。

**副作用与失败模式**

- 唯一保留「关键词检索」语义的路：能回答「这 7 家最近关于 X 的报道」，而不是「这 7 家最近发了什么」。
- 代价：新增境外凭据、新增按次计费、新增一家可能同样不认 `site:` 的供应商（**必须先按 §1 的方法实测再选**，不能看文档选——博查的文档与行为就是不一致的）。
- 推翻既有决策：`03-Radar与Issue预研.md` §4 写「Provider 由 `.env` 固定」，Ticket 16 决策为「唯一 Provider = 博查，删除 Brave/SEARCH_API_KEY」。这不是技术选择，是已发布的架构决策，改它需要人授权。
- 付费墙媒体的检索结果仍然只是标题+摘要；换 provider 不会让 WSJ 正文变得可读。
- 部署环境对境外检索 API 的可达性未验证。

**验证方式**

- 先做**选型实测**：对候选 provider 逐个复跑 §1.1 与 §1.3 的两个实验——(a) 不可能域名是否返回 0 条；(b) 白名单命中数是否从 0 变成 >0。两个都过才进入实现。
- 实现后在同一天、同一 query 下比对两家 provider 的结果集合，量化差异而非声称「更好」。

---

### 方案 C：不新增机制，把媒体名写进 anchor / prompt（否决）

**内容**：7 家不改架构，只在 anchor 里写「路透社 Bloomberg 关于 X 的报道」，或让对话 Agent 在 query 里带媒体名，靠检索引擎的相关性把媒体内容排上来。

**改动范围**：零。只改 DB 里 `anchors` 的文本，或 prompt 里加一句。无契约、无 migration、无新文件。

**为什么它是最可能被先提出来的方案**：成本为零，而且「看起来管用」——搜「Bloomberg Nvidia」确实会返回一堆谈论彭博报道的中文财经页，读起来像命中了。

**为什么否决**：**实测 299 条里 0 条**来自这 7 家（§1.3），其中就包括 `reuters.com Nvidia`、`Bloomberg Nvidia`、`WSJ 华尔街日报 报道` 这三个正是方案 C 会发出的 query。返回的全是 `news.163.com`、`toutiao.com`、`sina.com.cn` 这类转述者。CEO 会在看板上看到一条标题里带「彭博」的 Signal，而实际来源是新浪财经——这正是 `03-Radar与Issue预研.md:20` 禁止的「用站点搜索冒充账号级来源」，只是把「公众号」换成了「7 家媒体」。

**副作用**：除了来源归属错误，还会污染 promotion fingerprint 与去重——同一篇新浪转述会被反复当成新 Signal，而它对应的是同一件被转述的事实。

**唯一可保留的部分**：作为**补充关键词**（在同一 query 里带上媒体名以提高该家的排序权重），但**绝不能作为来源归属的依据**。若采用，必须在 Signal 上如实显示真实主机。

---

### 三方案取舍对照

| | A 发布方 feed | B 域名限定 provider | C 媒体名提示词 |
|---|---|---|---|
| 真正限定到这 7 家 | **是**（渠道即发布方） | **是**（provider 侧） | 否（实测 0/299） |
| 语义 | 「这 7 家最近发了什么」 | 「这 7 家关于 X 的报道」 | 无保障 |
| 新增依赖 / 凭据 | 无 | **有** | 无 |
| 推翻既有决策 | 否 | **是**（Ticket 16 单一 provider） | 否 |
| WSJ 可用 | **否**（RSS 已死） | 取决于 provider 索引 | 否 |
| Reuters 摘要 | **无** | 有 | 无 |
| 配额压力 | 无（免费） | **按次计费** | 7× 或 20× 博查配额 |
| 违反「不得冒充来源」约束 | 否 | 否 | **是** |
| 主要失败模式 | 渠道改版/关闭、跨语言匹配 0 命中 | 供应商同样不认限定、可达性 | 静默误标来源 |

**推荐 A。** A 与 B 不互斥：A 先落地（零新增依赖、不推翻任何决策、立即解决「限定」这件事），把 B 作为后续增强，当且仅当 CEO 真的需要「跨这 7 家做时间跨度检索」而不是「看这 7 家最新内容」时再启动。C 不采用。

---

## 5. 风险与边界

### 5.1 付费墙

7 家的付费属性不同，直接影响 excerpt 的可得性：

| 来源 | 付费 | feed 里的摘要 |
|---|---|---|
| BBC | 免费 | 完整摘要 |
| CNBC | 免费 | 完整摘要 |
| Reuters | 免费 | **sitemap 无摘要** |
| Bloomberg | 硬付费 | feed 有摘要（teaser） |
| FT | 硬付费 | feed 有摘要（teaser） |
| Economist | 硬付费 | feed 有摘要（teaser） |
| WSJ | 硬付费 | feed 有摘要，但**源已死** |

要点：**摘要来自 feed 的 `<description>`，不来自正文抓取**，所以付费墙不阻断 Radar 链路——但摘要只是导语，未必包含一段可引用的决策语句。而 assess 要求「决策引文是 excerpt 的连续子串」，付费墙媒体的引文因此只能来自导语。这是内容质量的实质上限，不是实现细节。本方案**不引入正文抓取**（付费墙抓取是合规问题，且项目当前无此能力），所以这个上限必须作为已知边界接受并写进 UI 说明。

### 5.2 博查配额与费用

- 方案 A **不增加博查调用**：`sites` 与 `wechatAccounts` 调用数不变，`outlets` 走的是外部免费渠道。
- 方案 A **修复后减少隐患**：一旦承认 `domains` 无效，就不会有人把 7 家建成 7 个 site source；那本会是 7 倍配额（20 → 140 次/扫描）换 0 召回（§3.5）。
- 博查的具体单价与配额上限：仓库内可核实的只有 `infra/staging/runbook.md:100` 的验收脚本预算「单次进程 ≤3 次 query」，未见价目表。**本文件不编造单价**；方案 A 的成立不依赖单价。
- 现有的调用上限只在自研脚本里，**产品链路上没有**：Radar 是 sites × anchors 无上限（仅 20 anchor 与 180s 超时兜底），对话 Agent 是 8 次。若未来接入按次计费的 provider（方案 B），必须在链路上加显式预算，不能只靠脚本纪律。

### 5.3 召回为 0 的降级策略

分三种成因，产出一模一样，必须分开：

1. **渠道取不到**（网络/改版/源已死）→ `warnings` + 该 outlet 计为失败，与现有「部分 Source 失败：保存有效结果与 warning」一致。WSJ 现在就是这个状态。
2. **渠道取到但时间窗内无条目** → warning，不改 `lastRun.status`。
3. **时间窗内有条目但关键词全不匹配**（最可能是跨语言问题，§4 方案 A）→ **独立 warning**，并且必须能在 UI 上区分于 1、2。

**硬性禁止**：任何一种 0 召回都**不得回落到全网检索**。回落会让「CEO 限定了 7 家」变成一句谎话，且这种谎话在下游看不出来（Signal 会正常产生，来源显示却是新浪财经）。现有实现里所有 `sites` 都共享一个全网 site source，所以「回落」是默认会发生的事——必须在代码里显式隔断。

另外：全部 outlet 失败是否导致 `scan failed`？建议**否**——只把 outlets 计为失败；`sites`/`wechatAccounts` 仍按现有规则决定整体状态。否则一个 feed 改版就会停掉整个 Radar。

### 5.4 与「公众号必须账号级」约束的关系

`docs/technical/ceo-warmap/03-Radar与Issue预研.md:20`：公众号必须走真实账号渠道，不能用站点搜索冒充。

**不冲突，且是同一条原则。** 该约束的实质是：**发布方级来源必须有发布方级渠道，不能让「搜索到提过它的内容」冒充「它发布的言论」。** 7 家媒体是发布方，适用同一条原则。本方案只是把这条原则从「公众号」推广到「发布方」。

真正会与该约束冲突的是方案 C（用媒体名冒充来源）以及把 7 家建成 `sites` + `domains`（用站点搜索冒充发布方渠道）。**这两个都要在实现前显式否决并写明理由**，否则「7 家媒体」和「公众号」会被混成同一类来源，可替换性消失，未来任何一家换成别的渠道都会被误判为「只是配置变了」。

反向的边界也要守住：`outlets` 这一新类别**不得**被用来承载公众号，也不得让 `RadarOutletSource` 长得像 `RadarWechatAccountSource`（后者走账号级 MCP 且需要 sidecar）。两类共享接口形状（都返回 `TRadarSourceItem`），但不共享渠道实现。

### 5.5 其他

- **`WebSearchInput.domains` 的既有缺陷独立于本次需求**，但必须在本次一并处理（修正或删除），否则方案 A 落地后这个字段仍然是个陷阱。
- **`RadarSources` 缺省字段的契约陷阱**（§4 方案 A）：`additionalProperties: false` + 必填字段 = 线上旧行校验失败 = Radar 停摆。这是本次改动里唯一能造成整体故障的点。
- **`sources` 没有 Card Action**：今天只能直接改 DB。方案 A 不解决这件事（YAGNI），但需要人知道配置 `outlets` 要靠 DB 操作，因此**不要在 MVP 里给 7 家做「可在 UI 勾选」的假象**。
- **feed 是境外请求**：staging 环境的出网可达性未验证（本次探测在开发机）。若受限，方案 A 的降级是「永远只报 warning」，因此 outlet 健康度必须进 `providerStatus` 而不是只进 `lastRun.warnings`。

---

## 6. 必须由人决定的分歧点

1. **能接受「最新 N 条」而不是「关键词检索」吗？** 方案 A 给的是「这 7 家最近发了什么，其中哪些与 anchor 相关」，不是「这 7 家关于 X 的历史报道」。如果 CEO 的实际问题是后者，只有方案 B 能满足，代价是新增境外凭据与费用，并推翻 Ticket 16 的单一 provider 决策。这是本设计里最重要的取舍。

2. **WSJ 缺失是否可接受？** 实测其三路 RSS 均 HTTP 200 但内容停在 2025-01-27（停滞 20 个月）。选项：(a) 接受 WSJ 缺失，UI 显示「渠道无新增」；(b) 为 WSJ 单开抓取路径（更高成本 + 合规风险 + 新依赖）；(c) 用方案 B 的 provider 覆盖 WSJ。选 (b) 需要单独授权。

3. **Reuters 只有标题、没有摘要，是否可接受？** sitemap 有标题/时间/URL，无摘要。这意味着 Reuters 的决策引文只能是标题，直接降低 assess 的引文质量门槛。选项：(a) 接受；(b) 抓取 Reuters 正文（免费但需要抓取能力与合规判断）；(c) 排除 Reuters 的引文能力、只作线索。

4. **是否修正还是删除 `domains`？** 修正是让字段真生效（adapter 内后置过滤 + 0 结果 warning）；删除是承认博查不支持并移出契约（契约变更 + 重新生成 Web 客户端）。二者都消除了陷阱，取舍在「保留未来可能性」与「不留假象」之间。

5. **跨语言匹配口径怎么定？** Radar 的 `anchor.query` 是中文，7 家的标题是英文；且实测 `apps/api/src/radar.ts` **未实现** spec §5 的查询规划步骤（全仓无 planner），所以现在没有任何环节能产出英文查询。选项：(a) 用 LIGHT_MODEL 补上 spec §5 的规划步骤，为每个 anchor 产出英文检索式（新增少量模型调用，但是补齐既有 spec 偏差）；(b) 本地做中英关键词映射表（脆弱、维护成本高）；(c) 用模型对 feed 条目逐条判定相关性（准确但每次扫描都烧模型）。这不是实现细节，它决定方案 A 能否真的命中任何东西——不做这一步，方案 A 的召回同样是 0。

6. **`outlets` 的启用入口是否要进 UI？** 今天 `radar_config.sources` 没有任何 Card Action，只能改 DB。若不加 Action，`outlets` 的启停就是 DBA 操作；若加，则是新的 Action + 契约 + Web 表单，超出本次范围。

---

## 附：复现本次实测

以下命令不输出、不落盘、不写入任何文件中的凭据。

```bash
# 1) site: 是否被博查识别（E 组必须返回 0 条才算「site: 生效」）
set -a; . infra/.env; set +a
for q in "Nvidia earnings" \
         "Nvidia earnings site:reuters.com" \
         "Nvidia earnings site:reuters.com OR site:bbc.com" \
         "Nvidia earnings site:no-such-domain-xyz-99999.com"; do
  curl -s -X POST https://api.bochaai.com/v1/web-search \
    -H "content-type: application/json" -H "authorization: Bearer $BOCHA_API_KEY" \
    -d "$(node -e 'console.log(JSON.stringify({query:process.argv[1],count:20,summary:true,freshness:"oneMonth"}))' "$q")" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s);const v=b?.data?.webPages?.value??[];const h={};for(const p of v){try{const x=new URL(p.url).host.replace(/^www\./,"");h[x]=(h[x]||0)+1}catch{}}console.log(v.length, JSON.stringify(h))})'
done

# 2) 白名单覆盖：把白名单命中数打出来（实测 0/299）
#    见 §1.3 的 10 条 query，判定规则 host===d || host.endsWith("."+d)

# 3) 发布方渠道可用性（不需要博查凭据）
node -e 'const u=["https://feeds.bbci.co.uk/news/business/rss.xml","https://feeds.a.dj.com/rss/RSSWorldNews.xml","https://feeds.bloomberg.com/markets/news.rss","https://www.ft.com/world?format=rss","https://www.cnbc.com/id/100003114/device/rss/rss.html","https://www.economist.com/latest/rss.xml","https://www.reuters.com/arc/outboundfeeds/news-sitemap/?outputType=xml"];for(const x of u){const r=await fetch(x,{headers:{"user-agent":"Mozilla/5.0"}});const t=await r.text();const n=(t.match(/<item[\s>]/g)||[]).length+(t.match(/<url>/g)||[]).length;const d=(t.match(/<(?:pubDate|published|updated|news:publication_date)>([^<]+)</)||[])[1];console.log(r.status,String(n).padStart(4),String(d).slice(0,30).padEnd(30),x)}'
```

注意：本次探测发现 `.env` 里的 key 是 35 字符，切片时 `"BOCHA_API_KEY="` 是 **14** 字符而不是 13——第一次探测我用错了偏移量，得到了一整轮 401 `Invalid API KEY`，差点被误读成「参数不被支持」。**复现时先验证 key 切片正确**，见 §1.2 的对照组（`count` / `freshness` 必须精确生效），不要把鉴权失败当成能力缺失。
