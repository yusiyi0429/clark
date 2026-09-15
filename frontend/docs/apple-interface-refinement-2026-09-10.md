# CEO 工作台：Apple 风格精修

日期：2026-09-10。目标是适合键鼠和语音并用的 macOS 风格网页工作台，不模拟原生窗口，也不声称通过 Apple 官方设计认证。

## 参考与取舍

- 采用 [NutshellEngineering/apple-design-skill](https://github.com/NutshellEngineering/apple-design-skill) 作为 HIG 检索与设计审视参考。阅读其 SKILL.md 以及 Materials、Typography、Motion、Accessibility、Designing for macOS；只缓存参考文本，没有安装全局技能或执行仓库脚本。
- [Apple Materials](https://developer.apple.com/design/human-interface-guidelines/materials)：玻璃主要用于导航和控制层，正文使用清晰的标准材料。
- [Apple Motion](https://developer.apple.com/design/human-interface-guidelines/motion)：动效表达操作结果和空间关系，短促、可中断；支持减少动态效果。
- [Apple Typography](https://developer.apple.com/design/human-interface-guidelines/typography)：按语义组织字号，保留阅读正文的舒适尺寸。
- [Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos)：多窗格、键鼠交互和清晰的内容层级。
- 调研了 [rdev/liquid-glass-react](https://github.com/rdev/liquid-glass-react)。项目说明 Safari、Firefox 对折射支持有限；本轮没有引入它。现有 CSS 材质与动画足以表达所需关系，避免为了折射增加依赖。

## 已实施

1. 页面采用中性浅灰底、白色内容卡、发丝边框和小阴影；减少大面积渐变。系统字体栈不下载或捆绑 Apple 字体。
2. 左侧通知栏采用中性雾玻璃；紫、蓝、金继续表达通知类型和优先级。透明度与排序机制保留，正文对比度提高。选中通知右移，与右侧材料窗口的同色细线对应。
3. 首页只展示待决策事项的既有规则保持；议题悬停和选中获得轻量反馈。内部进入操作统一使用向右指示，不暗示外部跳转。
4. 雷达延续浅蓝扫描，统一圆角和边线。公司能力与战略区域采用同一套内容样式。
5. 重内容工作区：顶部控制层微透，材料区接近不透明，讨论区独立；蓝色突出正式提交，其他操作中性化。
6. 底部深色讨论框采用石墨色玻璃；选项、正式确认与普通意见保留形成明确主次，正式决定仍需明确点击。
7. 全局输入保持 48px 高度和小尺寸；语音与键盘共用同一水平基线，宽度切换缩短到 320ms。草稿、静音、输入焦点及中文输入法行为保留。
8. 关闭按钮去掉旋转；加入减少透明度和增强对比度的回退样式，保留减少动态效果支持。

## 验证

- TypeScript 与针对本轮 TSX 的 ESLint 通过。
- 浏览器验证：通知与三处对应议题同步、回复不等于决定、撤回、重窗口选中关系、修改后的材料进入对话上下文、草稿关闭/刷新恢复、完成后修改使核对失效，均通过。
- 输入区逐帧位置检查、连续快速切换、草稿保留、输入焦点、中文输入法 Enter、静音及减少动态效果检查通过。
- 查看 1440×900、1280×720 的主页与材料窗口截图，并检查 1024 和 390 宽输入区边界，无水平溢出。

对话上下文验证使用受控响应；本轮没有恢复语音供应商账户，也没有声称验证真实语音链路。所有决策和材料确认继续是本机演练，不向真实公司下发。
