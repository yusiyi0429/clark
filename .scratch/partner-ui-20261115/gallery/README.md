# 伙伴工作间实际组件对照

双击 `review.html` 即可离线查看。无需终端、服务、登录或网络。顶部可切换五个场景、720px / 320px 组件视口、浅色 / 暗色；原生 `details` 折叠区保留。按钮、附件和对象链接统一停用，链接的原路由保留在 `data-fixture-href` 和标题中。

这是 **实际 React 组件的服务端渲染对照**。它不是截图，也不是完整 BuddyView 或外壳；没有运行应用 hydration、fetch、表单提交或生产记录。所有名字、内容、ID、URL 和错误均为合成样例。因为预览增加 `disabled`，部分按钮会显示原样式的禁用态。

对照基准为 Git `a1f365a1`；另一侧为生成时工作树源文件。`evidence.json` 记录生成时间、HEAD、各源文件 SHA-256、fixture 注入位置、场景折叠数量及 CSS Modules 类名匹配。`verification.json` 记录静态 / Node 校验结果。

证据中的 `targetSourceFiles` 明列目标模块与主题文件；`bundledSourceModules` 按 esbuild 输入记录所有间接导入的生产源码 SHA-256 与实际保留的字节数。`integrationModuleCoverage` 另外记录 Transcript / WorkTimeline 的最终源码 SHA-256 和是否进入构建图；未进入构建图的集成模块仅作出处记录，不表示本对照渲染或验证了完整时间线。

## 重建

从仓库根目录运行（仅用已安装依赖，不安装任何包）：

```powershell
node .scratch/partner-ui-20261115/gallery/build-gallery.mjs
node .scratch/partner-ui-20261115/gallery/verify-gallery.mjs
```

生成器使用 Git archive 将基准源码暂存到本目录，再用现有 esbuild / ReactDOM server / PostCSS / Tailwind 编译。CSS Modules 使用 esbuild 的 `local-css`，真实 class 与真实 CSS 一同打包；没有手画卡片或把样式模块替换为空对象。两版本均使用当前已安装的依赖，固定样例时钟为 2026-11-15 04:00 UTC。

实际渲染的生产组件为 `TeamDeliveryCard`、`PartnerMeetingInbox`、`MeetingWorkHandoffs`、`SubSessionSummary`、`WorkIntakeQueue`。会议列表 hook 由合成 feed 替身提供；交接和队列通过仅存在于打包内存中的状态初值替换取得样例列表。它们的 JSX、Hooks 和样式仍来自所选版本源码，生产文件不被修改。Workspace 导航上下文为无副作用替身。

生成中间项 `baseline-source/`、`baseline-source.tar`、`.build-before/`、`.build-after/`、`scenes-before.json` 和 `scenes-after.json` 不属于交付内容；无需跟踪或打开。自包含的 `review.html` 不依赖这些文件。

## 验证边界

构建检查 CSS 模块类名存在对应规则。独立校验检查嵌入 JSON、控制器脚本、40 份场景 / 视口 / 外观文档组合、控件停用、链接停用、原主题 / 暗色规则及无外部资产 URL。控制器只在 Node VM 中使用 DOM 边界桩执行。

没有浏览器控制工具，也没有安装或绕用浏览器自动化。尚未观察真实布局溢出、字体渲染、对比度、焦点可见性、深链滚动、网络刷新、回复和重试、手机触控、屏幕阅读器或真人理解。320px / 暗色切换是可供人工查看的预览能力，不等于这些场景已经通过验收。
