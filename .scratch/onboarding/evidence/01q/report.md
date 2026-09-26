# 01q 减少透明度回退

已完成，待 Claude 验收、提交。生产修改仅为两处 CSS 规则，新增一个样式契约测试文件；其他组件只读排查。没有 git 写操作，没有修改依赖清单或 lockfile，没有读取密钥。

## 修改与测试

- `apps/web/src/components/onboarding/foundation.module.css:84` 的 `.glass`。
- `apps/web/src/styles/access.module.css:53` 的 `.codeCell, .passwordField`。
- 两处 reduced-transparency 规则均以 `--onboarding-blur: 0px; --onboarding-sat: 100%;` 替换两条 `backdrop-filter: none` 声明；实心 `background: var(--morning-start)` 保留。100% 是饱和度的中性值。基础规则未改，标准及 WebKit 属性都继续引用这两个变量。
- 新增 `apps/web/src/styles/reduced-transparency.test.ts`：参数化覆盖两个文件，检查目标选择器、两种基础属性均引用变量、媒体查询内变量归零／中性化、实心背景保留，避免回到会被去重的 none 写法。标准与前缀声明按完整声明分别匹配，不能用前缀声明冒充标准声明。

| 检查 | 结果 | 证据 |
|---|---|---|
| 新契约对旧规则 | 2 项失败，缺少局部变量覆盖 | [contract-red.log](contract-red.log) |
| `pnpm --filter @warmap/web typecheck` | 退出码 0 | [typecheck.log](typecheck.log) |
| `pnpm --filter @warmap/web test` | 37 文件、291/291 通过，含新增 2 项 | [web-test.log](web-test.log) |
| `git diff --check` | 通过 | 最终检查，无空白错误 |

registry 的 `Unsupported Card kind: mystery` 为已有预期 stderr，测试通过。消融检查：只保留两处变量覆盖和直接验证该契约的测试，没有新抽象、运行时分支或依赖。

## 编译与计算样式证据

使用 **Next 16.3.5 / Turbopack dev** 和 **Chrome 154.0.8037.57**；按工单允许的 dev 编译产物路径验证，未额外运行 next build。`apps/web-01q` 与 `apps/web` 同层，src/public 真实复制，node_modules 为 junction。未复制 .env。副本专用 `/evidence-01q` 页面直接导入原 CSS Modules，通过真实布局的 globals.css 提供晨光 token；不需要 API、登录或数据库。此项是实际编译样式的隔离验证，不宣称重跑完整登录／引导业务旅程。

旧源码先复制到副本，取得旧结果后，仅同步修复的两个 CSS 再验证。最终副本的 **42 个 CSS 文件与原目录逐个字节一致**，见 [source-verification.json](source-verification.json)。辅助页面只在副本生成，留档见 [fixture-page.tsx.txt](fixture-page.tsx.txt)、[prepare-preview.cjs](prepare-preview.cjs)。

编译前后原始响应：[before-0.css](before-0.css)、[after-0.css](after-0.css)；媒体查询摘录：[compiled-reduced-transparency.log](compiled-reduced-transparency.log)。旧规则编译后只剩 `-webkit-backdrop-filter: none`。修复后实际输出为：

```css
@media (prefers-reduced-transparency: reduce) {
  .foundation-module__nxPOlq__glass {
    background: var(--morning-start);
    --onboarding-blur: 0px;
    --onboarding-sat: 100%;
  }
}
@media (prefers-reduced-transparency: reduce) {
  .access-module__XWqvtq__codeCell, .access-module__XWqvtq__passwordField {
    background: var(--morning-start);
    --onboarding-blur: 0px;
    --onboarding-sat: 100%;
  }
}
```

[browser-check.cjs](browser-check.cjs) 使用已安装的 Playwright 启动独立无头 Chrome，调用 CDP `Emulation.setEmulatedMedia`，传入 `prefers-reduced-transparency: reduce`／`no-preference`，并断言 `matchMedia` 与请求一致。分别在 1440×900、375×900 读取三个元素的 `getComputedStyle`：

| 条件 | 引导 `.glass`、锁屏 `.codeCell`、`.passwordField`（三者相同） |
|---|---|
| 修改前，普通／减少透明度 | `blur(40px) saturate(1.4)` |
| 修改后，普通模式 | `blur(40px) saturate(1.4)` |
| 修改后，减少透明度 | **`blur(0px) saturate(1)`** |
| 前后减少透明度的背景 | **`rgb(247, 249, 252)`** |

两个宽度全部通过。浏览器报告标准属性支持为 true，WebKit 属性支持为 false，吻合旧回退失效原因。HTTP 200、页面有可见内容和输入框、无 Next 错误遮罩、无 pageerror。证据：[before-computed.json](before-computed.json)、[after-computed.json](after-computed.json)、[browser-before.log](browser-before.log)、[browser-after.log](browser-after.log)、[样式夹具截图](after-fixture.png)。截图仅用于确认服务渲染正常，媒体查询结论以 CDP 和计算样式为准。

## 全站只读排查

扫描 `apps/web/src` 全部 CSS，见 [site-source-scan.log](site-source-scan.log)。相关模块在同一 Next 编译链中导入；结论基于原始编译响应和浏览器读数，不依据源码猜测。**并非所有相邻的两条 none 都失效，声明顺序有影响。**

以下 **4 个既有文件的减少透明度回退确实丢失标准关闭声明**，编译后仅剩 `-webkit-backdrop-filter: none`：

| 文件（均在 `apps/web/src/styles/`） | 受影响选择器 | 当前隔离模块的实际表现 |
|---|---|---|
| `confirm-dialog.module.css:9` | `.dialog`、`.backdrop` | 基础 blur 同样被去重成仅 WebKit；普通／reduce 都为 none |
| `anchor-editor.module.css:13` | `.dialog`、`.backdrop` | 同上，普通／reduce 都为 none |
| `conversation-dock.module.css:129` | `.dock`、`.layer .caption` | dock 基础无 backdrop blur；caption 的基础 blur 也仅剩 WebKit；两种偏好都为 none |
| `app-shell.module.css:101` | `.sheet` | 当前 sheet 基础无 backdrop blur，两种偏好都为 none；同条媒体查询的 `.expandedHeader` 使用标准单声明，编译后两种声明均在，30px → none 正常 |

这些规则存在同类编译缺陷，但上述实际读数**不是“减少透明度仍有模糊”**。为独立确认它们无法覆盖来自其他规则的标准属性，额外注入低优先级 `:where(#id) { backdrop-filter: blur(9px) }` 做级联探针：四个文件的七个目标在 reduce 下仍为 9px；有效的 expandedHeader、notifications 等回退则能归 none。探针与自然计算样式分开保存在 `after-computed.json` 的 `cascadeProbes` 和 `states`，**9px 是人工诊断输入，不是产品现象**。探针针对元素本身，涉及 `::before` 的模块应看 `states` 的伪元素读数，不使用该探针对宿主的结果作结论。

下列既有减少透明度规则**没有复现同类失效**，标准 none 保留，计算样式有效：

| 文件 | 计算样式，普通 → reduce |
|---|---|
| `notifications.module.css:73` | `.glassHeader` 30px／1.3 → none；`.railClock .homeCapsule`、`.railLock button` 原为 none，级联探针也能被归 none |
| `account-menu.module.css:126` | `.popover.popover` 24px／1.8 → none |
| `header-capsule.module.css:247` | `.scope .ts-detail-header::before` 14px／1.7 → none |
| `conversation-column.module.css:432` | `.header::before` 12px／1.4 → none |
| `meeting-header.module.css:196` | `.capsule` 14px／1.7 → none |
| `material-tabs.module.css:112` | `.bar` 14px／1.7 → none |
| `monthly-workspace.module.css:108` | `.workspace` 26px／1.08 → none；`.header` 当前基础标准 blur 已丢失，但 reduce 的标准 none 保留 |

胶囊验证使用现有 `conversation-column.host` 作为祖先，提供真实 `--glass-blur` token，没有在样式中造一个默认值。前六项采用 WebKit 在前、标准在后的源声明顺序；monthly-workspace 的 reduce 仅写标准属性。这些编译后都保留标准关闭声明。

另外两处同类去重发生在**非 reduced-transparency** 规则，也仅记录：`conversation-dock.module.css:191` 的移动中 `.dock`，以及 `monthly-workspace.module.css:136` 的手机 `.commitArea`（后者为第 5 个具有同类编译缺陷的既有文件）。两者标准 none 均丢失；当前基础自然值均为 none，手机 commitArea 的 9px 级联探针无法被关闭。`header-capsule.module.css:50–51` 的普通双声明关闭和 `home-board.module.css:66` 的标准单声明关闭则保留标准 none。仅更换底色而没有关闭声明的其他规则不属于本单同类去重问题。

**上述所有既有文件均未修改。** 后续如修复，应同时检查普通模式的基础声明，不能把自然计算值 none 当成回退已有效的证明。

## 环境限制、异常与清理

- agent-browser CLI 在当前 PATH／已检查的安装位置不可用，改用机器已安装的 Playwright＋Chrome，未新增依赖。最初 `Start-Process` 启动命令被自动审批检查拒绝，仅返回 blocked by policy；随后用工具管理的前台 exec 会话完成服务验证。
- 副本放在 `apps` 同层后，pnpm 把它也识别成 `@warmap/web` 工作区，首次类型／测试命令触发自动依赖检查并尝试 install，因副本没有 vendor tgz 而失败。保留 [类型检查环境失败](typecheck-preview-conflict.log)、[测试环境失败](web-test-preview-conflict.log)。Ctrl-C 后 Next 子进程仍监听，清理保护检查正确拒绝删除；核实归属后只停止本次 PID 41080、64916 及其四个 PostCSS 子进程。移除副本后，要求的两条原始 pnpm 命令重跑全部通过；没有手工执行 install，没有修改依赖清单／lockfile。
- 仅使用 3600；4600 仅作为隔离代理目标，未启动 API。未创建临时数据库。浏览器每次在 finally 中关闭。
- 先验证绝对路径和链接类型，非递归断开 node_modules junction，再检查无其他链接后删除副本。清理脚本和结果：[cleanup-preview.ps1](cleanup-preview.ps1)、[cleanup.log](cleanup.log)。原 src/public/node_modules 保留，3600／4600 无监听，本次服务及四个子进程不存在。
- 3100／4000 PID 22856、3200 PID 58088、4100 PID 63752 前后不变；3400／4400 前后均未监听。没有停止他人服务。基线见 [ports-before.json](ports-before.json)。
