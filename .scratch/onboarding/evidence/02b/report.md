# 02b · GitHub Trending 读取器验收报告

日期：2026-09-27。起点：`ba518b7`（02）。状态：resolved。

本单由 Claude 直接完成（Codex 额度留给更值得用的地方）。

## 交付行为

- **读取**：`apps/api/src/githubTrending.ts`。
  - 读 `https://github.com/trending`，按来源里的语言路径和 `since` 读对应的那一版。
  - 解析 `article.Box-row`，取仓库全名、链接、描述、语言、时段内 star。
  - 每次扫描只读一页，15 秒超时，两次请求至少隔 2 秒，带 `Tianshu-PersonalRadar/1.0` 的 User-Agent。
  - 解析出 0 个时，分两种情况写明确的 warning：「GitHub Trending 这一版今天是空榜」和「GitHub Trending 页面结构可能变了，没有解析出上榜仓库」，都不静默。
- **规范化**（`radarSettings.ts`）
  - `github.com/trending` 与语言子路径记为「读取榜单」。
  - 规范值保留语言和版本，例如 `github.com/trending/typescript?since=weekly`；daily 是默认，省掉。
  - 语言段保留百分号编码，避免 `c#` 这类被当成锚点；显示名是解码后的形式，例如「GitHub Trending · c++ · 月榜」。
  - 开发者榜（`/trending/developers`）和更深的路径不是仓库榜，如实写「暂不支持」。
  - 公司模式拒绝榜单，提示「榜单只能加进个人雷达」。
  - 建议行加入「GitHub Trending · 读取榜单（每天一次）」。它直接读页面，不依赖全网检索，所以博查没开通时也照常建议。
- **进管线**（`personalRadar.ts`）
  - 作为 `list` 来源，每一版读一次，按时段内 star 多的先，取前 10 个。
  - `listed_on` 记扫描当天（公司时区），`published_at` 为空，不伪造发布时间。
  - 原文如实拼成一句，例如「全名：描述（语言 X，本周 N star）」；没有描述就写「没有描述」，不编。
  - 判定输入带 `listedOn`，来源名写「GitHub Trending」。复核和去重规则不变：同一个仓库第二天还在榜上，同一人不重复收，也不再拿去判。
  - 读取失败只写 warning，不影响这个人的其他来源，也不影响别人。
- **契约**：个人信号来源加 `listing`（语言、时段内 star、日／周／月），其他来源为 null。
- **Web**
  - 阅读页头部写「GitHub Trending · 上榜于 2026/9/27 · PowerShell · 今日 361 star」，不写发布日期。
  - 原文出处写「GitHub Trending 的榜单条目，未读取仓库内容」，不再说成「检索服务返回的摘录」。
  - 列表出处行写「上榜于 {日期}」；首页小组件写「上榜于 9/27」，不按收集时间写几分钟前。

## 真实读取（本机能联网）

1. **读真实榜单页**（2026-09-27，`curl` 加解析器核对）
   - 解析出 15 个上榜仓库。
   - 没有描述的仓库（anthropics/claude-code-action）描述为 null。
   - 冷门语言的空榜（COBOL、Brainfuck）页面写「It looks like we don’t have any trending repositories for …」，识别为空榜。
   - 测试夹具是按这个结构手写的精简 HTML，没有存 GitHub 原页。
2. **经正式接口做真实扫描**
   - 做法：在 02 的一次性夹具里接上真实读取器、博查与轻模型；孙铭泽把方向设为「AI Agent 的开发框架与工具」、来源只填 `github.com/trending`。
   - 结果：9 秒完成，入库 5 条，相关度 5 的是 mobile-next/mobile-mcp、dream-num/univer、vectorize-io/hindsight，相关度 4 的是 paperclipai/paperclip、zhaoxuya520/reverse-skill。
   - 公司侧信号、议题仍为 0。
   - 截图：`claude-trending-*.png`（列表、阅读页、首页小组件、编辑器，1440 与 390）。无横向溢出，无页面错误。

## 测试

| 项目 | 02 之后 | 02b 完成后 |
|---|---|---|
| Contracts | 57 | 57，全通过。榜单样例补 `listing`，另有日／周／月之外的版本被拒、非榜单来源 `listing` 为 null 的断言 |
| Web | 503 | 506，全通过。阅读页、列表、首页小组件各加一条榜单条目的断言 |
| API | 650 通过／8 既有部署失败 | 660 通过／8 既有部署失败（668 项）。第 1 批运行器 `ERR_IPC_CHANNEL_CLOSED` 中断，拆成两半重跑：61／79＋8 既有失败；其余四批 111、73、213、123 全通过 |

API 新增与改写：
- `githubTrending.test.ts` 4 项：正常榜单、结构变了、空榜、语言路径与 since、User-Agent、限速和失败。
- `radarSettings.test.ts` 61 → 66：榜单的各种写法、开发者榜、多段路径、公司模式拒绝、建议行。
- `personalRadar.test.ts` 24 → 28：按版读并取前 10、只记上榜日、「没有描述」、第二天不重复收、读取失败与结构变化只写 warning、没接读取器。
- `myRadar.test.ts` 14 → 15：榜单条目的投影与 `listing`。

API／Web 类型检查通过；`gen:client` 重新生成后与现有生成文件一致；`git diff --check` 通过。

## 取舍与边界

- **每版只判 10 个**：榜单每天约 25 个，全判会挤掉订阅源和网页的名额，也多花模型调用。按时段 star 取最热的 10 个。
- **榜单条目排序**：榜单没有发布时间，排序时按扫描时刻算，所以在合计 30 条的上限里排在前面；只有在用户明确加了榜单的前提下才会发生。
- **只读仓库榜**：开发者榜结构不同，没有接。
- **页面结构变化**：解析依赖 `article.Box-row`。结构变了会写 warning、那一版读不到，但不影响其他来源；那时要更新解析器。
- **待人工验收**：staging 的出网限制（GitHub 是否可达），以及真机上阅读页的长描述排版。

## 清理

- **夹具**：已关闭，临时库 `warmap_test_085fec81627b` 查证已删除。
- **预览副本**：`apps/web-02-preview` 删除前，253 个 src／public 文件哈希一致；junction 先解除再删除，`apps/web/node_modules` 保留。
- **端口**：3500／4500 已释放；受保护端口的进程号不变。
- **约束**：没有新增依赖。
