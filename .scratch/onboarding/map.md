# 首次登录引导与配套 · 进度

- Spec：`spec.md`（v2）
- 前置盘点：`inventory.md`
- 产品论证：`why.md`（Codex，产品经理视角）
- 详细设计：`design-04-mission-cards.md`（本月 Mission Card）、`design-02-personal-radar.md`（个人雷达）
- 10 月讨论候选（占位）：`seed/placeholders/2026-10-mission-cards.battlefield-01.json`，生成脚本 `tools/gen-2026-10-candidates.mjs`

| 顺序 | Ticket | 状态 |
|---|---|---|
| 1 | 01 锁屏与引导底座 `issues/01-lockscreen-and-onboarding-foundation.md` | resolved（Claude 已验收并提交；打磨见 01p） |
| 1p | 01p 验收后的打磨 `issues/01p-onboarding-polish.md` | resolved（待 Claude 验收、提交） |
| 1q | 01q 减少透明度回退 [报告](evidence/01q/report.md) | resolved（编译／CDP／类型检查／291 项测试通过；待 Claude 验收、提交） |
| 2 | 04a 数据、状态机与讨论候选 `issues/04a-mission-rounds-data-and-drafts.md` | resolved（待 Claude 验收、提交；[报告](evidence/04a/report.md)） |
| 3 | 04b 个人卡页与讨论 `issues/04b-mission-card-page-and-discussion.md` | ready-for-agent |
| 4 | 04c 集中 Review 与确认 `issues/04c-mission-round-review-and-confirm.md` | ready-for-agent |
| 5 | 04d 通知、入口与引导中的状态 `issues/04d-mission-card-notices-and-entries.md` | ready-for-agent |
| 6 | 03 DRI 首页小组件 `issues/03-dri-home-widgets.md` | ready-for-agent |
| 7 | 02 个人雷达 `issues/02-personal-radar.md` | ready-for-agent |
| 8 | 02b GitHub Trending 读取器 `issues/02b-github-trending-reader.md` | ready-for-agent |
| 随时 | 05 文档同步 | SSOT 仓库副本已更新（clark-main，未提交，飞书待同步）；CONTEXT 与 ADR 随各工单 |

每张工单单独交给 Codex，完成后由 Claude 验收（测试、类型检查、浏览器看三种尺寸），然后在本地提交，不推送，再开下一张。

## 结果摘要

### 01 · 2026-09-27

- 完成晨光 token／画布、厚白玻璃、Co-Agent 胶囊和进度；锁屏替换旧丝带，CEO／DRI 独立 `/welcome` 按真实数据引导，可配置地省略声纹，结束优先恢复有效深链。两个首页共用晨光入场。北斗保留紧凑的 96×36 版本。
- 新增 030 迁移、onboarded 会话字段、角色隔离的 onboarding API、幂等完成接口及契约；客户端由 `gen:client` 生成。声纹仅抽取 Web 共享 hook，API 声纹文件未动。顺手修复首次改码的焦点／过期确认值问题，以及手机首页原有的浅底白字，均限定本次完整入口路径。
- 验证：Web **253 → 281 项全部通过**；Contracts **42/42**；API 串行 **470 通过／8 失败 → 477 通过／同样 8 失败**。8 项是已有 Windows/Git Bash 部署脚本路径与 checksum 测试问题。API／Web 类型检查前后通过；`git diff --check` 通过。默认并发 API 基线的数据库连接／超时限制另行记录，没有归为新增业务失败。
- 已实际检查 1440×900、834×1194、375×812 和减少动效；减少透明度也通过 CDP 媒体查询验证。90 张截图、完整文件清单、测试日志与取舍见 [验收报告](evidence/01/report.md)。验证了改码、双方步骤／空态、未开通声纹、录音计时／保存／拒绝授权、完成重试、提前进入、守卫与深链、首页 SSR 入场。
- 自查使用独立 Web 副本（最终源码 hash 一致）和 54329 临时库；本次 3300／4300 服务、专用浏览器、两个临时库及预览目录均已清理。没有新增依赖、没有 git 写操作，没有停止受保护端口或 Docker，没有修改真人口令。
- 待人工确认：CEO 常用手机的 Safari 授权、键盘与安全区；真实麦克风／转码／腾讯声纹联调（本次用模拟供应商）；北斗与 spec 蓝色白字约 3.6:1 的最终产品验收。雷达与本月个人卡仍归后续工单。

#### 01p 打磨 · 2026-09-27

- 先补能复现问题的测试，再修收尾跳转：角色首页不算原链接；真实深链显示「继续刚才的页面」，下一件事改为按钮上方说明。新增 8 项点击回归，红阶段 4 失败／9 通过，修复后引导与锁屏 20/20；完整 Web **281 → 289 全通过**，类型检查通过。
- 完成六处视觉打磨：全站统一禁用态并补原因；胶囊改顶部弧光、细亮边与柔光；蓝／天青／中部光为 14%／10%／6%；桌面短页居中、长内容滚动且按钮可见，手机仍贴底；html/body 底色同步。北斗 144×60 与圆点两版经桌面、手机并排比较后选圆点，保持胶囊为唯一主角。
- 80 张截图（含 20 张并排对照）及完整索引见 [01p 报告](evidence/01p/report.md) 与 [对照图册](evidence/01p/comparison-index.html)。六种尺寸 CTA、两角色三种 next、15 秒可停／30 秒自动停／保存、减少动效、手机滚动后的录音操作均已验证；锁屏到引导 133 次底色采样一致。
- 额外发现仅记录：原有减少透明度规则经当前 CSS 编译后只剩带前缀的关闭模糊声明，Chromium 实心底色生效但 backdrop-filter 仍非 none。规则与 0d50e10 相同，未扩大本单修复范围。真实 Safari／麦克风与主题色观感仍待人工确认。
- 3500／4500、本次专用浏览器、54329 上一次性库及 `.scratch/preview-web-01p` 已清理；原服务进程保持不变。无 API、依赖、生成文件修改，无 git 写命令。

### 04a · 2026-09-27

- 完成迁移 032–034、Mission 13 字段与个人卡归属、轮次契约及生成客户端、草稿导入、固定 48 小时讨论、截止快照、重开与结论结转。拍板权限在锁后取当前 DRI，重放和旧版本响应前复查；普通 Mission 编辑和战场删除加入挂卡/轮次保护。
- CLI 与 CEO「整理个人卡草稿」共用事务导入函数；只读候选文件 hash 保持不变。测试库实走签发 → 整理，得到 1 轮、5 卡、12 条 v1 占位 Mission；验证重跑无改动、变化拒绝、严格截止与重开。目标签发不再把个人草稿误标为生效事实。
- Contracts **42 → 46 全通过**；Web **291 → 314 全通过**；API **477 通过／8 失败 → 503 通过／同样 8 失败**。API 最终全部 50 文件按每组 5 文件、`--maxWorkers=1` 串行完成；单次长跑曾有材料超时、fork IPC 断开及 threads 原生异常，均单独记录，不计作通过。8 项稳定失败仍是已有 Windows/Git Bash 部署脚本问题。API/Web 类型检查、gen:client、diff whitespace 检查通过。
- 浏览器实际走通签发计划 → 占位说明确认 →「草稿 · 可以统一开放讨论」，检查 1440×900 与 375×812，无横向溢出。8 张截图、完整改动清单、设计补充及日志见 [报告](evidence/04a/report.md)。3500/4500、自建测试库、同层 Web 副本和专用浏览器已清理，其他服务 PID 不变。依赖锁文件最终无差异，候选 JSON、API 声纹文件未改，无 Git 写命令。
- ADR-0022、ADR-0019/0020 与 CONTEXT 已同步。slot 独立投影、目标依据版本冻结、`viewCardId` 在 04a 写前拒绝等补充已记录。仍需 Claude 验收、真实登记映射核对、GAP-04 决定及本机长跑运行器稳定性复核；04b/04c/04d 尚待接续。
