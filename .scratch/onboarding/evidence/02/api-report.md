# 02 个人雷达 · API 侧实现记录

日期：2026-09-27。依据：`design-02-personal-radar.md`（§0 已定事项、§1–§4、§6 的 API 部分）、ADR-0021、工单 02。契约（`packages/contracts`）与 Web（`apps/web`）一行未改；迁移 `031_person_radar.sql` 按原样使用，没有改。

## 1. 改动文件

新建（源码）
- `apps/api/src/radarSettings.ts`：方向与来源的规范化和校验（§3.4 全部规则）、读法现算（§3.3）、个人与公司共用；建议来源与方向建议；个人设置读写；公司雷达设置读写；引导的雷达摘要。
- `apps/api/src/personalRadar.ts`：扫描服务（进程内串行队列、认领、定时补扫、启动补偿、idle、一次扫描全部步骤）、手动扫描的 CAS 排队、当天条数。
- `apps/api/src/personalRadarAgent.ts`：判定器与 `PERSONAL_RADAR_PROMPT`。
- `apps/api/src/personalSignals.ts`：个人信号列表、单条、状态、未读数、首页小组件。
- `apps/api/src/routes/myRadar.ts`：`/api/me/radar*` 全部路由。

新建（测试）
- `apps/api/test/radarSettings.test.ts`、`apps/api/test/personalRadar.test.ts`、`apps/api/test/myRadar.test.ts`

修改（源码）
- `radar.ts`：导出 `sourceFingerprint`。
- `signals.ts`：导出 `isFullTextSource`；雷达卡 `payload.sources.outlets` 增加 `names`。
- `outletSources.ts`：Atom 解析。
- `radarScheduler.ts`：可选 `after`。
- `server.ts`、`app.ts`、`routes/shared.ts`：创建、注入、关闭时等待个人雷达服务；注册路由。
- `routes/config.ts`：`GET/PUT /api/config/radar`。
- `routes/me.ts`：`/api/me/home` 增加 `radar`。
- `onboarding.ts`：两个角色都返回 `radar` 摘要。

修改（测试）
- `test/helpers.ts`：`createTestApp` 的注入项加两个可选字段 `radarService`、`personalRadarService`（只加类型，原样透传给 buildApp）。
- `test/migrate.test.ts`、`test/outletSources.test.ts`、`test/promptGovernance.test.ts`。

说明：工作区里新出现的 `apps/api/src/githubTrending.ts`、`apps/api/test/githubTrending.test.ts` 不是本单写的（看起来是并行的 02b），没有动；它的 4 个测试在全量第 1 批里通过。

## 2. 设计点怎么落地

### 2.1 接入点（§2.1）
- `createRadarScheduler(radar, intervalMs, after?)`：公司 `runScheduled()` 结束且状态不是 busy（完成、跳过、失败、抛错都算结束）时调用 `after()`；两段各自 try/catch，tick 永不 reject。原有 tick 行为不变。
- `server.ts`：抽出 `radarWeb = createBochaRadarWebAdapter(bochaSearch)`，公司与个人共用（同一个博查实例、同一请求间隔）；个人服务共用 `outletAdapter`；调度器第三个参数是 `() => personalRadarService.runScheduled()`；公司补偿之后 `await personalRadarService.recoverStaleRuns()`；传入 buildApp。
- `app.ts`：参数 `personalRadarService?`，缺省给桩（不扫描）；onClose 里 `await personalRadar.idle()`；RouteContext 加 `personalRadar`；注册 `registerMyRadarRoutes`。

### 2.2 扫描服务（§2.2、§2.3、§2.7）
- 进程内串行队列，一次扫一个人，全部是 `pool.query` 短语句，不拿公司扫描的 advisory lock。
- 认领语句照设计，另加一个条件（见 §3 偏差 1）：
  `UPDATE person_radar SET last_run=$2, last_scan_day=<公司日> WHERE person_id=$1 AND enabled AND COALESCE(last_run->>'status','')<>'running' AND ($4='manual' OR last_scan_day IS NULL OR last_scan_day < <公司日>) RETURNING directions, sources`
- 定时补扫：`enabled AND (last_scan_day IS NULL OR last_scan_day < 今天)`，再用 companyMemory 过滤出还在 seed 里、`roleOf` 为 member 的人，逐个排队，立即返回。
- 启动补偿：`last_run.status` 为 queued／running 的改成 failed，补 `completedAt`，warning「扫描被进程重启中断」；`agent_runs` 里 `personal-radar-assess` 且 running 的改成 failed。不自动重跑。
- 常量照 §2.3 表：48 小时、每方向网页 3 条、订阅源 20 条、合计 30 条、每批 10 条串行、判定原文 2000 字、相关度门槛 3、每人每天 10 条（按 `collected_at` 的 Asia/Shanghai 日计）、每人 90 秒、手动冷却 10 分钟。
- 步骤：
  1. 认领；按当前目录现算每个来源的读法。
  2. 今天已收满 10 条：记 completed，warning「今天已收满 10 条」，不调博查、不调模型（有测试数调用次数）。
  3. 90 秒限时内采集：来源为空时每个方向 `web.search({ query, lookbackHours: 48 })`，**从不传 domains**；来源不为空时，订阅源一次 `outlets.fetchLatest({ outletIds, lookbackHours })`（直接用目录 id，不走 `resolveConfiguredOutletIds`），网站每个方向全网检索一次、只留 `host===d || host.endsWith("."+d)` 且路径前缀（按段）匹配的结果，其余（暂不支持、榜单）只写 warning，不回落全网。
  4. 时间窗 [开始−48h, 开始]；`canonicalizeRadarUrl` + `sourceFingerprint` 批内去重；去掉本人已有指纹；再按上限截断，新的优先。
  5. 判定（每批开始前看超时），代码复核：指纹属于本批、directionId 属于本人、`excerpt.includes(evidenceQuote)`、relevance ≥ 3；同一来源多次提交留相关度高的。
  6. 按相关度、再按发布时间，取今天剩余名额写入，`ON CONFLICT (person_id, source_fingerprint) DO NOTHING`；`collected_at` 用应用时钟。
  7. 写 `last_run`：判定批全部失败记 failed，否则 completed；warnings 截到 50 条、每条 500 字（契约上限）。
- 失败隔离：每个人单独 try/catch，失败只写他自己的 `last_run`；worker 里每个 promise 都有 catch；行数据损坏（方向不是字符串等）只把这个人记为 failed；个人代码（`personalRadar.ts`、`personalRadarAgent.ts`、`personalSignals.ts`）不读写 `radar_config`、`signals`、`issues`，也不 import `issues.js`（有静态检查测试）。
- warning 文案（成员界面可能直接显示）：「今天已收满 10 条」「{名}：{读法说明}」（如「华尔街日报：订阅源已停更，暂不支持」「36氪：全网检索未开通，暂时读不到」）「全网检索未开通，只写方向暂时读不到」「全网检索「{方向}」失败：…」「订阅源读取失败：…」「{发布方}：48 小时内没有新条目」「48 小时内没有新条目」「条目超过上限，只研判最新的 N 条，略过 M 条」「研判失败：…」「N 条候选没有通过引文或归属复核」「有 N 条没来得及研判（超过 X 秒上限）」「今天的 10 条名额已满，另有 N 条没有保存」「扫描超过 X 秒上限，已中断」「雷达设置数据无效」「扫描被进程重启中断」「雷达已关闭，这次扫描取消了」。

### 2.3 判定器（§2.4）
- `runCandidateAgent({ kind: "personal-radar-assess", modelSlot: "light", objectRef: { type: "person-radar", id: personId }, schema: PersonalRadarJudgeSubmission, prompt })`，不给 CompanyMemory 工具（测试断言模型只看到 `submit_candidate` 一个工具）。
- prompt 用设计草稿原文，版本行 `Tianshu Personal Radar Assess v1`，末尾接 `HUMAN_WRITING_STYLE`；`PERSONAL_RADAR_PROMPT` 已加进 `promptGovernance.test.ts`。
- 模型输入：`{ directions:[{id,text}], sources:[{sourceFingerprint,title,excerpt(≤2000),publishedAt,from}] }`，`from` 是发布方名或网址主机。

### 2.4 升级防护（§2.5）
- 结构：只写 `person_radar_signals`；测试里判定打 5 分，`signals`、`issues` 仍是 0 行。
- 契约：多给 `promotion` 字段的提交被 Pi 的参数校验与 `Value.Check` 拒掉，这一批失败、一条不写（用真实 `createPersonalRadarJudge` + 假模型流测试）。
- 代码：静态检查测试确认 5 个个人雷达文件不 import `issues.js`、不出现 `promotion`／`onIssuePromoted`；3 个扫描与信号文件不出现 `radar_config`，也没有对 `signals`、`issues` 表的 FROM／INTO／UPDATE／JOIN。

### 2.5 来源规则与读法（§3.3、§3.4）
- `readSource(input, webSearch)` 一个函数覆盖规则 1–10；`normalizeRadarSettings(input, mode, webSearch)` 覆盖规则 11–12 与方向规则 1–5；个人与公司共用。
- 名单和文案只在 `radarSettings.ts`：暂不支持（GitHub Trending「榜单读取器还在开发，暂不支持」、Hacker News「订阅源只有评论链接，暂不支持」、华尔街日报「订阅源已停更，暂不支持」）；有名字的网站（36氪、机器之心）；订阅源名取 `RADAR_OUTLETS`；匹配顺序是暂不支持 → 订阅源目录 → 有名字的网站 → 一般网站。
- 读法说明：feed「订阅源」；site「全网检索后按域名筛，结果可能很少」，博查未配置时「全网检索未开通，暂时读不到」。
- 拒绝文案：「来源不能为空」「只支持 http 或 https 网址」「不是有效的网址」「网址里不能带账号或口令」「网址里不能带端口」「请填公开网站的域名」（IPv4/IPv6 字面量、单段主机、保留后缀、超长或非法字符）「公众号要按账号订阅，贴文章链接读不到」「网址太长了」；公司模式「公司雷达已经在全网按方向检索；单独的网站只有在有订阅源时才能加入」。
- 方向：NFKC、合并空白、trim；必须含字母或数字（「方向要写成一句话」）；`Array.from` 计 40 字（「方向最多 40 个字」）；不区分大小写去重；id `d_<12>`／`manual:<12>`。
- fieldErrors 键为输入下标 `directions/<i>`、`sources/<i>`，一次返回全部问题；方向有问题时码为 RADAR_DIRECTION_INVALID，否则 RADAR_SOURCE_INVALID（两类问题同时存在时 fieldErrors 一起返回）。
- 建议来源：金融时报、量子位、The Information、BBC、彭博、路透社、CNBC、经济学人（订阅源）+ 36氪、机器之心（网站，写明结果可能很少），共 10 个；博查未开通时不建议网站；公司只建议 8 个订阅源。不含华尔街日报、Hacker News、GitHub Trending。
- 方向建议（≤3，`{text, from}`）：本人本月 Mission／个人卡里个人任务标题（`from` 为「{M} 月讨论候选」或「{M} 月 Mission」）、参与的战场名（「参与的战场」，与首页、引导共用 `readMemberWork`）、这些 Mission 的能力名（「能力域」）三类轮流取；改写成短主题＝取第一个分句、按字符截到 40；已在本人方向里的不再建议。

### 2.6 接口（§4.2、§4.3）
- `/api/me/radar*` 先 `requirePerson`（非 GET 校验 Origin），CEO 一律 403 FORBIDDEN「CEO 的雷达就是公司雷达，在「雷达设置」里修改」。
- GET `/api/me/radar`：从没保存过返回 `enabled=false`、`updatedAt=null`、空方向与来源；带 `lastRun`、`unreadCount`（本人未读且未隐藏）、`webSearch`、`suggestions`。
- PUT `/api/me/radar`：规范化后写入（只存规范值），`updated_at` 用应用时钟；不触发扫描；400 为 INVALID_INPUT／RADAR_DIRECTION_REQUIRED／RADAR_DIRECTION_INVALID／RADAR_SOURCE_INVALID，失败时什么都不写。
- 信号：列表（本人、未隐藏、collected_at 倒序、默认 50、最多 100，返回不带原文的 Brief）；单条与 PATCH 对非 UUID、不存在、别人的一律 404 SIGNAL_NOT_FOUND；PATCH 照 signals.ts 的 CTE，加 `person_id` 条件，状态没变不写。
- POST `/api/me/radar/scan`：先数今天收了几条（满 10 条 409 RADAR_DAILY_CAP_REACHED），再用 CAS 语句排队；排上 202 `{queued:true}` 并入队；排不上再读一次：没开 409 RADAR_DISABLED、在排队或扫描 409 RADAR_SCAN_IN_PROGRESS、冷却中 429 RADAR_SCAN_RATE_LIMITED（`retry-after` 为秒数，message「刚扫过，N 分钟后可以再扫一次」）。
- GET `/api/config/radar`（requireCEO）：directions＝`source:"manual"` 的 anchors；sources＝已启用发布方 id 的并集（按配置顺序）；automatic＝其余 anchors 的 title；`webSearch = providerStatus.web && sources.sites.some(s => s.enabled)`。
- PUT `/api/config/radar`（requireCEO + Origin）：一个事务 `SELECT ... FOR UPDATE`；anchors 写成 `[...manual, ...其余]`，没有 source 的旧 anchor 原样保留；sources 只替换 `outlets`（没选时写 `outlets: []`），sites、wechatAccounts 不动；写前对 anchors 与 sources 做 `Value.Check`，不过就回滚并 500 RADAR_CONFIG_INVALID；`version+1`；不触发公司扫描。
- `/api/me/home`：CEO、没开或从没保存过时 `radar: null`；否则 `{ lastRun, unreadCount, highlights }`，highlights 为最近 7 天、未隐藏、相关度降序再按 collected_at 降序，最多 3 条 Brief。
- `/api/me/onboarding`：成员 `configured = updated_at 不为空`、`enabled`、`directions = 方向条数`；CEO `configured = 已有 manual 方向或已启用的媒体来源`、`enabled = true`、`directions = manual 方向条数`。
- 公司雷达卡：`payload.sources.outlets.names` 为已启用发布方的中文名（按 `RADAR_OUTLETS` 目录顺序、去重）。

### 2.7 Atom（§3.3）
- `outletSources.ts` 的 `atom` 分支：`<entry>` 分块；链接取 `rel="alternate"`（或没写 rel）的 `href`；时间取 `<published>`，没有就 `<updated>`；摘要取 `<summary>`，没有就 `<content>`，去标签再解码实体；都没有时退回标题（与 RSS 一致）；归属校验、时间窗、单家上限沿用原逻辑。fixture 覆盖 rel=self／enclosure 干扰、无 rel、只有 updated、HTML 转义的 summary/content、仿冒域名与窗口外条目。

## 3. 与设计不同的地方（均有测试）

1. **认领语句多一个条件**：定时扫描要求 `last_scan_day` 早于今天。原语句下，排在队里的定时扫描（或另一个实例排的）碰上今天刚扫过的人还会再扫一次；手动不受影响。
2. **排队后雷达被关掉**：认领失败时，把「没开且仍是 queued」的 `last_run` 标为 failed（「雷达已关闭，这次扫描取消了」）。否则重新打开后 `/scan` 会一直 409「正在扫描」，要等第二天或重启。
3. **队列只按「排队中」去重，不含「正在扫描」**：扫描刚写完 `last_run`、内存里还没放掉这个人时，`/scan` 的 CAS 可能已经接受了新的手动请求；按设计「运行中则忽略」会丢掉它、库里一直停在排队中。现在排到后面，由认领语句决定要不要扫（定时的有条件 1 挡住，手动的已过 CAS）。修复前复现失败见 `api-queue-red.log`。
4. **采集全部失败也记 failed**：设计只写「判定批全部失败记为 failed」。尝试了来源但一个都没成功（如博查全挂）时，如果记 completed，界面会把故障说成「没有新内容」；与公司雷达 `succeeded === 0 → failed` 一致。没开通检索、全是暂不支持这类读不了的情况仍记 completed，并写明原因（重试也没用）。
5. **引文只在判定看到的前 2000 字里核对**，比在全文里找更严。
6. **公司模式的暂不支持来源**用它自己的原因（如华尔街日报「订阅源已停更，暂不支持」），网站用设计文案。公司配置里如果启用了 wsj，GET 会如实显示成暂不支持，CEO 保存前要去掉它。
7. **规范值超过 300 字符拒绝**（「网址太长了」）：中文路径百分号编码后会变长，契约 `RadarSourceSetting.value` 上限 300。
8. **路径前缀按段匹配**（`github.com/trendingx` 不算 `github.com/trending`，`example.org/blogger` 不算 `example.org/blog`）；`weixin.qq.com` 本身也按公众号拒绝。
9. **方向建议来源的具体口径**（设计只列了来源类别）：三类轮流取一条，短主题取第一个分句；战场只用名称，没用本月目标（目标是长句，截断后不像检索主题）。

## 4. 测试

先写测试再实现：
- `api-typecheck-baseline.log`：动手前 API 类型检查 3 处错误（契约新增的必填 `radar`）。
- `api-red.log`（实现前）：8 个文件 7 失败 1 通过；22 失败／24 通过。原因：新模块不存在、`/api/me/radar*` 与 `/api/config/radar` 404、首页与引导因缺 `radar` 字段 500、Atom 解析缺失。migrate 测试在补上 031 的清单后通过（迁移本来就在）。
- `api-green.log`（实现后同一组）：8 个文件、137 个测试全部通过。
- 队列竞态：`api-queue-red.log`（把队列临时改回旧行为）1 失败；`api-queue-green.log` 修复后 `personalRadar` + `radarSettings` 85 个全部通过。
- 变异检查（每次改完即还原）：去掉单条读取的 person_id 条件、调度器不看 busy、给博查传 domains、跳过当天上限短路、公司模式不限订阅源、定时认领不看当天——6 处都被测试抓到。
- 类型检查：`api-typecheck.log` 通过。

新增测试：`radarSettings.test.ts` 61 项（§3.4 表驱动）、`personalRadar.test.ts` 24 项、`myRadar.test.ts` 14 项；另有 Atom 1 项、prompt 治理 1 项、迁移测试扩充（031、34 条、两张新表、「开启但 0 条方向」被拒、同人同网址唯一）。`myRadar.test.ts` 对每个响应做 `Value.Check`（局部注册 uuid／date／date-time 格式），证明响应符合冻结的契约。

全量（`pnpm --filter @warmap/api exec vitest run --maxWorkers=1 <文件>`，按 5 批串行，日志 `api-final-batch-1..5.log`，汇总 `api-final-batches.log`，都是最终代码）：

| 批 | 文件 | 测试 | 结果 | 用时 |
|---|---|---|---|---|
| 1 | 12 | 123 | 115 通过／8 失败 | 105 秒 |
| 2 | 12 | 132 | 全部通过 | 151 秒 |
| 3 | 12 | 76 | 全部通过 | 108 秒 |
| 4 | 12 | 213 | 全部通过 | 108 秒 |
| 5 | 11 | 114 | 全部通过 | 70 秒 |
| 合计 | 59 | 658 | **650 通过／8 失败** | |

8 项失败全部在既有的 `deployment.test.ts`（backup compose 2 项、restore 破坏性边界 2 项、volume-backed recovery 4 项），与 04d 报告记录的 Windows 既有失败同名同数，与本单无关。没有出现 `ERR_IPC_CHANNEL_CLOSED`。第 1 批包含并行 02b 的 `githubTrending.test.ts`（4 项通过）。

中途一次全量跑到第 2 批时，我发现了上面的队列竞态，停掉了那次运行，修复并补测试后重新从第 1 批完整跑完；被停掉那次的日志已删除，没有留下测试库（核对过本会话时间段内没有残留的 `warmap_test_*`；更早的残留库不是本会话的，没有动）。

## 5. 消融检查

逐项看本次新增的抽象、分支和常量：

- **保留（设计直接要求或有测试证明必要）**：§2.3 的全部常量；认领、定时补扫、启动补偿、idle；`readSource`／`normalizeRadarSettings`／`urlWithinSite`／`directionId`；建议来源在博查未开通时不放网站（「只放能如实读的」）；行数据损坏的检查（§2.7）；warnings 与 title／excerpt 的截断（契约上限）；三处偏差修复（§3 的 1–3，各有一条先失败后通过的测试）；`readStoredSource` 的兜底（`readSource` 返回联合类型，库里的值理论上都合法，兜底只有一行，避免个别坏值让整页 500）；`helpers.ts` 两个可选注入项（测试需要注入扫描替身）。
- **斟酌后保留**：
  - 每个订阅源零条的 warning：设计的 warnings 列了「零条」，公司雷达也按来源报零条；只有总零条时，用户看不出是哪个订阅源静默变空。
  - 方向建议三类轮流取：spec §4.2 列了战场、能力和个人卡三类来源；顺序拼接时，Mission 多的人三条建议全是 Mission 标题。
  - 短主题取第一个分句：对应「改写成可检索的短主题」；只截断的话会把「，下月再定」这类半句带进方向。
- **没有新增**：依赖、配置项、通用框架、迁移改动、契约改动。

## 6. 仍然存在的限制

- **没有做真实扫描**：没有读 `.env`，也没有调用博查和模型；全部用替身。上线前按设计 §6 在 staging 复测：FT、量子位、The Information 的订阅源，36kr.com、jiqizhixin.com 在博查里带发布时间的结果数（为 0 就撤出建议行），并用一个真实方向跑一次个人扫描。
- 个人方向和命中结果会进 `agent_runs.input_snapshot`，配置了 LangSmith 时也进 trace（ADR-0021 已写）。
- 当天没收满 10 条时，重复手动扫描会把被拒的条目再判一遍（设计 §7，未加「记住判过的指纹」）。
- 进程内队列假定单机部署；多实例靠认领语句防重复。关闭时 `idle()` 会等队列扫完，最坏每人 90 秒。
- 订阅源静默变空与读取失败分不清（发布方 adapter 吞掉渠道错误，与公司雷达同样的局限）；每个订阅源的零条 warning 能看出来是哪一家。
- `webSearch.ts` 仍会为公司雷达拼无效的 `site:`（既有缺陷，另开单）；个人管线从不传 domains。
- Atom 标题若是二次转义的 HTML（`type="html"`），实体只解一层，与 RSS 现状一致。
- 公司配置里如果启用了华尔街日报，编辑器会如实显示「订阅源已停更，暂不支持」，CEO 保存前要去掉它。
- Fastify 默认 `removeAdditional`：请求体里的多余字段被静默去掉而不是 400（既有行为）。

## 7. 给 Web 与 Claude 的提示

- 字段名：公司雷达卡 `payload.sources.outlets.names`（Web 侧已按这个名字读）。
- 方向建议的 `from` 只有四种：「{M} 月讨论候选」「{M} 月 Mission」「参与的战场」「能力域」。
- `/scan` 的 409／429 的 `message` 可以直接显示；429 带 `retry-after`（秒）。
- `GET /api/me/radar/signals` 返回不带原文的 Brief；阅读页用 `GET /api/me/radar/signals/:id`。单条读取对已隐藏的信号也返回（用于「恢复」），列表不含已隐藏。
- `lastRun.warnings` 是写给人看的中文，可直接展示。
- 给 02b：`github.com/trending/python` 现在按规则 9 规范成 `github.com/trending`、查询串按规则 8 丢掉；做榜单读取器时要把它从 `UNSUPPORTED_SOURCES` 挪出来改成 `list`，并决定是否保留语言路径和 `since`。扫描里非订阅源、非网站的来源现在统一写 warning，读取器接在那里。
