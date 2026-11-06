/**
 * 回答里的出处（深度讨论 v2，docs/superpowers/specs/2026-10-10-discussion-desk-design.md「10/12 深度讨论 v2」；10/14 改成出处标记）：
 * 正文直接陈述，不先报文件名，句末也不再括号重复；出处写成 Markdown 链接 `[资料名称](地址)`，紧跟在它支撑的那一句末尾。
 * 前端（apps/web/src/conversation/citations.tsx）把句末位置的出处链接显示成一个很小的标记：电脑上悬停、手机上点一下，
 * 看资料名称、所在段落或版本与「打开原文」。
 * 地址：内部依据 `cite:<ref>`（ref 与会前预审、历史分层同一套，apps/web/src/cards/meetingSources.ts 的 parseSourceRef）；
 * 带网址的出处写原网址；没有引用标记也没有网址的写 `cite:source`（标记只显示名称）。追加在一号位对话系统提示词末尾。
 */

/** 链接地址的前缀，与前端解析同一口径。 */
export const CITATION_SCHEME = "cite:";
/** 没有引用标记、也没有网址的出处（看板摘要、只给了资料名的条目）：标记只显示资料名称。 */
export const NAMED_SOURCE_REF = "source";

export const SOURCE_CITATION_RULES = `# 出处的写法

正文直接陈述事实和判断，不用「《X》写明」「据《X》」开头，句末也不再括号重复资料名。出处写成 Markdown 链接 [资料名称](地址)，界面显示为一个很小的出处标记，悬停或点开才看到名称与原文。

地址：公司内部依据写 ${CITATION_SCHEME}<引用标记>，只能照抄工具结果或上下文给出的值，不能自己拼、不能猜：群材料与发言照抄 read_group_evidence 的 cite（某一段加 #p<段号>），历史决定照抄 read_decision_history 的 ref；议题研究 ${CITATION_SCHEME}research:<议题 id>，议题 ${CITATION_SCHEME}issue:<议题 id>，会议 ${CITATION_SCHEME}meeting:<会议 id>，本体公司事实照抄 query_company、read_ontology 给的 ref 写 ${CITATION_SCHEME}world:<ref>。出处带网址的写原网址；拿不准引用标记、又没有网址时写 ${CITATION_SCHEME}${NAMED_SOURCE_REF}。

位置：数字、日期、原话这类关键事实，链接紧跟在那一句末尾、句号之前；同一段里连续几句出自同一份资料，只在最后一句末尾放一个。名称里不写内部编号，正文里不解释这种写法。推断照常在正文里说明是推断（如「这是我的推断」），推断本身不挂链接。`;
