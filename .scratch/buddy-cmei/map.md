# C妹 伙伴形象：交接

更新：2026-11-04。决策人：孙铭泽。上一位：Claude Code 会话（2026-11-03—04）。

## 目标

把孙铭泽提供的「C妹」原图一比一做成天枢的一种伙伴形象：从名字小胶囊上沿探出半身，和现有的 Miles 用同一套动作代码。

## 现在到哪了

- **设计稿**：做完了，孙铭泽看过放大后的版本，没有新意见。
- **产品**：还没接进去。
- **代码**：在 `claude/charming-faraday-71mfnt` 分支，只动了 `.scratch/buddy-cmei/`；没开 PR。
  - 这条分支比 main 落后几个提交，但只碰 `.scratch/`，合并不会冲突。
- **在线预览**：https://claude.ai/artifact/Lzyo5LFWRoF33m4SD3LaBF
  - 是孙铭泽的私有页面，内容和本地 `preview.html` 相同。
  - 要更新：先用 Artifact 工具 `read` 这个链接，再把 `tools/build-preview.cjs --artifact <路径>` 写出的文件按这个 `url` 发布。
- **怎么做的、文件、命令、验证**：都在 `README.md`。

## 已经定了的（别改回去）

- **授权**：原图有授权，照原样用；头上那朵橙色的花也照原样保留（孙铭泽 11/03 确认）。
- **画法**：一比一，用原图的像素切成部件，不重画。只多画了右耳一只 AirPods，产品里「在听」时它会亮。
- **大小**：整体放大 15%，两只手整只搭在胶囊沿上露出来（11/03）。
  - 代价：头顶的呆毛比 66 高的框高出约 7 像素，这是接受了的。
- **转眼**：只移眼珠，靠 `milesRig-iris-gaze.patch`；Miles 的动作不受影响。
- **Mia**：另一个女生形象已经删掉，不要恢复。历史在提交 d605af2。

## 待办

| 票 | 事 | 状态 | 卡在哪 |
|-|-|-|-|
| [01](issues/01-blink-uses-closed-eyes.md) | 眨眼换成原图第 4 格的闭眼 | needs-info | 等孙铭泽在三种做法里选 |
| [02](issues/02-integrate-cmei-into-product.md) | 接进产品，作为一种伙伴形象 | needs-triage | 等孙铭泽说开始；Miles 的代码还没合进 main |

## 容易踩的

- **Miles 的代码只在交接分支**：`milesRig.ts`、`milesArt.ts`、`MilesCapsule.tsx` 只在 `claude/handover-new-phase-review-c26739`，main 上没有。
  - `tools/` 和 `check.cjs --ref` 都从这条分支读，先 `git fetch origin claude/handover-new-phase-review-c26739`。
- **眨眼看不到闭眼**：milesRig 眨眼只把睁着的眼睛整只压扁再弹开，从来不显示 `eye-l-closed`/`eye-r-closed`，Miles 也一样。
  - 所以画里的闭眼现在看不到，见票 01。
- **gazeUnit 不一样**：C妹 是 8，Miles 是 15；其余摆位常量和 `MILES_ART` 逐项相同。
  - milesRig 现在直接 import `MILES_ART`/`MILES_SVG`，接入时要改成按形象传入。
- **头顶会被小号入口裁**：产品里 `buddy-mark` 的 entry（小号入口）会裁掉框外的部分，她头顶会被切掉约 6 像素，接入时要处理。
- **生成的文件别手改**：`cmeiArt.ts`、`cmei.svg` 由 `build.py` 生成；`preview.html` 由 `tools/build-preview.cjs` 生成。
- **环境依赖**：
  - `build.py` 要 Pillow、numpy、scipy、scikit-image（`pip install`）；
  - `tools/` 要 TypeScript 和 Playwright，云端环境里都已经有。
- **天枢 MCP**：项目规定只在孙铭泽明确要求时才往天枢里写，这件事目前没有要求写。
