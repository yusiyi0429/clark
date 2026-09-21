你是 CEO WarMap 的像素验收审计子代理。任务是 Phase 2：为“全页面 UpgradeDesign.pen 像素级一致”建立可执行的逐页差异清单。此阶段严格只读：不得修改 apps/web、apps/api、contracts、UpgradeDesign.pen、数据库、Docker/Compose；不得运行会写入状态的命令，不得提交或推送。唯一允许写入的是本任务报告 `.scratch/ceo-warmap-mvp/evidence/pen-pixel-audit.md`（可用临时截图放 /tmp）。

基线：`/Users/renhaoliu/Desktop/Project/Clark_Re/UpgradeDesign.pen` 是视觉唯一基线。实际运行实例是 https://localhost/，登录口令为 202609。Caddy 使用本地 CA，浏览器可能须经 http://localhost 自动升级到 https 或接受证书。当前工作区有大量未提交改动，结论只针对当前状态，绝不建议回退别人的改动。

审计方式：
1. 先阅读根 `CLAUDE.md`，确认 git status。只读理解 apps/web 的路由、关键组件、CSS 和设计 frame。
2. 使用 `pen --in UpgradeDesign.pen --export /tmp/upgrade-design-audit.png` 和 `pen interactive` / CLI 的只读 Get，枚举所有用户可见页面/frame/关键状态；不得手工编辑 JSON。
3. 用 Chrome DevTools MCP 在实际 localhost 登录后，访问每条 Web 路由，并使用 snapshot/screenshot 检查。必要时以浏览器真实数据为准，不能用 mock 代替。
4. 产出逐页矩阵，至少覆盖：Access、Home（通知正常/空态若可达）、Radar（列表/监测范围/手动扫描态）、Signal、Issue（pending/decided/dismissed）、Meeting（scheduled/preflight、held/review、transcript/outcome）、Monthly Plan（协商/签发前/签发后）、Conversation Dock、Action loading/error/conflict。若某状态无法由安全只读手段到达，明确写“未验证”、阻塞原因以及最小可行复现方式，绝不能伪造。
5. 每个差异都要包含：设计 frame/实际路由或组件、证据（截图路径或可定位文字/DOM）、严重级 P0/P1/P2、视觉/交互差异、首次需要改的 web 文件、最小修复边界、验收标准。不要笼统说“不一致”。
6. 最后汇总为按实施顺序的批次（共享 tokens/layout → Access/Home → Radar/Signal → Issue → Meeting → Monthly Plan → 全局交互），并明确每批涉及文件与必须做的 screenshot 验收。

审计报告开头必须明确：当前为验收不通过；任何此前局部验证都不等于全页面像素级一致。完成后只在终端简短报告文件路径和 P0/P1 数量。
