/**
 * 这一场的议程，和它怎么变成模型看得见的材料。
 *
 * `demo/agenda.json` 是直接 import 进来的，不是 fetch 的。两个理由：
 *
 * 1. 会议室的网可能是别人家的。议程如果要发一次请求才拿到，网一抖开场就是空屏 ——
 *    而开场那一帧是整场里唯一不能出问题的一帧。编译进 bundle 之后它跟代码一起到。
 * 2. `scripts/pregen-tts`（M2 的预合成）读的是同一个文件。同一份文稿两处读，一处是
 *    import 一处是 fs，比维护两份要好。
 *
 * 语料是另一回事：文档正文在数据层（`api.getDoc`）里，不在这个文件里。议程只装
 * 「讲哪几件事、按什么顺序、每件事说什么」，正文照旧从对象库取 —— 这是双模式同源的
 * 落点：手动模式点开的那份文档，和投影上打出来的那句引文，是同一份正文。
 */

import type { Doc } from "@/lib/data/types";
import type { Agenda, AgendaEvidence, AgendaItem } from "@/lib/stage/events";

import raw from "../../../demo/agenda.json";

export const AGENDA = raw as Agenda;

export const agendaItem = (id: string): AgendaItem | undefined =>
  AGENDA.items.find((i) => i.id === id);

export const agendaEvidence = (
  id: string,
): { evidence: AgendaEvidence; item: AgendaItem } | undefined => {
  for (const item of AGENDA.items) {
    const evidence = item.evidence.find((e) => e.id === id);
    if (evidence) return { evidence, item };
  }
  return undefined;
};

/** 议程里引到的每一份文档，去重。语料就取这几份，不多取。 */
export const agendaDocIds = (): string[] => [
  ...new Set(AGENDA.items.flatMap((i) => i.evidence.map((e) => e.docId))),
];

/**
 * 议程写给模型看。
 *
 * 序号、`item_id`、`evidence_id` 必须都在，它们是模型点亮屏幕的唯一钥匙。口播文稿也
 * 给它 —— 不是让它照读（照读就成了念稿），是让它知道这件事该讲到什么深度、多长。
 */
export function agendaOutline(agenda: Agenda = AGENDA): string {
  const lines: string[] = [`这一场叫「${agenda.sessionTitle}」，共 ${agenda.items.length} 件事。`];
  lines.push("", `开场就说这一句：${agenda.opening}`);

  agenda.items.forEach((item, at) => {
    lines.push(
      "",
      `第 ${at + 1} 件（item_id=${item.id}）：${item.title}`,
      `  ① 发生了什么：${item.fourParts.what}`,
      `  ② 为何现在重要：${item.fourParts.whyNow}`,
      `  ③ 影响哪条战略：${item.fourParts.impacts}`,
      `  ④ 建议动作：${item.fourParts.suggestion}`,
      `  口播（照这个长度和深度讲，可以换说法，不要照读）：${item.script}`,
      `  这件事的证据（讲到它们之前先调 show_evidence）：`,
    );
    for (const e of item.evidence) {
      lines.push(`    evidence_id=${e.id}，出自 ${e.docId}「${e.quote}」（${e.source}）`);
    }
  });

  lines.push("", `全部讲完之后，收尾说这一句：${agenda.closing}`);
  return lines.join("\n");
}

/**
 * 语料全文。
 *
 * 整批塞进上下文，不建索引 —— demo 规模是五份文档，而索引会引入「检索没命中」这种在
 * 会上没法解释的失败。段落前面加序号，是为了它调 `open_document` 时能给出准确的 anchor。
 */
export function corpusText(docs: Doc[]): string {
  return docs
    .map((doc) => `--- ${doc.id}《${doc.title}》${doc.mirrorOf ?? ""} ---\n\n${doc.body}`)
    .join("\n\n");
}
