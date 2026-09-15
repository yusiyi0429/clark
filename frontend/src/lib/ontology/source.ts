/**
 * 本体这一轮从哪儿取。
 *
 * `narrative` 是默认：memory-api 的 `/v1/context-graph/narrative`，一次往返拿一段
 * 装配好的叙述。`graph` 是原来那条：GraphKnowledge M7 的四个取数点加前端自己的配方。
 *
 * ## 为什么留着旧的那一支
 *
 * **不是回滚开关。** 两支产出的东西形状不同（旧的有可引的短码、有锚点相关性自检、有
 * S01/S02/S03 三种厚度，新的都没有），拨过去不是「回到上一版」，是换了一种材料。留着
 * 它的用处只有一个：拿同一个议题两边各跑一遍作对比 —— 换源之后报告变好还是变坏，
 * 除了对比没有别的办法答。（同 `TKOS_DR_V2` 那一支的口径。）
 *
 * ## 只有恰好等于 `graph` 才算切过去
 *
 * 留空、写别的值一律走 `narrative`。留空是「.env 里留了这一行没填值」，那不该被读成
 * 「要走旧路」—— 而旧路在没配 `TKOS_GRAPHKNOWLEDGE_BASE_URL` 的机器上是整条不通的，
 * 表现成每一次运行都就地失败。
 */
export type OntologySource = "narrative" | "graph";

export function ontologySource(): OntologySource {
  return (process.env.TKOS_ONTOLOGY_SOURCE ?? "").trim() === "graph" ? "graph" : "narrative";
}
