# 02 C妹 接进产品，作为一种伙伴形象

Type: feature
Status: needs-triage
Blocked by: 孙铭泽说开始接入；Miles 的代码（`claude/handover-new-phase-review-c26739`）还没合进 main，要么等它合进去，要么在那条分支上做

## 要做的

文件路径都是交接分支上的：

1. **形象的画**：`.scratch/buddy-cmei/cmeiArt.ts` 放到 `apps/web/src/components/coagent/cmeiArt.ts`。它是生成的文件，以后改画还是改 `build.py` 再重新生成。
2. **转眼补丁**：`apps/web/src/components/coagent/milesRig.ts` 打上 `.scratch/buddy-cmei/milesRig-iris-gaze.patch`（转眼只移眼珠，Miles 不受影响）。
3. **rig 按形象传画**：
   - `milesRig.ts` 现在直接 import `MILES_ART`/`MILES_SVG`，改成由调用方传入画和摆位常量。C妹 的 `gazeUnit` 是 8，Miles 是 15。
   - 没起名字时胶囊上的默认字（`MILES_NAME`）也要按形象给，C妹 的是「C妹」。
   - 做法参考 `.scratch/buddy-cmei/tools/build-preview.cjs`：它把 rig 包成 `makeRig(ART, SVG)`，同一份动作代码挂两张画。
4. **组件**：
   - `MilesCapsule.tsx` 改成能挂不同的画（或者加一个很薄的 C妹 版）；
   - `PresenceCapsule.tsx` 现在是 `if (skin === "miles") return <MilesCapsule …>`，照样给 C妹 加一支；
   - 样式沿用 `apps/web/src/styles/coagent-miles.module.css`。
5. **形象清单**：`apps/web/src/components/coagent/skin.ts` 的 `CoAgentSkin` 和 `COAGENT_SKINS` 加一项（比如 `cmei`，读屏用的 label 写「C妹」）。
   - 选择页现在是两列四格，加上她是 5 格：要不要换掉某一种，问孙铭泽。
6. **契约**：
   - `packages/contracts/src/buddy.ts` 的 `BuddyForm` 加同一个值，再在 `apps/web` 跑 `pnpm gen:client` 重新生成 web 的 OpenAPI 类型。
   - 生成的 `apps/web/src/lib/api/openapi.json`、`schema.d.ts` 不手改。
   - API 那边看看是否有按形象值校验或存储的地方。
7. **小号入口会裁头顶**：`apps/web/src/styles/buddy-mark.module.css` 的 `.mark[data-place="entry"]` 对 Miles 有 `overflow: hidden`。C妹 的呆毛比框高约 7 像素，在这里会被切掉约 6 像素；给她单独的高度或缩放。
8. **测试**：
   - `milesCapsule.test.tsx` 对 Miles 的部件检查，照样对 C妹 跑一遍。部件、id 前缀、转轴、默认藏着的变体、眼珠裁切，见 `.scratch/buddy-cmei/check.cjs`。
   - 再跑 web 的 typecheck 和 test。

## 完成的标准

- 选择形象的格子里能选 C妹。选中后顶上的胶囊换成她，名字、在听和在说、耳机亮、转眼、放手都和预览页一致。
- Miles 的样子和动作完全不变：现有测试全过，Miles 的 DOM 和接入前逐字相同。
- 在真实页面里跑过：选择页、页头胶囊、小号入口三处都看过，截图留证据。

## Comments
