/**
 * 对齐自 tkos-lab/src/tkos_lab/graphknowledge/errors.py
 *
 * GraphKnowledge 的四种失败。**`AnchorNotFound` 必须在 `GraphKnowledgeError`
 * 之前判**：它继承自基类，先判基类会把一条正常分支吃成故障。
 *
 * 为什么要分这么细：`GraphKnowledgeUnavailable`（连不上）和 `AnchorNotFound`
 * （图里没这条）的结论完全相反。前者是一次停机，后者是「这条输入对公司现有
 * 方向来说太新」。混成一件事的后果是——图服务一挂，每次运行都悄悄降级成纯
 * 外部调研，还照样产出一份格式漂亮的报告，没人查得出来。
 */
export class GraphKnowledgeError extends Error {
  readonly detail: Record<string, unknown>;

  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.detail = detail;
  }
}

/** 显式传进来的业务锚点不存在（404）。 */
export class GraphKnowledgeNotFound extends GraphKnowledgeError {}

/** 参数不满足契约（400 / 422）。q 超 100 字就是这一类。 */
export class GraphKnowledgeRejected extends GraphKnowledgeError {}

/** 网络不通、地址没配、认证被拒、返回不可解析、服务端 5xx。**就地失败。** */
export class GraphKnowledgeUnavailable extends GraphKnowledgeError {}

/**
 * 按问题找不到该频道要的锚点。**这不是故障，是一条分支信号** ——
 * 调用方改走纯外部调研。绝不能由服务不可用折成这一条。
 */
export class AnchorNotFound extends GraphKnowledgeError {}
