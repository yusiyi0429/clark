/**
 * 槽位解析搬到了 `src/lib/models/`（注册表 + 槽位 + 调用）。
 *
 * 这里留一层再导出，不是为了兼容而兼容：`a2` / `a6` / `a10` 与对话路径都从这个
 * 路径取符号，一起改 import 会把本轮的改动面扩到三个不在范围内的 agent 上。
 * 新代码请直接从 `@/lib/models/slots` 取。
 */
export {
  SLOT_ALIAS,
  areIndependent,
  assertSlotSanity,
  familyOf,
  resolveModel,
  type ModelConfig,
  type Slot,
} from "@/lib/models/slots";
