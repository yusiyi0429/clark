import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool } from "pg";
import type { Query } from "./meetingStore.js";
import { authenticateMcpToken, MCP_WRITE_TOOLS, oauthUrls } from "./mcpOAuth.js";
import { canEnterMemberView, canUseMemberView } from "./memberAccess.js";
import type { DirectoryPerson as MemoryPerson } from "./peopleDirectory.js";
import { companyProgress, getIssue, getMeeting, listPending } from "./mcpCeoReads.js";
import { readMissionCardForAgent } from "./mcpMissionCards.js";
import { applyMissionCardRevision } from "./missionCardAnnotations.js";
import { appendTaskProgress } from "./taskProgress.js";
import { acceptMyTask, canReadTask, createMyTask, deleteMyTask, getTaskDetail, listAvailableMissions, listMyTasks, returnMyTask, submitMyTaskForAcceptance, updateMyTaskStatus, type TaskResult } from "./tasks.js";
import { addObjectMaterialLink, listObjectMaterials, ObjectMaterialError } from "./objectMaterials.js";
import { logEvent } from "./observability.js";
import { readPlanTasks, type PlanTaskSource } from "./planTasks.js";
import { MissionCardField, PersonalReviewUpdateInput, type TPersonalReviewUpdateInput } from "@warmap/contracts";
import { actionFingerprint, signActionId } from "./actionToken.js";
import { executePersonalReviewAction, getCurrentPersonalReview, getPersonalReview, personalReviewContext, personalReviewHref } from "./personalReviews.js";
import { PERSONAL_REVIEW_WRITING_REQUIREMENTS } from "./personalReviewAgent.js";
import { TaskQualityId, TaskRepairHandoff, TaskRepairList, TaskRepairView, TaskRepairReceiptInput } from "@warmap/contracts";
import { ChatServiceError, type createChatService } from "./chatService.js";
import { agreementDefinitions, agreementToolNames, callAgreementTool, type AgreementToolDeps } from "./mcpAgreements.js";
import { runWebSearch, WEB_SEARCH_TOOL } from "./mcpWebSearch.js";
import { readTaskContext, TASK_CONTEXT_TOOL } from "./mcpTaskContext.js";
import type { CompanyReader } from "./company.js";
import type { WebSearchAdapter } from "./webSearch.js";
import { agreementSummaries } from "./taskAgreements.js";
import { callProjectTool, isProjectTool, projectToolDefinitions, type LocalTurnDeps } from "./projectLocalTurns.js";

const QualityView = Type.Union([Type.Literal("ceo"), Type.Literal("member")]);
const QualityList = Type.Object({ viewerRole: QualityView }, { additionalProperties: false });
const QualityGet = Type.Object({ viewerRole: QualityView, proposalId: TaskQualityId }, { additionalProperties: false });
const QualityReceipt = Type.Object({ viewerRole: QualityView, proposalId: TaskQualityId, receipt: TaskRepairReceiptInput }, { additionalProperties: false });
const QualityCall = Type.Union([
  Type.Object({ name: Type.Literal("list_task_repairs"), arguments: QualityList }),
  Type.Object({ name: Type.Literal("get_task_repair_handoff"), arguments: QualityGet }),
  Type.Object({ name: Type.Literal("report_task_repair_receipt"), arguments: QualityReceipt }),
]);
const qualityDefinitions: Tool[] = [
  { name: "list_task_repairs", description: "列出本人指定视角的 Task 补齐草稿和上次核对状态。不会写 world。", inputSchema: QualityList as Tool["inputSchema"], annotations: { readOnlyHint: true } },
  { name: "get_task_repair_handoff", description: "读取本人一项最新补齐请求。stage=source 时先核对个人 world scope，取得用户对这项来源的确认后用 tkos-world act 执行 request 原文；回传来源回执，再读取字段卡。stage=change 时可把 package.input 原样交 world_app_prepare_task_change，或用 tkos-task-writeback import 导入 package。审阅完整差异和指纹，取得用户对此项的明确确认后才提交；保留准确 request 与 confirmation，丢响应用另一客户端按原 submission 核验。重试保留原键原文，不批量批准，不通过业务门。", inputSchema: QualityGet as Tool["inputSchema"], annotations: { readOnlyHint: true } },
  { name: "report_task_repair_receipt", description: "回传个人 world 操作的真实回执；服务只读核验原请求并复查缺口。stage=change 时，插件 submit/verify 返回的 verification_command 原样放入 verificationCommand；不要传个人 token 或 submission。可不带 receiptId 以查找准确原命令回执。来源记录完成不等于字段完成，字段完成不等于治理确认。", inputSchema: QualityReceipt as Tool["inputSchema"], annotations: { idempotentHint: true } },
];

const ListInput = Type.Object({ status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("all")])) }, { additionalProperties: false });
const Uuid = Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" });
const GetInput = Type.Object({ itemId: Uuid }, { additionalProperties: false });
const Link = Type.Object({ url: Type.String({ pattern: "^https?://", maxLength: 500 }), title: Type.Optional(Type.String({ maxLength: 120 })) }, { additionalProperties: false });
const DateOnly = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const CreateInput = Type.Object({ clientId: Uuid, title: Type.String({ minLength: 1, maxLength: 120 }),
  doneDefinition: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), missionId: Type.Optional(Type.String({ minLength: 1 })),
  planTaskId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), startDate: Type.Optional(DateOnly), dueDate: Type.Optional(DateOnly),
  noMissionReason: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })) }, { additionalProperties: false });
const AppendInput = Type.Object({ itemId: Uuid, body: Type.String({ minLength: 1, maxLength: 2000 }),
  links: Type.Optional(Type.Array(Link, { maxItems: 5 })), clientEventId: Type.Optional(Uuid) }, { additionalProperties: false });
const StatusInput = Type.Object({ itemId: Uuid, status: Type.Union([Type.Literal("not_started"), Type.Literal("in_progress"), Type.Literal("done")]), version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
const StandardCheck = Type.Object({ index: Type.Integer({ minimum: 0, maximum: 49 }), met: Type.Boolean(),
  evidence: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })), materialId: Type.Optional(Uuid) }, { additionalProperties: false });
const SubmitInput = Type.Object({ itemId: Uuid, version: Type.Integer({ minimum: 1 }), verdict: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  standards: Type.Optional(Type.Array(StandardCheck, { maxItems: 50 })), deliverables: Type.Optional(Type.Array(Uuid, { maxItems: 30 })) }, { additionalProperties: false });
const Nullable = <T extends ReturnType<typeof Type.String>>(schema: T) => Type.Union([schema, Type.Null()]);
const UpdateInput = Type.Object({ itemId: Uuid, version: Type.Integer({ minimum: 1 }), title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  doneDefinition: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 500 }))), startDate: Type.Optional(Nullable(DateOnly)), dueDate: Type.Optional(Nullable(DateOnly)),
  missionId: Type.Optional(Nullable(Type.String({ minLength: 1 }))), planTaskId: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 200 }))) }, { additionalProperties: false });
const VersionInput = Type.Object({ itemId: Uuid, version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
const ReturnInput = Type.Object({ itemId: Uuid, version: Type.Integer({ minimum: 1 }), reason: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });
const AcceptInput = Type.Object({ itemId: Uuid, version: Type.Integer({ minimum: 1 }), userConfirmation: Type.String({ minLength: 1, maxLength: 200 }),
  verdict: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), standards: Type.Optional(Type.Array(StandardCheck, { maxItems: 50 })),
  deliverables: Type.Optional(Type.Array(Uuid, { maxItems: 30 })) }, { additionalProperties: false });
const LinkInput = Type.Object({ itemId: Uuid, url: Type.String({ pattern: "^[Hh][Tt][Tt][Pp][Ss]?://", maxLength: 2000 }),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })) }, { additionalProperties: false });
const EmptyInput = Type.Object({}, { additionalProperties: false });
const SaveReviewInput = Type.Object({ version: Type.Integer({ minimum: 1 }), fields: PersonalReviewUpdateInput.properties.fields }, { additionalProperties: false });
const IssueInput = Type.Object({ issueId: Uuid }, { additionalProperties: false });
const MeetingInput = Type.Object({ meetingId: Uuid }, { additionalProperties: false });
const MissionCardInput = Type.Object({ cardId: Uuid }, { additionalProperties: false });
const EditMissionCardInput = Type.Object({ cardId: Uuid, missionId: Type.String({ minLength: 1 }), field: MissionCardField,
  sourceRound: Type.Integer({ minimum: 1 }), sourceVersion: Type.Integer({ minimum: 1 }), sourceText: Type.String({ maxLength: 12000 }),
  proposed: Type.String({ minLength: 1, maxLength: 12000 }), reason: Type.String({ minLength: 1, maxLength: 1000 }),
  annotationId: Type.Optional(Uuid), clientId: Uuid,
}, { additionalProperties: false });
const CompanyInput = Type.Object({ week: Type.Optional(Type.String()), battlefieldId: Type.Optional(Type.String({ minLength: 1 })),
  personId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
const memberDefinitions: Tool[] = [
  { name: "list_my_items", description: "列出我推进的执行事项，默认仅未完成；awaitingAcceptance=true 的在等本人验收，source=meeting 的是会后分派；missions 是此刻可以挂执行事项的本月 Mission，tasks 是挂在它下面的 Task。List execution items I own (open by default) and the missions new items can belong to.", inputSchema: ListInput as Tool["inputSchema"], annotations: { readOnlyHint: true } },
  { name: "create_item", description: "我明确要你建时，照我说的新建一条执行事项，直接生效、标为 Agent 建；粒度随我，我叫建什么就建什么，我没说就不建。先用 list_my_items 确认没有同一件事，有就告诉我，不要重复建。title 写要交付的结果（30 字内），不写「已完成…」「已合入…」这类进展句；doneDefinition 每行一条可检查的完成标准（验收时本人逐条对）；必须挂到 Mission：从 list_my_items 的 missions 里挑这件事在推进的那个，带 missionId，对得上它 tasks 里的 Task 就把 taskId 填进 planTaskId；实在对不上任何 Mission 时才不带 missionId，并在 noMissionReason 用一句话写为什么挂不上（例如「你名下没有和外部数据源调研对得上的 Mission」），这件事会进本人的「待归位」由本人处理，不要为了省事不挂；startDate 填今天，知道截止就填 dueDate。clientId 是这次新建的随机 UUID，重试时沿用。Create an execution item only when I explicitly ask; it must carry a missionId unless noMissionReason explains why none fits; check list_my_items first and never duplicate.", inputSchema: CreateInput as Tool["inputSchema"] },
  { name: "get_item", description: "读取我推进或协作的执行事项详情：完成标准（standards，按行拆好，index 从 0 起）、材料、进展、待验收的提交和验收记录。Read an execution item I own or collaborate on, with its done standards, materials, progress, pending submission and acceptance.", inputSchema: GetInput as Tool["inputSchema"], annotations: { readOnlyHint: true } },
  { name: "append_progress", description: "给我推进或协作的事项记录进展、证据和下一步；结果里的 item 是事项此刻的状态和版本（接着提交验收用这个版本）。Append progress and evidence to an item I own or collaborate on; the result's item carries the item's current status and version.", inputSchema: AppendInput as Tool["inputSchema"] },
  { name: "update_status", description: "把我推进的事项标为未启动或进行中，必须带当前版本。done 不会直接完成，而是提交给本人验收（同 submit_for_acceptance）。Set an item I own to not_started or in_progress; done only submits it for my acceptance.", inputSchema: StatusInput as Tool["inputSchema"] },
  { name: "submit_for_acceptance", description: "我推进的事项做完了，提交给本人验收，必须带当前版本；完成只能由本人在天枢逐条对完成标准确认，提交不等于完成。对 get_item 返回的 standards 逐条（index）写是否达到和一句能核对的依据（提交、PR、文档、会议结论；依据是材料时带 materialId），再写一句结论、建议作为交付结果的材料 id。Submit an item I own for my acceptance; only I can complete it.", inputSchema: SubmitInput as Tool["inputSchema"] },
  { name: "add_link", description: "把外部工具做出来的东西（文档、原型、PR 等）以链接放进我推进或协作的事项，出现在事项封面上；只收 http/https，同一个地址不会重复放；结果里的 item 是事项此刻的状态和版本。Attach a link (http/https) to an item I own or collaborate on; the result's item carries the item's current status and version.", inputSchema: LinkInput as Tool["inputSchema"] },
  { name: "update_item", description: "改我推进的事项：标题、完成标准（每行一条，null 清空）、开始/截止日期（null 清空）、挂哪个 Mission 和 Task（Mission 只能换不能取消，Task 传 null 取消），必须带当前版本，只传要改的字段。Edit an item I own (title, done standards, dates, mission/task).", inputSchema: UpdateInput as Tool["inputSchema"] },
  { name: "delete_item", description: "我明确要删时，删掉我推进的一件事（任何状态都行）；要合并的先把有用的进展用 append_progress 写进要保留的那件，再删，删完告诉用户删了哪几件。会后分派的不能删，用 return_item 退回。Delete an item I own only when I ask; meeting-assigned items can only be returned.", inputSchema: VersionInput as Tool["inputSchema"] },
  { name: "return_item", description: "退回会后分派给我的事（会通知分派的人），reason 写一句原因；只有本人说了不做或不该归他时才退。Return a meeting-assigned item with a reason.", inputSchema: ReturnInput as Tool["inputSchema"] },
  { name: "accept_item", description: "本人在对话里逐条对过完成标准、明确确认每一条都达到之后（一句「通过」不够），代本人确认完成；standards 逐条传 met=true，userConfirmation 填本人原话，群里会记下。有一条没达到、本人没逐条确认或你自己判断达标都不能调用——提醒本人到天枢逐条验收。没传 standards/deliverables/verdict 时沿用待验收提交里的。Mark an item done only after I confirmed every done standard in the conversation.", inputSchema: AcceptInput as Tool["inputSchema"] },
];
const ceoDefinitions: Tool[] = [
  { name: "get_issue", description: "读取议题详情与关联会议。", inputSchema: IssueInput as Tool["inputSchema"], annotations: { readOnlyHint: true } },
  { name: "get_meeting", description: "读取会议详情、预审、议程和会后条目。", inputSchema: MeetingInput as Tool["inputSchema"], annotations: { readOnlyHint: true } },
  { name: "company_progress", description: "读取指定周的全公司执行进展和战场状态计数。", inputSchema: CompanyInput as Tool["inputSchema"], annotations: { readOnlyHint: true } },
];
const missionCardDefinitions: Tool[] = [
  { name: "get_mission_card", description: "读取我可见的任务卡完整原字段、当前版本、本人批注和修改记录。", inputSchema: MissionCardInput as Tool["inputSchema"], annotations: { readOnlyHint: true } },
  { name: "edit_mission_card", description: "本人准备期间，改法已明确就立即修改有权限的任务卡一个字段，保留修改前后记录；先读get_mission_card，必须带刚读取的round作为sourceRound、当前版本和完整原字段，数组用换行连接。不能签发或确认任务卡。", inputSchema: EditMissionCardInput as Tool["inputSchema"] },
];
const LIST_PENDING_TOOL: Tool = { name: "list_pending", description: "列出待我处理的事：CEO 可查议题、会议和任务卡；天枢自己的月末复盘开着时还有个人复盘和月度计划。",
  inputSchema: EmptyInput as Tool["inputSchema"], annotations: { readOnlyHint: true } };
/** 天枢自己的月末复盘（monthlyCycle 开着才列）。 */
const reviewDefinitions: Tool[] = [
  { name: "get_my_review", description: "读取本人当前个人复盘、Mission 全文、执行进展和写作要求。", inputSchema: EmptyInput as Tool["inputSchema"], annotations: { readOnlyHint: true } },
  { name: "save_review_draft", description: "按当前版本保存个人复盘草稿；不能提交，请本人到天枢确认后提交。", inputSchema: SaveReviewInput as Tool["inputSchema"] },
];
const memberNames = new Set(memberDefinitions.map((tool) => tool.name));
const ceoNames = new Set(ceoDefinitions.map((tool) => tool.name));
/** member：成员才有的工具（执行事项）；ceo：CEO 才有的；work：能进成员视角（成员，或切到工作模式的 CEO）——项目会话的项目动作看它。 */
const access = (person: MemoryPerson) => ({ member: canUseMemberView(person), ceo: person.roles.includes("ceo"), work: canEnterMemberView(person) });
type Bucket = { minute: number; total: number; writes: number };
const buckets = new Map<string, Bucket>();
function limited(tokenId: string, write: boolean, now: Date): boolean {
  const minute = Math.floor(now.getTime() / 60_000);
  const current = buckets.get(tokenId);
  const bucket = current?.minute === minute ? current : { minute, total: 0, writes: 0 };
  bucket.total++;
  if (write) bucket.writes++;
  buckets.set(tokenId, bucket);
  return bucket.total > 60 || bucket.writes > 20;
}
const result = (value: unknown, isError = false) => ({ isError, content: [{ type: "text" as const, text: JSON.stringify(value) }] });
/** 推进人自己的事项操作没成：找不到、版本变了、规则不允许，统一成工具错误。 */
const taskFailure = (outcome: TaskResult | { deleted: true }) => "notFound" in outcome ? { code: "TASK_NOT_FOUND", message: "找不到这件执行事项" }
  : "conflict" in outcome ? { code: "VERSION_CONFLICT", message: "版本已变化，请读取最新状态后重试", currentVersion: outcome.conflict.version, currentStatus: outcome.conflict.status }
  : "error" in outcome ? outcome.error : null;

export async function createMeMcpSession(deps: { pool: Pool; q: Query; pepper: string; now: () => Date;
  names: () => Map<string, string>; findPerson: (personId: string) => MemoryPerson | undefined;
  people: () => MemoryPerson[]; initialPerson: MemoryPerson; publicOrigin?: string; authorization: string | undefined; planTasks: PlanTaskSource;
  chat?: ReturnType<typeof createChatService>; deliverables: AgreementToolDeps["deliverables"];
  /** 联网搜索（博查，服务器上的钥匙）；没配时不列 web_search。 */
  search?: WebSearchAdapter & { configured: boolean };
  /** 本体公司事实（get_task_context 按本人授权读）。 */
  company: CompanyReader;
  /** 天枢自己的月度计划和月末复盘开着（app.ts 的 tianshuMonthlyCycle）；关着时待办不列个人复盘和月度计划，不说复盘的用法。 */
  monthlyCycle?: boolean;
  /** 本机项目会话的项目钥匙连进来时的项目动作（17.2 第 38 条，projectLocalTurns.ts）。 */
  projectTurns?: LocalTurnDeps }) {
  const auth = () => authenticateMcpToken(deps.q, deps.authorization, deps.pepper, deps.now(), (id) => !!deps.findPerson(id), deps.publicOrigin ? oauthUrls(deps.publicOrigin).resource : undefined);
  /** 推进人写进展、放链接会让未启动的事项变进行中、版本跟着变：把事项此刻的状态和版本一起回给外部工具，接着提交验收直接用。 */
  const itemState = async (itemId: string) =>
    (await deps.q("SELECT status, version FROM tasks WHERE id=$1", [itemId])).rows[0] as { status: string; version: number } | undefined;
  /**
   * 可挂的 Mission，各带本体里挂在它下面的 Task（和首页同一个来源，限时；读不到就是空的）。
   * 每个 Task 带几条标准（criteriaCount）和约定补全了没有（agreementComplete：每条都写了用什么证明），约定与对表 V1。
   */
  const missionsWithTasks = async (personId: string) => {
    const missions = await listAvailableMissions(deps.q, personId, deps.now());
    const tasks = await readPlanTasks(deps.planTasks, missions.map(({ id, code }) => ({ id, code })));
    const agreements = await agreementSummaries(deps.q, tasks);
    return missions.map(({ code: _code, period: _period, ...mission }) => ({ ...mission,
      tasks: tasks.filter((task) => task.missionId === mission.id).map(({ taskId, name }) => ({ taskId, name, ...agreements.get(taskId)! })) }));
  };
  const initialAccess = access(deps.initialPerson);
  const instructions = [
    ...(initialAccess.ceo ? ["公司业务只读：可以查待你处理的事、议题/会议/任务卡详情和全公司进展；拍板、签发、确认请回天枢网页操作。"] : []),
    ...(initialAccess.member ? [
      "可以查看自己的执行事项，记录真实进展，把做出来的东西用 add_link 放进去；做完用 submit_for_acceptance 提交给本人验收；完成只能由本人在天枢逐条对完成标准确认。",
      "只在本人明确要求时才往天枢里写，比如本人说「同步本周进展」「记一下」「建一件事」「提交验收」：建事项、写进展、放链接、改事项、提交验收、整理合并或删除事项都一样；本人没开口就只读，不要自己判断该记了就去写。",
      "事项由本人建，粒度随本人：本人叫建什么就建什么，先用 list_my_items 看有没有同一件，有就告诉本人，不重复建；完成标准写成可检查的几条，验收时逐条对。记进展写做了什么、证据和下一步，产出用 add_link 放进去；本人说做完了，对照完成标准逐条写是否达到和依据，再用 submit_for_acceptance 提交验收。只写真实做过的事。会后分派来的事不删，本人说不做时用 return_item 退回。",
      "验收是本人逐条对完成标准的事：list_my_items 里有 awaitingAcceptance=true 的事，在对话开头或聊到相关的事时提醒一句（「有 N 件等你验收：…」），请本人到天枢逐条验收；本人在对话里逐条确认每条都达到时才用 accept_item 代为确认，一句「通过」不代确认。",
      "Task 的约定与对表：get_task_agreement 读每条验收标准用什么证明、谁来认、这次不包括什么；本人问「能交了吗」「还差什么」时用 check_task 对表，照结果说结论和差的那几条，不自己另判。add_deliverable_version 只在本人要求时用，交一版链接、自动参考评审；交付由本人在天枢点。",
      "要拆一个 Task、做它下面的一件事或验收之前，用 get_task_context 读这个 Task 的上下文（约定、Mission 和战场目标、本体里的相关事实和最近进展、上一版交付物和评审）；引用本体事实时照抄它给的 cite。",
    ] : []),
    "任务卡正文是只读边界的例外：get_mission_card 只读本人可见卡；仅本人准备期间、editable=true时，用户已经明确具体改法可用edit_mission_card立即改有权限的任务字段并留痕。必须用刚读取的round填写sourceRound；本人已确认或已开始汇总时，只读正文和历史，先由本人取消确认或由战场 DRI 退回本人重新确认，不能自动绕过。保存备注不授权改文；仅明确修改意图可以写入。重新开放后需重新核对本次改法，不把旧改法直接套进新的本人准备窗口。不确定用户意思时先提问题与选项，最后一个选项为自己输入，澄清后立即改。不能自动向群聊发送私聊记录，不能签发或确认任务卡。遇到旧准备窗口、版本或原字段冲突必须重新读取。",
    ...(deps.monthlyCycle ? ["月末会有个人复盘待起草。用 list_pending 发现，get_my_review 读取本人的承诺、进展和写作要求，再用 save_review_draft 写入四部分草稿；不能替本人提交，请本人回天枢确认。"] : []),
    ...(deps.search?.configured ? ["要查外部的最新事实（行业、产品、新闻、数据）用 web_search，结果带链接，引用时写出处；证据够了就停。"] : []),
  ].join("\n");
  const server = new Server({ name: "tianshu", version: "0.1.0" }, { capabilities: { tools: {} }, instructions });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const identity = await auth();
    const person = identity && deps.findPerson(identity.personId);
    if (!person) return { tools: [] };
    const roles = access(person);
    return { tools: [...(roles.member ? memberDefinitions : []), ...(roles.ceo ? ceoDefinitions : []),
      ...(roles.ceo || roles.member ? missionCardDefinitions : []), ...(roles.ceo || roles.member ? [...agreementDefinitions, TASK_CONTEXT_TOOL] : []), LIST_PENDING_TOOL, ...(deps.monthlyCycle ? reviewDefinitions : []),
      ...(deps.chat && (roles.ceo || roles.member) ? qualityDefinitions : []), ...(deps.search?.configured && (roles.ceo || roles.member) ? [WEB_SEARCH_TOOL] : []),
      ...(identity?.project && deps.projectTurns && roles.work ? await projectToolDefinitions(deps.q, person.personId) : [])]
      .filter((tool) => !identity?.scopes || identity.scopes.includes("tianshu:write") || !MCP_WRITE_TOOLS.has(tool.name)) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = request.params.name, args = request.params.arguments ?? {};
    const identity = await auth();
    if (!identity) return result({ code: "UNAUTHORIZED", message: "身份已失效，请重新连接" }, true);
    const person = deps.findPerson(identity.personId);
    if (!person) return result({ code: "UNAUTHORIZED", message: "身份已失效，请重新连接" }, true);
    const roles = access(person);
    const write = MCP_WRITE_TOOLS.has(tool);
    if (write && identity.scopes && !identity.scopes.includes("tianshu:write")) return result({ code: "FORBIDDEN", message: "这次连接没有写入权限，请重新授权" }, true);
    // 写进展、提交验收时记是哪种工具写的；本机程序的设备令牌（local）只读，到不了写工具。
    const writer = identity.client === "local" ? null : identity.client;
    let itemId: string | undefined;
    let code: string | undefined;
    try {
      if (limited(identity.tokenId, write, deps.now())) { code = "RATE_LIMITED"; return result({ code, message: "调用太频繁，请稍后再试" }, true); }
      if (ceoNames.has(tool) && !roles.ceo || memberNames.has(tool) && !roles.member) {
        code = "FORBIDDEN";
        return result({ code, message: ceoNames.has(tool) ? "这个工具只对 CEO 开放" : "这个工具只对成员开放" }, true);
      }
      if (missionCardDefinitions.some((definition) => definition.name === tool) && !roles.member && !roles.ceo) {
        code = "FORBIDDEN"; return result({ code, message: "这个工具只对成员或 CEO 开放" }, true);
      }
      // 项目钥匙的项目动作（17.2 第 38 条）：照本人的伙伴授权执行（写的要完全授权、记审计），调用次数照上面每把钥匙每分钟的上限算。
      if (identity.project && deps.projectTurns && isProjectTool(tool)) {
        if (!roles.work) { code = "FORBIDDEN"; return result({ code, message: "这个工具只对成员开放" }, true); }
        const outcome = await callProjectTool(deps.projectTurns, { personId: person.personId, projectId: identity.project.projectId }, tool, args, randomUUID());
        if (outcome.isError) code = (outcome.value as { code: string }).code;
        return result(outcome.value, outcome.isError);
      }
      const names = deps.names();
      if (qualityDefinitions.some(definition => definition.name === tool)) {
        if (!deps.chat) return result({ code: "CHAT_NOT_CONFIGURED", message: "数据质量服务尚未接通。" }, true);
        const call = { name: tool, arguments: args };
        if (!Value.Check(QualityCall, call)) return result({ code: "INVALID_INPUT", message: "请选择本人视角和正确的补齐记录。" }, true);
        if (call.arguments.viewerRole === "ceo" ? !roles.ceo : !roles.member) return result({ code: "FORBIDDEN", message: "本人不能使用该视角。" }, true);
        const viewer = { personId: person.personId, role: call.arguments.viewerRole };
        if (call.name === "list_task_repairs") return result(await deps.chat.quality(viewer, randomUUID(), "/proposals", TaskRepairList, undefined, extra.signal));
        if (call.name === "get_task_repair_handoff") return result(await deps.chat.quality(viewer, randomUUID(), `/proposals/${call.arguments.proposalId}/handoff`, TaskRepairHandoff, undefined, extra.signal));
        return result(await deps.chat.quality(viewer, randomUUID(), `/proposals/${call.arguments.proposalId}/receipts`, TaskRepairView, call.arguments.receipt, extra.signal));
      }
      // 约定与对表（mcpAgreements.ts）：成员和 CEO 都列，谁能看、谁能交在里面按人和 Task 的关系判；参数不合法落到最后的 INVALID_INPUT。
      if (agreementToolNames.has(tool)) {
        if (!roles.member && !roles.ceo) { code = "FORBIDDEN"; return result({ code, message: "这个工具只对成员或 CEO 开放" }, true); }
        const outcome = await callAgreementTool({ pool: deps.pool, q: deps.q, now: deps.now, planTasks: deps.planTasks, names, publicOrigin: deps.publicOrigin,
          deliverables: deps.deliverables }, { personId: person.personId, isCeo: roles.ceo }, tool, args);
        if (outcome) { code = outcome.error; return result(outcome.value, !!outcome.error); }
      }
      // Task 上下文（mcpTaskContext.ts）：成员和 CEO 都能用，本机程序的设备令牌也能用（只读）；谁能看照约定判，本体按本人授权读。
      if (tool === TASK_CONTEXT_TOOL.name) {
        if (!roles.member && !roles.ceo) { code = "FORBIDDEN"; return result({ code, message: "这个工具只对成员或 CEO 开放" }, true); }
        const outcome = await readTaskContext({ q: deps.q, now: deps.now, planTasks: deps.planTasks, names, company: deps.company },
          { personId: person.personId, isCeo: roles.ceo }, args, extra.signal);
        if (outcome) { code = outcome.error; return result(outcome.value, !!outcome.error); }
      }
      // 联网搜索（mcpWebSearch.ts）：成员和 CEO 都能用，本机程序的设备令牌也能用；每人每分钟、每天有上限，每真搜一次记一行。
      if (tool === WEB_SEARCH_TOOL.name) {
        if (!deps.search || (!roles.member && !roles.ceo)) { code = "FORBIDDEN"; return result({ code, message: "这个工具只对成员或 CEO 开放" }, true); }
        const outcome = await runWebSearch({ q: deps.q, search: deps.search, now: deps.now() }, { personId: person.personId, client: identity.client }, args, extra.signal);
        if (!outcome.ok) { code = outcome.code; return result({ code: outcome.code, message: outcome.message }, true); }
        return result(outcome.value);
      }
      const ceoContext = () => ({ q: deps.q, secret: deps.pepper, now: deps.now(), names,
        people: deps.people(), personId: identity.personId });
      switch (tool) {
        case "list_pending": {
          if (!Value.Check(EmptyInput, args)) break;
          const pending = roles.ceo ? await listPending(ceoContext(), Boolean(deps.monthlyCycle)) : { items: [] };
          const review = deps.monthlyCycle ? await getCurrentPersonalReview(deps.q, identity.personId) : null;
          return result({ items: [...pending.items, ...(review && !["submitted", "skipped"].includes(review.status) ? [{
            kind: "personal-review", id: review.id, title: `${Number(review.period.slice(5))} 月个人复盘`, status: review.status,
            version: review.version, href: personalReviewHref(review.id, roles.ceo),
          }] : [])] });
        }
        case "get_my_review": {
          if (!Value.Check(EmptyInput, args)) break;
          const review = await getCurrentPersonalReview(deps.q, identity.personId);
          if (!review) return result({ review: null, message: "当前没有进行中的个人复盘" });
          return result({ id: review.id, status: review.status, version: review.version, selfReview: review.self_review,
            ...await personalReviewContext(deps.q, review), writingRequirements: PERSONAL_REVIEW_WRITING_REQUIREMENTS });
        }
        case "save_review_draft": {
          if (!Value.Check(SaveReviewInput, args)) break;
          const review = await getCurrentPersonalReview(deps.q, identity.personId);
          if (!review) { code = "PERSONAL_REVIEW_NOT_FOUND"; return result({ code, message: "当前没有进行中的个人复盘" }, true); }
          const scope = { actionType: "personal-review.update", objectType: "personal-review", objectId: review.id, objectVersion: args.version as number };
          const fields = args.fields as TPersonalReviewUpdateInput["fields"];
          const saved = await executePersonalReviewAction(deps.pool, { personId: identity.personId, role: roles.ceo ? "ceo" : "member" }, scope,
            { fields }, actionFingerprint(deps.pepper, signActionId(deps.pepper, scope), { fields, source: "agent_tool" }), deps.now(), "agent_tool");
          if ("error" in saved) { code = saved.error.code; return result(saved.error, true); }
          if ("conflict" in saved) { code = "VERSION_CONFLICT"; return result({ code, message: "个人复盘已变化，请重新读取后重试" }, true); }
          const latest = (await getPersonalReview(deps.q, review.id))!;
          return result({ id: latest.id, status: latest.status, version: latest.version, selfReview: latest.self_review,
            message: "请到天枢确认后提交", href: `${(deps.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? "").replace(/\/$/, "")}${personalReviewHref(latest.id, roles.ceo)}` });
        }
        case "get_issue": {
          if (!Value.Check(IssueInput, args)) break;
          const issue = await getIssue(ceoContext(), args.issueId as string);
          if (!issue) { code = "ISSUE_NOT_FOUND"; return result({ code, message: "议题不存在" }, true); }
          return result(issue);
        }
        case "get_meeting": {
          if (!Value.Check(MeetingInput, args)) break;
          const meeting = await getMeeting(ceoContext(), args.meetingId as string);
          if (!meeting) { code = "MEETING_NOT_FOUND"; return result({ code, message: "会议不存在" }, true); }
          return result(meeting);
        }
        case "get_mission_card": {
          if (!Value.Check(MissionCardInput, args)) break;
          const card = await readMissionCardForAgent(deps.q, deps.people(), deps.pepper,
            { personId: identity.personId, role: roles.ceo ? "ceo" : "member" }, args.cardId as string, deps.now());
          if (!card) { code = "MISSION_CARD_NOT_FOUND"; return result({ code, message: "任务卡不存在" }, true); }
          return result(card);
        }
        case "edit_mission_card": {
          if (!Value.Check(EditMissionCardInput, args)) break;
          const { cardId, ...input } = args as typeof EditMissionCardInput.static;
          const saved = await applyMissionCardRevision(deps.pool, deps.people(), deps.pepper,
            { personId: identity.personId, role: roles.ceo ? "ceo" : "member" }, cardId, input, deps.now, "agent");
          if ("error" in saved) { code = saved.error.code; return result(saved.error, true); }
          return result(saved);
        }
        case "company_progress": {
          if (!Value.Check(CompanyInput, args)) break;
          try { return result(await companyProgress(ceoContext(), args)); }
          catch (error) { if (error instanceof RangeError) { code = "INVALID_INPUT"; return result({ code, message: "周参数不合法" }, true); } throw error; }
        }
        case "create_item": {
          if (!Value.Check(CreateInput, args)) break;
          const { noMissionReason, ...input } = args as typeof CreateInput.static;
          // 只有本人自己建的事项可以不挂 Mission：Agent 不带 missionId 时必须写清为什么，事项进本人的待归位。
          if (!input.missionId && !noMissionReason?.trim()) {
            code = "MISSION_REQUIRED";
            return result({ code, message: "执行事项必须挂到 Mission：从 list_my_items 的 missions 里挑 missionId；实在对不上时写 noMissionReason（一句话，为什么挂不上），事项会进本人的待归位。" }, true);
          }
          const created = await createMyTask(deps.pool, identity.personId, names,
            { ...input, missionId: input.missionId ?? null, unplacedReason: input.missionId ? undefined : noMissionReason?.trim() }, deps.now(), "agent");
          if ("error" in created) { code = created.error.code; return result(created.error, true); }
          if (!("task" in created)) { code = "INTERNAL"; return result({ code, message: "执行失败，请稍后重试" }, true); }
          const task = created.task;
          itemId = task.id;
          return result({ id: task.id, title: task.title, status: task.status, version: task.version, mission: task.mission,
            startDate: task.startDate, dueDate: task.dueDate, href: `${(deps.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? "").replace(/\/$/, "")}/me/tasks/${task.id}` });
        }
        case "list_my_items": {
          if (!Value.Check(ListInput, args)) break;
          const tasks = await listMyTasks(deps.q, identity.personId, names);
          return result({ items: (args.status === "all" ? tasks : tasks.filter((task) => task.status !== "done" && task.status !== "returned"))
            .map((task) => ({ id: task.id, title: task.title, status: task.status, version: task.version,
              source: task.source, awaitingAcceptance: task.awaitingAcceptance, mission: task.mission, startDate: task.startDate, dueDate: task.dueDate,
              collaborators: task.collaborators, latestProgress: task.latestProgress })),
            missions: await missionsWithTasks(identity.personId) });
        }
        case "get_item": {
          if (!Value.Check(GetInput, args)) break;
          itemId = args.itemId as string;
          const detail = await getTaskDetail(deps.q, itemId, identity.personId, names, deps.now(), new Set());
          if (!detail) { code = "TASK_NOT_FOUND"; return result({ code, message: "找不到这件执行事项" }, true); }
          const { materials } = await listObjectMaterials(deps.q, { objectType: "task", objectId: itemId },
            { personId: identity.personId, role: roles.ceo ? "ceo" : "member", displayName: names.get(identity.personId) ?? identity.personId }, names);
          return result({ ...detail, progress: detail.progress.slice(0, 20),
            materials: materials.map((item) => ({ id: item.id, fileName: item.fileName, format: item.format, ...(item.url ? { url: item.url } : {}),
              owner: item.owner.displayName, createdAt: item.createdAt })) });
        }
        case "append_progress": {
          if (!Value.Check(AppendInput, args)) break;
          if (!(args.body as string).trim()) { code = "INVALID_INPUT"; return result({ code, message: "请填写进展正文" }, true); }
          itemId = args.itemId as string;
          const saved = await appendTaskProgress(deps.pool, itemId, identity.personId, writer!,
            { body: args.body as string, links: args.links as { url: string; title?: string }[] | undefined,
              clientEventId: args.clientEventId as string | undefined ?? randomUUID() }, names, identity.tokenId);
          if ("error" in saved) { code = saved.error.code; return result(saved.error, true); }
          return result({ ...saved.entry, item: await itemState(itemId) });
        }
        case "update_status": {
          if (!Value.Check(StatusInput, args)) break;
          itemId = args.itemId as string;
          if (args.status === "done") {
            const submitted = await submitMyTaskForAcceptance(deps.pool, identity.personId, itemId, { version: args.version as number }, writer!, names, deps.now());
            if ("notFound" in submitted) { code = "TASK_NOT_FOUND"; return result({ code, message: "找不到这件执行事项" }, true); }
            if ("conflict" in submitted) { code = "VERSION_CONFLICT"; return result({ code, message: "版本已变化，请读取最新状态后重试", currentVersion: submitted.conflict.version, currentStatus: submitted.conflict.status }, true); }
            if ("error" in submitted) { code = submitted.error.code; return result(submitted.error, true); }
            return result({ status: submitted.task.status, version: submitted.task.version, submittedForAcceptance: true, message: "已提交验收，等本人在天枢确认" });
          }
          const updated = await updateMyTaskStatus(deps.pool, identity.personId, itemId,
            { version: args.version as number, status: args.status as "not_started" | "in_progress" }, names, deps.now());
          if ("notFound" in updated) { code = "TASK_NOT_FOUND"; return result({ code, message: "找不到这件执行事项" }, true); }
          if ("conflict" in updated) { code = "VERSION_CONFLICT"; return result({ code, message: "版本已变化，请读取最新状态后重试", currentVersion: updated.conflict.version, currentStatus: updated.conflict.status }, true); }
          if ("error" in updated) { code = updated.error.code; return result(updated.error, true); }
          return result(updated.task);
        }
        case "submit_for_acceptance": {
          if (!Value.Check(SubmitInput, args)) break;
          const input = args as typeof SubmitInput.static;
          itemId = input.itemId;
          const submitted = await submitMyTaskForAcceptance(deps.pool, identity.personId, itemId, input, writer!, names, deps.now());
          if ("notFound" in submitted) {
            const readable = await canReadTask(deps.q, itemId, identity.personId);
            code = readable ? "FORBIDDEN" : "TASK_NOT_FOUND";
            return result({ code, message: readable ? "只有推进人能提交验收" : "找不到这件执行事项" }, true);
          }
          if ("conflict" in submitted) { code = "VERSION_CONFLICT"; return result({ code, message: "版本已变化，请读取最新状态后重试", currentVersion: submitted.conflict.version, currentStatus: submitted.conflict.status }, true); }
          if ("error" in submitted) { code = submitted.error.code; return result(submitted.error, true); }
          return result({ status: submitted.task.status, version: submitted.task.version, submittedForAcceptance: true, message: "已提交验收，等本人在天枢确认" });
        }
        case "update_item": {
          if (!Value.Check(UpdateInput, args)) break;
          const { itemId: id, ...input } = args as typeof UpdateInput.static;
          itemId = id;
          if (input.missionId === null) {
            code = "MISSION_REQUIRED";
            return result({ code, message: "Mission 只能换不能取消：要换就传另一个 missionId；不属于任何 Mission 的事由本人在天枢里确认。" }, true);
          }
          const updated = await updateMyTaskStatus(deps.pool, identity.personId, id, input, names, deps.now());
          const failed = taskFailure(updated);
          if (failed || !("task" in updated)) { code = failed?.code ?? "INTERNAL"; return result(failed, true); }
          return result(updated.task);
        }
        case "delete_item": {
          if (!Value.Check(VersionInput, args)) break;
          itemId = args.itemId as string;
          const deleted = await deleteMyTask(deps.pool, identity.personId, itemId, args.version as number, names, true);
          const failed = taskFailure(deleted);
          if (failed) { code = failed.code; return result(failed, true); }
          return result({ deleted: true });
        }
        case "return_item": {
          if (!Value.Check(ReturnInput, args)) break;
          const input = args as typeof ReturnInput.static;
          itemId = input.itemId;
          const returned = await returnMyTask(deps.pool, identity.personId, itemId, { version: input.version, reason: input.reason }, names);
          const failed = taskFailure(returned);
          if (failed || !("task" in returned)) { code = failed?.code ?? "INTERNAL"; return result(failed, true); }
          return result({ status: returned.task.status, version: returned.task.version });
        }
        case "accept_item": {
          if (!Value.Check(AcceptInput, args)) break;
          const input = args as typeof AcceptInput.static;
          itemId = input.itemId;
          if (!input.userConfirmation.trim()) { code = "INVALID_INPUT"; return result({ code, message: "请填本人确认验收的原话" }, true); }
          const submission = (await getTaskDetail(deps.q, itemId, identity.personId, names, deps.now(), new Set()))?.submission;
          const accepted = await acceptMyTask(deps.pool, identity.personId, itemId, { version: input.version,
            verdict: input.verdict ?? submission?.verdict ?? null,
            standards: input.standards?.map((check) => ({ ...check, evidence: check.evidence ?? null, materialId: check.materialId ?? null })) ?? submission?.standards ?? [],
            deliverableMaterialIds: input.deliverables ?? submission?.deliverableMaterialIds ?? [] },
          names, deps.now(), { client: writer!, userConfirmation: input.userConfirmation });
          const failed = taskFailure(accepted);
          if (failed || !("task" in accepted)) { code = failed?.code ?? "INTERNAL"; return result(failed, true); }
          return result({ status: accepted.task.status, version: accepted.task.version });
        }
        case "add_link": {
          if (!Value.Check(LinkInput, args)) break;
          const input = args as typeof LinkInput.static;
          itemId = input.itemId;
          if (!await canReadTask(deps.q, itemId, identity.personId)) { code = "TASK_NOT_FOUND"; return result({ code, message: "找不到这件执行事项" }, true); }
          try {
            const { material, created } = await addObjectMaterialLink(deps.pool, { objectType: "task", objectId: itemId },
              { personId: identity.personId, role: roles.ceo ? "ceo" : "member", displayName: names.get(identity.personId) ?? identity.personId },
              { url: input.url, title: input.title }, names);
            return result({ id: material.id, title: material.fileName, url: material.url, created, item: await itemState(itemId) });
          } catch (error) {
            if (error instanceof ObjectMaterialError) { code = error.code; return result({ code, message: error.message }, true); }
            throw error;
          }
        }
      }
      code = "INVALID_INPUT";
      return result({ code, message: "工具或参数不合法" }, true);
    } catch (error) {
      if (error instanceof ChatServiceError) { code = error.code; return result({ code, message: error.message }, true); }
      code = "INTERNAL";
      return result({ code, message: "执行失败，请稍后重试" }, true);
    } finally {
      logEvent({ event: "mcp.tool", tokenId: identity.tokenId, personId: identity.personId, tool, itemId: itemId ?? null, ok: !code, errorCode: code ?? null });
    }
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return { server, transport };
}
