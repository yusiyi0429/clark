// 生成填充条目：同一个虚构人物在各话题下的其他想法，让记忆量到 300 条左右、并带同话题的近似干扰。
// 用法：node gen-fillers.mjs [模型]   输出 data/fillers.json
import { writeFileSync } from 'node:fs';
import { complete, parseJson, pool } from './llm.mjs';
import { TARGETS } from './data/targets.mjs';

const model = process.argv[2] ?? 'claude-opus-5-5';
const PERSONA = `虚构人物：林舟，远帆智能 CEO。公司约 400 人，卖门店收银终端（硬件 OEM）+ SaaS（收银、会员、进销存）给县城和社区的夫妻店、便利店、母婴店、烘焙店；渠道有省级经销商、县城本地服务商和自有直销；新产品线「店长助手」（AI，补货建议等）；正在准备 C 轮；在考虑东南亚出海。CTO 叫老周，销售 VP 叫陈蔓，CFO 叫许清，HRVP 叫阿梅。主要竞品：收钱吧、美团商家版、有赞。时间是 2026 年 8 月初到 10 月中旬。`;

const CLUSTERS = [
  ['渠道下沉、县域市场、样板县', 'topic:渠道下沉 / topic:县域市场 / topic:下沉', 12],
  ['销售团队与销售管理', 'topic:销售团队 / topic:销售管理', 10],
  ['经销商与服务商体系', 'topic:经销商 / topic:服务商', 10],
  ['定价与套餐', 'topic:定价 / topic:套餐', 8],
  ['店长助手（AI 产品）的功能、体验与路线', 'topic:AI助手 / topic:店长助手 / topic:产品路线', 12],
  ['融资与投资人关系', 'topic:融资 / topic:投资人沟通', 8],
  ['现金流与预算', 'topic:现金流 / topic:预算', 8],
  ['招聘与人才', 'topic:招聘 / topic:人才', 8],
  ['组织架构与管理层', 'topic:组织 / topic:组织架构 / topic:管理层', 8],
  ['会议、周会、决策机制', 'topic:周会 / topic:会议 / topic:决策', 6],
  ['复盘与目标管理', 'topic:复盘 / topic:目标管理', 6],
  ['续费与客户成功', 'topic:续费 / topic:客户成功', 10],
  ['出海（东南亚）', 'topic:出海 / topic:海外', 8],
  ['竞品与竞争', 'topic:竞品', 8],
  ['品牌与市场投放', 'topic:品牌 / topic:市场', 8],
  ['硬件与供应链', 'topic:硬件 / topic:供应链', 8],
  ['激励与薪酬', 'topic:激励 / topic:薪酬', 6],
  ['合伙人与高管团队', 'topic:合伙人 / topic:高管团队', 6],
  ['本人的工作方法与时间安排（做法，不是表达偏好）', 'topic:时间管理 / topic:工作方法', 6],
  ['2027 规划与公司战略', 'topic:2027规划 / topic:战略', 8],
  ['合规、数据安全与隐私', 'topic:合规 / topic:数据安全', 6],
  ['大客户与区域连锁', 'topic:大客户 / topic:KA', 6],
  ['数据与经营看板', 'topic:数据 / topic:经营看板', 8],
  ['门店实施、店员培训与门店运营', 'topic:门店运营 / topic:培训', 8],
  ['研发效率、发布节奏与产品质量', 'topic:研发 / topic:产品质量', 8],
  ['企业文化与内部沟通', 'topic:文化 / topic:内部沟通', 6],
  ['个人学习与阅读', 'topic:学习 / topic:阅读', 4],
];

const allTitles = TARGETS.map(([, , , , title, text]) => `${title}：${text}`).join('\n');
const PROMPT = `你在为一个记忆检索评测造数据。模仿「后台从本人聊天里提炼出的个人记忆条目」的写法：每条是本人自己的一个想法（idea）、立场（stance）、未决问题（open_question）、理由（reason）或做法（practice，做事的固定方法和步骤）。
要求：
- 每条只讲一个具体的点，有具体细节（数字、对象、条件、理由），像本人在聊天里说过的话被整理出来；拿不准的用「倾向」「可能」，未决问题写清两难在哪。
- 和「已有条目」讲的点不能重复，也不能是它们的换个说法或细化；同一话题下讲别的方面。
- 各条之间也不要重复。kind 混合，open_question 和 practice 各占一些。
- title 不超过 16 个字；text 20 到 90 个字，第一人称省略主语（像「倾向…」「还没想好…」「每周…」）。
- date 在 2026-08-03 到 2026-10-15 之间，分布开。anchor 从给定的 topic 里选一个照抄。
- 只输出 JSON 数组：[{"kind":"…","title":"…","text":"…","date":"YYYY-MM-DD","anchor":"topic:…"}]`;

const results = await pool(CLUSTERS, 6, async ([theme, topics, count]) => {
  const input = `${PERSONA}\n\n已有条目（全部话题，不要重复这些点）：\n${allTitles}\n\n这次的话题：${theme}\n可用 anchor：${topics}\n请生成 ${count} 条。`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await complete({ model, instructions: PROMPT, input, maxOutputTokens: 12000 });
    const items = parseJson(result.text);
    if (Array.isArray(items) && items.length >= count - 1) {
      console.log(theme, items.length, Math.round(result.ms), 'ms');
      return items.slice(0, count).map((item) => ({ ...item, cluster: theme }));
    }
    console.log(theme, 'retry', result.text.slice(0, 120));
  }
  return [];
});
const fillers = results.flat().map((item, index) => ({ id: `f${String(index + 1).padStart(3, '0')}`, ...item }));
writeFileSync(new URL('./data/fillers.json', import.meta.url), JSON.stringify(fillers, null, 1));
console.log('fillers', fillers.length);
