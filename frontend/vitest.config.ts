/**
 * vitest 只用来盯纯函数里的**阈值与断句规则**。
 *
 * 这些常量改了不会报错，只会让锚点选得越来越差、检索式被切在词中间 ——
 * 那种坏法没有任何症状，是单测最值钱的地方。渲染、路由、模型调用不进这里。
 *
 * **两类例外，理由是同一条**：那些坏法同样没有症状。
 *
 * 1. `src/components/advisor/blocks/render.test.ts`。它不测长相，测的是「十四种块每一种
 *    都画得出东西」和「半份 JSONL 不白屏」—— 白屏在屏幕上和「这一轮没跑出来」长得一模
 *    一样。它用 `react-dom/server` 出静态 markup，不需要 DOM 环境，所以 `environment`
 *    照旧是 `node`。
 * 2. 两条路由的入口：`src/app/api/data/route.test.ts`（身份与权限）与
 *    `src/app/api/chat/route.test.ts`（进不进议事对话那一路、装配对不对）。**测的不是
 *    渲染也不是模型**：上游一律打桩，跑的是那几段装配与把关。这两处装错了，屏幕上什么
 *    都不会少 —— 一条本该走对谈的对话悄悄走了旧路，看起来只是模型今天没挑战他。
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // vitest 不读 tsconfig 的 paths，别名要在这里再说一遍。
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
