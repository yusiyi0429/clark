/**
 * 页面目录：首页对话在每个二级页面都开着，本人在哪个页面问，转给 Chat 的这一轮就带上这页的名字和说明
 * （CHAT_PAGE_CONTEXT=1 才带，见 chatService）。说明写给 Agent 用来指导本人：这页做什么、主要怎么操作、结果去哪。
 * 按页面路径匹配；首页（/me、新首页 /me/work）不带（首页的内容 Chat 自己读首页卡），不挂对话的页面（雷达列表、我的雷达、成员信号详情、成员战场详情、配置页）不收。
 * Task 页不在目录里，按本人读到的这个 Task 现算（V2 设计第 10 节兜底：新 Chat 还不认 Task 锚点时，从 Task 页发的每一句带上这个 Task）。
 * Chat 的 page 字段：title ≤ 40 字、guide ≤ 150 字（10/29 人豪定），超了整轮会被拒，测试里卡住。
 */
import type { TCardStage } from "@warmap/contracts";

export type PageGuide = { path: string; title: string; guide: string };

const GUIDES: { patterns: RegExp[]; title: string; guide: string }[] = [
  {
    patterns: [/^\/me\/task-quality$/, /^\/task-quality$/], title: "任务数据质量",
    guide: "核对一项任务在本体里的数据缺口。选任务和核对周期，点「现在核对」看缺什么及依据；在「新增一项补齐草稿」填字段、拟值和原文依据后保存，这只是草稿、没写进本体。可「复制给个人 Agent」由你确认后写入，再填回执编号核对。",
  },
  {
    patterns: [/^\/radar\/signals\/[^/]+$/], title: "信号详情",
    guide: "读公司雷达的一条外部信号：来源、总结、对公司的影响和原文摘录，可去原网页读全文。可收藏、标已读或未读，或点「不再出现在阅读列表」隐藏它（能撤销）。左上返回信号列表。",
  },
  {
    patterns: [/^\/progress$/], title: "全局进展",
    guide: "CEO 看全公司执行进展，先找问题。上面是各战场汇总；「红线」列慢了、做不完、过截止或没核实进展的事项，「按人」看没有任务基线的人的周复盘和进展，「按计划」是正常推进的。从首页战场栏的「全局进展」进入。",
  },
  {
    patterns: [/^\/me\/progress$/], title: "战场进展",
    guide: "成员看所在战场本月进展：战场汇总、本月目标和盘点数字。「需要搭把手」列卡住、做不完或过截止的事，可直接「约会议」「发请求」或「看看」；「大家在推进什么」每人一张卡，你排第一。",
  },
  {
    patterns: [/^\/me\/memory$/, /^\/memory$/], title: "我的记忆",
    guide: "管理 Agent 记住的关于你的事，分偏好、做法、想法与立场、没定的问题四组。点正文可改后保存；「⋯」里可忘掉（能恢复）或彻底删除。「导入」可从 ChatGPT 或 Claude 导入记忆，逐项确认后导入。入口在个人菜单。",
  },
  {
    patterns: [/^\/me\/schedules$/, /^\/schedules$/], title: "定时任务",
    guide: "列出和你有关的定时任务，按「收集」「其他」分组，写节奏、下次时间和所在设备。点一行看最近一轮；每周的收集任务可「停用」，要再按一次确认。这里不能新建定时任务。入口在个人菜单。",
  },
  {
    patterns: [/^\/me\/requests$/, /^\/requests$/], title: "请求",
    guide: "请求（传话）列表，像收件箱：切换「收到的 / 发出的」，点「新请求」发起一条。每行写对方、时间和状态（草稿、待处理、进行中、已完成），有人提问会标出。点一行进详情处理。会后影响卡、文档变更、信息收集也在这里。",
  },
  {
    patterns: [/^\/me\/requests\/new$/, /^\/requests\/new$/], title: "新请求",
    guide: "发起一条请求：在「请谁做什么」写一句话，点「起草」由 Agent 起草，拿不准的列在「要你定」里，回答后重写。看预览确认收件人和正文，点「发送」才发出，之前都是草稿。对方在「请求」的「收到的」里看到。",
  },
  {
    patterns: [/^\/me\/requests\/(?!new$)[^/]+$/, /^\/requests\/(?!new$)[^/]+$/], title: "请求详情",
    guide: "一条请求的详情。普通传话：接收人做完点「标记完成」，可提问，发起人回答。会后影响卡：可点「知道了」「和我无关」或追问 Agent。文档变更：选修订或取代后确认。信息收集：在「我这一行」填写后「确认完成」，发起人看每人状态。",
  },
  {
    patterns: [/^\/me\/tasks\/new$/], title: "开启执行事项",
    guide: "新建一件执行事项，三步：写标题；选推进哪个 Mission（可再选 Task，也可不挂）；选开始、截止和完成标准。最后点「开启执行事项」，建好后进入详情页。入口在首页 Mission 卡右上。",
  },
  {
    patterns: [/^\/me\/tasks\/(?!new$)[^/]+$/], title: "执行事项",
    guide: "一件执行事项的详情：状态、所属 Mission、推进人、截止和参与人。可「写一条进展」、上传材料或起草文档、补完成标准、「邀请协作」。推进人点「验收」逐条对完成标准，全部达到才能完成，否则退回。「⋯」里可编辑、退回、重新打开、删除。",
  },
  {
    patterns: [/^\/issues\/[^/]+$/], title: "议题",
    guide: "一个待决策议题的工作页，看 AI 预研的判断、备选方案和依据，可「追问这条判断」。决定在会议页的议题决定里做，已记的决定可在这里撤回。可邀请成员进议题群聊，「更多操作」里可加入已有会议或移出议题；预研失败可重试。",
  },
  {
    patterns: [/^\/me\/issues\/[^/]+$/], title: "议题",
    guide: "成员看一个议题的只读页：来源、预研状态和紧急程度；「总结与判断」里有决策时机、当前判断和备选方案，「研究与依据」看材料。可「追问这条判断」，已上会时点会议引用进入会议页。成员不能在这里做决定。",
  },
  {
    patterns: [/^\/meetings\/[^/]+$/], title: "会议",
    guide: "一场会议的工作页：会前看 AI 预审和材料，可编辑会议、请求补充材料、重新预审；会中进入飞书会议。会后看进度和会议卡：决策由责任人确认，行动项由负责人接下或退回。拿不到妙记时可贴妙记链接或上传会议记录。",
  },
  {
    patterns: [/^\/me\/meetings\/[^/]+$/], title: "会议",
    guide: "成员看一场会：会前看目的和材料，会中可进入飞书会议，会后看会议卡和记录原文。决策只有责任人能确认，行动项由负责人接下或退回。主持人或建会人还能结束、改期、取消会议，贴妙记链接或上传会议记录。",
  },
  {
    patterns: [/^\/me\/mission-cards\/[^/]+$/, /^\/mission-cards\/[^/]+$/], title: "任务卡",
    guide: "一个人本月的任务卡，列他在这个战场本月推进的 Mission 和关联的执行事项，可切换看同战场其他人的卡。本人在准备阶段点「确认我的任务」。选中文字可批注、引用并对话或让 Agent 修改；定稿后发现不对可「申请更正」，由拍板人决定。",
  },
  {
    patterns: [/^\/battlefields\/[^/]+$/], title: "战场",
    guide: "CEO 看一个战场，页头切换「决策 / 战况」。决策：负责人最新反馈、本战场待决策议题、战场目标和战役。战况：本月 Mission 和成功证据，按负责人列进展和里程碑，以及普通待办和负责人反馈。只列有来源的内容，不算完成率。",
  },
  {
    patterns: [/^\/me\/weekly-reviews\/[^/]+$/, /^\/weekly-reviews\/[^/]+$/], title: "周复盘",
    guide: "一个人一周的周复盘，六段：总体判断、关键进展与证据、最重要的问题、判断变化、当前处理、下周重点。本人点「生成」让 Co-Agent 起草，逐段修改保存后「提交」，提交后同战场的人和 CEO 可见；别人只读。入口在通知栏「周复盘」。",
  },
  {
    patterns: [/^\/me\/reviews\/personal\/[^/]+$/, /^\/reviews\/personal\/[^/]+$/], title: "个人复盘",
    guide: "一个人的月度个人复盘，对照本月 Mission 写四部分：总体结果、关键经营判断、下周期重点、待上层决策事项。本人点「生成」让 Co-Agent 起草，逐段修改保存，「提交前核对」后点「提交复盘」。右边可和自己的 Agent 对话、上传材料。CEO 只读。",
  },
  {
    patterns: [/^\/me\/reviews\/items\/[^/]+$/, /^\/reviews\/items\/[^/]+$/], title: "复盘项",
    guide: "月末复盘里一个战场或能力域的复盘项：左边本月目标和四栏自评，负责人可修改、保存、提交；右边 Agent 的改写建议要点「采用」才写入。「Co-Agent 偏差评估」列偏差和 CEO 可能问的问题。CEO 在这里确认或打回，参与者可在讨论区补充。",
  },
  {
    patterns: [/^\/reviews\/[^/]+\/ltco$/], title: "长期目标审视",
    guide: "月末复盘后决定长期目标要不要改：公司和各战场的长期目标逐项选「保持不变」或「修订」，可采用 Co-Agent 的建议或自己改。最后确认并生成下月目标，进入月度计划。须先确认公司复盘。",
  },
  {
    patterns: [/^\/reviews\/[^/]+$/], title: "月末复盘",
    guide: "CEO 的月末复盘总览：按战场和能力域列复盘项和 Co-Agent 评估，逐项确认或打回，点一行进复盘项。全部确认后由 Co-Agent 汇总公司月度复盘，可修改后「确认公司复盘」，再点「审视公司长期目标」继续。",
  },
  {
    patterns: [/^\/missions$/], title: "Mission 总览",
    guide: "CEO 看所有月度 Mission 的总表：上方是 Mission、负责人、战场、能力域的计数，「筛选」可按周期、战场、能力域、负责人过滤，点一行进 Mission 详情。要改内容点「管理 Mission」去 Mission 配置。",
  },
  {
    patterns: [/^\/missions\/[^/]+$/], title: "Mission 详情",
    guide: "一条 Mission 的只读详情：唯一负责人、能力域、关联战场、月度计划状态和来源，下面是成功证据、关键里程碑、依赖、风险、边界和来源追溯。有个人任务卡时可点进去。不显示进度；要改去组织配置的 Mission 配置。",
  },
  {
    patterns: [/^\/plans\/[^/]+$/], title: "月度计划",
    guide: "某月的月度计划，CEO 在这里核对并签发：公司结果、各战场结果、各能力 PO、普通待办、DRI 反馈和备注。每块勾「已核对」，改完「保存计划」，也可重新生成（会覆盖改动）。全部核对后勾确认并「签发计划」，各战场的人随后拿到本月任务卡。",
  },
  {
    patterns: [/^\/capabilities$/], title: "公司能力",
    guide: "CEO 看公司各能力域：最上面是能力相关的待决策议题，下面每个能力域写支撑哪些战场、六个月目标、本月目标和本月归属的 Mission，点进对应页面。只读，要改去组织配置的能力管理。从首页「公司能力」卡进入。",
  },
  {
    patterns: [/^\/me\/admin$/, /^\/admin$/], title: "管理员",
    guide: "管理员看天枢的运行和使用情况，入口在个人菜单的「设置」。「运行」：红黄绿计数、每个人各数据来源的状态（可提醒重新授权）、失败列表（可接手、解决、重试）。「使用」：每周使用周报，可复制或下载。不显示对话正文。",
  },
];

export function pageGuide(path: string): PageGuide | null {
  const entry = GUIDES.find((item) => item.patterns.some((pattern) => pattern.test(path)));
  return entry ? { path, title: entry.title, guide: entry.guide } : null;
}

/** Task 页的 Task id：本月页点进去是 /me/month/tasks/<id>，新首页的对话锚到一个 Task 时是 /me/work/tasks/<id>。不是 Task 页为 null。 */
export function taskOfPage(path: string): string | null {
  const match = /^\/me\/(?:month|work)\/tasks\/([^/]+)$/.exec(path);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}

/** 本人读到的这个 Task：名字、几条标准；cards 是看板上各列几张卡，看板只给 Task 负责人，不是负责人为 null。 */
export type TaskPageFacts = { name: string; criteria: number; cards: Record<TCardStage, number> | null };

export function taskPageGuide(path: string, facts: TaskPageFacts): PageGuide {
  const cards = facts.cards ? `看板上待开始 ${facts.cards.todo} 张、进行中 ${facts.cards.doing} 张、验收中 ${facts.cards.review} 张、已完成 ${facts.cards.done} 张。` : "";
  return { path, title: `Task：${facts.name}`.slice(0, 40),
    guide: `本人在这个 Task 的页面，说的事默认指这个 Task。它有 ${facts.criteria} 条验收标准；${cards}`.slice(0, 150) };
}

/** 项目页（第 16 节）的项目 id：/me/work/projects/<id>。不是项目页为 null。 */
export function projectOfPage(path: string): string | null {
  const match = /^\/me\/work\/projects\/([0-9a-f-]{36})$/.exec(path);
  return match ? match[1] : null;
}

/** 本人的这个项目：名字、挂着没了结的 Task 的名字。 */
export type ProjectPageFacts = { name: string; goals: string[] };

export function projectPageGuide(path: string, facts: ProjectPageFacts): PageGuide {
  const goals = facts.goals.length ? `现在挂着的目标：${facts.goals.join("、")}。` : "现在没有挂着的目标。";
  return { path, title: `项目：${facts.name}`.slice(0, 40), guide: `本人在这个项目的对话里，说的事默认指这个项目。${goals}`.slice(0, 150) };
}

/** 转给 Chat 的页面：Task 页、项目页按本人读到的现算，读不到（不是本人的、本体读不到）不带；其余查目录。 */
export async function pageFor(path: string, readTask: (taskId: string) => Promise<TaskPageFacts | null>,
  readProject: (projectId: string) => Promise<ProjectPageFacts | null> = async () => null): Promise<PageGuide | null> {
  const projectId = projectOfPage(path);
  if (projectId) {
    const facts = await readProject(projectId).catch(() => null);
    return facts ? projectPageGuide(path, facts) : null;
  }
  const taskId = taskOfPage(path);
  if (!taskId) return pageGuide(path);
  const facts = await readTask(taskId).catch(() => null);
  return facts ? taskPageGuide(path, facts) : null;
}

/** 测试用：整份目录（核对长度上限）。 */
export const PAGE_GUIDES = GUIDES;
