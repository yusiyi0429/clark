# 01 眨眼换成原图第 4 格的闭眼

Type: task
Status: needs-info
Blocked by: 孙铭泽在下面三种做法里选一种

## 现状

- **原图的闭眼**：第 4 格（闭眼笑）的眼睛已经切好，作为 `eye-l-closed`/`eye-r-closed` 放在 `cmeiArt.ts` 里，默认藏着。
- **rig 的眨眼**：milesRig 眨眼时只把 `eye-l`/`eye-r` 整只压扁再弹开（`scaleY(1 → 0.08 → 1)`，150 毫秒），从来不显示闭眼部件。
  - Miles 也是这样，他的闭眼部件同样看不到。
- **看起来的效果**：压到最扁那一下，C妹 的眼睛是一条带颜色的细线，看 `renders/glance.jpg` 的「眨眼一半」。

## 三种做法

| 做法 | 效果 | 代价 |
|-|-|-|
| A. 保持现在这样 | 和 Miles 一样压扁眨眼 | 看不到原图那双弯弯的闭眼 |
| B. 改 milesRig：压到最扁时换成闭眼部件，再弹开时换回来 | 每个形象都用自己画好的闭眼眨眼 | Miles 的眨眼也会变（他的闭眼部件是一道弧线） |
| C. 同 B，但只在画上标了的形象才换（比如 `eye-l` 上加 `data-blink="swap"`） | 只有 C妹 换成原图的闭眼 | rig 多一个判断，补丁多几行 |

## 选定以后

- **选 B 或 C**：改的是交接分支上的 `apps/web/src/components/coagent/milesRig.ts`。
  - 补丁合进 `.scratch/buddy-cmei/milesRig-iris-gaze.patch`，或者另起一个补丁文件。
  - `tools/build-preview.cjs` 会把补丁打到预览页里。
- **完成的标准**：
  - `tools/verify-page.cjs` 全部通过，并补一项：眨眼时闭眼部件真的露出来。
  - 预览页的「眨眼」那格换成闭眼的样子；`renders/` 重出。
  - 打补丁前后挂 Miles：选 C 时 DOM 逐字相同，选 B 时只有眨眼那一下不同。
  - 改动范围：只动眨眼，不碰转眼、说话和放手。

## Comments
