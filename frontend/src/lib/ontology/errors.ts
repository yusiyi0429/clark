/**
 * 本体这一层的失败。
 *
 * 只有一种：**取不到**。这和 GraphKnowledge 那一层分四种是有意分歧 —— 那边分得细，
 * 是因为它有「图里没这条锚点」这个**正常分支**要和故障分开（`AnchorNotFound`）；
 * 而叙述接口一个查询只有两种结局，取到或者没取到，没有第三种要分。
 *
 * 分不出来的那件事写在明处：叙述接口**不会说「公司没记过这条」**。这不是它的缺陷 ——
 * 它回的是**公司层的语义记忆**（愿景 / Outcome / Mission / 经营原则），那一层跟问什么
 * 无关，一直都在；而能回答「公司记过这条没有」的是**工作记忆**（议题 + 判断 + 共识），
 * 本体还没建到那一层。所以拿一句跟公司毫无关系的话去问，它照样回一整段（实测「日本
 * 北海道的滑雪场雪质如何」回 `hit_paths=2` 和 498 字）。
 *
 * 因此这一层没有 `AnchorNotFound` 的对应物 —— 不是漏写的，是那个信号在这个源上不存在。
 * 补救在 prompt 那一侧（`wrapCompanyNarrative`）和对谈的工具说明里：把「这一轮只有公司层，
 * 没有议题自己的历史」说清楚，而不是在这里按字数之类的判据伪造一个「没有」。
 */
import { GraphKnowledgeUnavailable } from "@/lib/graphknowledge";

export class OntologyError extends Error {
  readonly detail: Record<string, unknown>;

  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.detail = detail;
  }
}

/** 地址没配、认证被拒、网络不通、返回不可解析、服务端 5xx、正文是空的。 */
export class OntologyUnavailable extends OntologyError {}

/**
 * 两个源的「取不到」认成同一件事。
 *
 * 调用方（`company-context.ts` 那两扇门）要按它写那句「图服务不可达」还是「取本体出错」，
 * 而换源开关一拨，抛出来的类就换了一个。**两处各写一个 `instanceof` 的下场**是：切到
 * 叙述源之后，一次真的连不上会被归进「取本体出错」那一档 —— 两句话在日志里长得几乎一样，
 * 而要查的地方完全不同（一个查上游，一个查我们自己的解析）。
 */
export function isOntologyUnavailable(e: unknown): boolean {
  return e instanceof OntologyUnavailable || e instanceof GraphKnowledgeUnavailable;
}
