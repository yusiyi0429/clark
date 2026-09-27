# 02b GitHub Trending 读取器

Type: feature
Status: resolved（报告见 ../evidence/02b/report.md）
Blocked by: 02
Design: `../design-02-personal-radar.md` §10（以及 §1.1 的 `list` 类型、§3.4 的规范化）

## 为什么

用户举的第一个来源例子就是 GitHub Trending。它没有订阅源，检索服务也限定不了站点，只能直接读榜单页面。不做这个读取器，这个来源就只能标「暂不支持」。

## 范围

- 读 `https://github.com/trending`。来源里带了 `?since=` 或语言路径时，按那一版读：`github.com/trending/typescript` 读 TypeScript 榜，`?since=weekly` 读周榜。
- 解析 `article.Box-row`，取出仓库全名、链接、描述、语言、今日 star。
- 页面结构变了、解析出 0 个时，写出明确的 warning，不能静默。
- 进管线：
  - 作为 `list` 类型的来源，`listed_on` 记上榜日，不伪造发布时间。
  - 按方向交给判定模型判断相关性，复核与去重规则不变。
- 规范化：
  - `github.com/trending` 及其子路径记为「读取榜单」。
  - 建议行里写「GitHub Trending · 读取榜单（每天一次）」。
- 阅读页：
  - 榜单条目在个人信号阅读页上写「上榜于 {日期}」和语言、今日 star。
  - 不显示"发布于"。

## 质量标准

- 抓取要有超时、限速和 User-Agent。失败只记 warning，不影响这个人别的来源，也不影响别人。
- 不承诺读不到的内容：没有描述的仓库，摘要写「没有描述」，不编。

## 约束

同 02：遵守 `CLAUDE.md`、不新增依赖、不改 git 状态、不读密钥、共享文件只做增量修改、生成文件只用 `gen:client` 生成。

## 验证与验收

- [x] HTML fixture 覆盖三种情况：正常榜单、结构变了、空榜。
- [x] 语言路径和 `since` 都能正确解析。
- [x] 复核与去重的测试通过。
- [x] 本机能联网时，真实读一次榜单，记下结果；不能联网就写明原因。
- [x] 编辑器建议行出现 GitHub Trending，附读取说明；阅读页的写法正确。
- [x] 类型检查、测试通过。

## 完成后

更新 `Status`，在 `../map.md` 追加结果摘要。

已完成：Claude 直接实现（Codex 额度留作他用）。读真实榜单页解析出 15 个；经正式接口真实扫描 9 秒入库 5 条（相关度 5／5／5／4／4），公司侧为 0。详见 [02b 报告](../evidence/02b/report.md)。
