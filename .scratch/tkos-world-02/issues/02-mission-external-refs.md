# 02 · Mission 外部引用

Type: implementation
Status: ready-for-agent
Blocked by: 01

## 要做什么

给本体按天枢个人任务建的三个 Mission 写 `external_refs: [{system:"tianshu", id:"mission:<编号>"}]`，此后天枢一律按外部引用查回 Mission，不再维护对象 id 对照。

- 对照（本体重建时可能再变，按标题 + 负责人核对后写入，写完以查回为准）：`renhao-202610-b` → 「Ontology & Data Grounding」、`renhao-202610-c` → 「ENO / Engine Blueprint」、`siyi-202610-1` → 「可信 Context / Memory 与真实 Agent 读写闭环」。
- 写法：`world_revise_object`，只改外部引用这类活动属性，写入声明 `scene` = 该 Mission 对象引用、`human_acceptance.required=false`（示例 §2）。
- 提供一个幂等的一次性命令（`pnpm --filter @warmap/api world:link-missions`），实例重建后重跑；同一 `(system,id)` 已指向别的对象返回 409 时如实报错，不自动挪。
- 查回：`mission:<编号>` → Mission 头（供 03–07 使用），带进程内短缓存即可。

## 完成定义

- 桩测试按 §2 请求／返回；真实实例上三条都能按外部引用查回，重跑不产生新修订以外的副作用（同键重放）。
