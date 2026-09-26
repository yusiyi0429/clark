# 首次登录引导与配套 · 进度

- Spec：`spec.md`（v2）
- 前置盘点：`inventory.md`
- 产品论证：`why.md`（Codex，产品经理视角）
- 详细设计：`design-04-mission-cards.md`（本月 Mission Card）、`design-02-personal-radar.md`（个人雷达）
- 10 月讨论候选（占位）：`seed/placeholders/2026-10-mission-cards.battlefield-01.json`，生成脚本 `tools/gen-2026-10-candidates.mjs`

| 顺序 | Ticket | 状态 |
|---|---|---|
| 1 | 01 锁屏与引导底座 `issues/01-lockscreen-and-onboarding-foundation.md` | resolved（Claude 已验收并提交；打磨见 01p） |
| 1p | 01p 验收后的打磨 `issues/01p-onboarding-polish.md` | ready-for-agent |
| 2 | 04a 数据、状态机与讨论候选 `issues/04a-mission-rounds-data-and-drafts.md` | ready-for-agent |
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
