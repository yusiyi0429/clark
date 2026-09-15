# 06 Web 像素级重构

## 1. 职责

新建干净 `apps/web`，把当前 CEO WarMap scope 内视觉和微交互像素级迁移到类型化 Card 与稳定 URL。

不迁移旧业务逻辑、数据、API、Agent、localStorage、语音、录音、深研或旧页面。

## 2. 路由

```text
/access
/
/issues/[id]
/meetings/[id]
/radar
/radar/signals/[id]
/plans/[period]
/healthz
```

对象 URL 支持刷新、直达、复制和浏览器回退。首页点击仍播放当前全屏展开动画；直达页面只渲染动画终态。

## 3. 数据加载

- Server Component 负责登录守卫和首屏 Card query；
- Client Component 负责交互、SWR、Action 和 SSE；
- 页面只获取 Card，不获取可写 Domain document；
- Action 返回新 Card 后直接更新 cache；
- 前端不自行重算状态。

## 4. Card Registry

每个 kind 对应固定 renderer。未知 kind 显示版本不支持错误，不动态解释 layout。

Renderer props：Card payload、navigation callback、Action callback、reference callback。禁止 repository、模型、领域 handler 或固定业务 ID。

## 5. Action Client

统一 hook：

- 根据 ActionDescriptor 展示按钮和 input；
- 支持 JSON/multipart；
- pending 时禁重复提交；
- 409 使用 latestCard 刷新并提示重新核对；
- 成功更新 SWR；
- 错误区分配置、输入、冲突、依赖和瞬时失败；
- 不写 localStorage。

## 6. Conversation Dock

像素级保留：位置、尺寸、对象标签、文本输入、thinking、停止、Markdown、来源折叠、历史和引用托盘。

删除：语音模式、麦克风、TTS、本地命令解析。

SSE reducer 只管理展示：idle/streaming/complete/failed/aborted。业务状态来自 Card。

## 7. 引用

- UI 只保存未发送的 Card ID/version；
- 发送后清空；
- 后端生成 snapshot；
- 聚合 Card 无引用按钮；
- 对象页默认进入自己的 scope，不注入其他页面。

## 8. 视觉基线

在旧前端固定 fixture，生成：

- 首页默认；
- 每个战场正反面；
- 四类通知和浮卡；
- Issue；
- Meeting/preflight；
- Monthly；
- Radar list/detail/editor；
- Conversation history/thinking/source；
- access。

视口：1440×900、1600×1000。记录 focus、Escape、reduced-motion 和动画终态。

## 9. CSS 迁移

优先复制现有 CSS Modules 和品牌资产，再按新 DOM 做最小调整。删除未使用规则，不全局格式化。

必须保持：

- 卡片尺寸与比例；
- 网格/左右区域；
- 通知密度与颜色；
- 字体层级；
- 圆角、边框、阴影；
- 浮层层级；
- 动画时长和 easing；
- focus ring；
- reduced-motion。

业务文本变化不能成为改变几何的理由。

## 10. scope 内组件映射

- Workspace → AppShell + HomePage + ConversationDock；
- HomeBoard → HomeCardGrid；
- ProgressCard → BattlefieldCard；
- Notifications → NotificationRail/FloatCard；
- IssueWorkspace → IssuePage；
- MeetingWorkspace/HeavyWorkspace 的视觉 → MeetingPage/MonthlyPage；
- RadarFeed/AnchorEditor → RadarPage/SignalPage/RadarConfigDialog；
- ConversationTranscript → ConversationHistory；
- CardReferences → ReferenceTray。

只迁视觉和交互，不迁 model、decision、meeting fixture、radar server、command parser。

## 11. scope 外组件

新增 Research status、Override、dismiss Issue、Meeting selector、Transcript upload/error、Outcome item list、pending_export、not-found、Pi restore warning。

约束：

- 使用已有按钮和浮卡；
- 错误使用当前低干扰材料页样式；
- 危险动作使用现有撤回/确认模式；
- 不增加后台侧栏、管理表格或第二套 token。

## 12. 首页

API 一次返回首页 Card 集合。Web 负责固定布局：战略、战场、能力、Radar、通知。

能力标题不导航独立页。一个 Issue 只由后端出现在唯一主归属。

战场翻面只切展示面，不改变业务状态；背面无百分比。

## 13. Radar

筛选/排序可用 URL query 或本地 state。read/save/dismiss/manual scan/update config 全部走 Action。“刷新信号”改为“手动补扫”。显示 lastRun trigger/time/status/warnings。

## 14. Access

保留品牌和口令输入，删除 seat、DRI 身份和旧空间选择。登录成功返回原目标 URL。Cookie 由 API 设置，Web 不读取密码哈希。

## 15. 依赖

初始只保留 Next、React、lucide-react、clsx、react-markdown、remark-gfm、SWR。CSS Modules 承载视觉，不迁 Tailwind。

不迁 Bedrock、TOS、unpdf、ASR/TTS、class-variance-authority、tailwind-merge 等无目标用途依赖。

## 16. Web health

`/healthz` 只返回 Web 进程和 BUILD_SHA，不请求 API、数据库、模型或 Provider。

## 17. 测试 seam

- Card kind 渲染；
- 稳定 URL 直达/回退；
- Action request shape；
- 409 latestCard；
- scope 切换；
- 引用选择；
- SSE 状态；
- access guard；
- loading/error/not-found；
- focus/Escape/reduced-motion；
- 两个桌面视口视觉 diff。

动态文本遮罩不遮容器、图标、间距和状态色。

## 18. 删除门槛

- 全部目标 URL 可用；
- API 四条业务链接通；
- Web bundle 无旧 seed/密钥；
- scope 内视觉回归通过；
- scope 外人工走查通过；
- 用户确认；
- 才删除整个旧 frontend。

## 19. 完成条件

新 Web 不包含业务 API、业务数据或 localStorage；当前 CEO WarMap 核心交互保持像素级一致；新增状态看起来属于同一产品；旧前端可安全删除。
