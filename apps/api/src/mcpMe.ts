import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Pool } from "pg";
import type { Query } from "./meetingStore.js";
import { authenticateMcpToken, MCP_WRITE_TOOLS, oauthUrls } from "./mcpOAuth.js";
import { canUseMemberView } from "./memberAccess.js";
import type { DirectoryPerson as MemoryPerson } from "./peopleDirectory.js";
import { companyProgress, getIssue, getMeeting, listPending } from "./mcpCeoReads.js";
import { readMissionCardForAgent } from "./mcpMissionCards.js";
import { applyMissionCardRevision } from "./missionCardAnnotations.js";
import { appendTaskProgress } from "./taskProgress.js";
import { canReadTask, createMyTask, getTaskDetail, listAvailableMissions, listMyTasks, submitMyTaskForAcceptance, updateMyTaskStatus } from "./tasks.js";
import { addObjectMaterialLink, listObjectMaterials, ObjectMaterialError } from "./objectMaterials.js";
import { logEvent } from "./observability.js";
import { MissionCardField, PersonalReviewUpdateInput, type TPersonalReviewUpdateInput } from "@warmap/contracts";
import { actionFingerprint, signActionId } from "./actionToken.js";
import { executePersonalReviewAction, getCurrentPersonalReview, getPersonalReview, personalReviewContext, personalReviewHref } from "./personalReviews.js";
import { PERSONAL_REVIEW_WRITING_REQUIREMENTS } from "./personalReviewAgent.js";

const ListInput = Type.Object({ status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("all")])) }, { additionalProperties: false });
const Uuid = Type.String({ pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" });
const GetInput = Type.Object({ itemId: Uuid }, { additionalProperties: false });
const Link = Type.Object({ url: Type.String({ pattern: "^https?://", maxLength: 500 }), title: Type.Optional(Type.String({ maxLength: 120 })) }, { additionalProperties: false });
const DateOnly = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const CreateInput = Type.Object({ clientId: Uuid, title: Type.String({ minLength: 1, maxLength: 120 }),
  doneDefinition: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), missionId: Type.Optional(Type.String({ minLength: 1 })),
  startDate: Type.Optional(DateOnly), dueDate: Type.Optional(DateOnly) }, { additionalProperties: false });
const AppendInput = Type.Object({ itemId: Uuid, body: Type.String({ minLength: 1, maxLength: 2000 }),
  links: Type.Optional(Type.Array(Link, { maxItems: 5 })), clientEventId: Type.Optional(Uuid) }, { additionalProperties: false });
const StatusInput = Type.Object({ itemId: Uuid, status: Type.Union([Type.Literal("not_started"), Type.Literal("in_progress"), Type.Literal("done")]), version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
const StandardCheck = Type.Object({ index: Type.Integer({ minimum: 0, maximum: 49 }), met: Type.Boolean(),
  evidence: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })), materialId: Type.Optional(Uuid) }, { additionalProperties: false });
const SubmitInput = Type.Object({ itemId: Uuid, version: Type.Integer({ minimum: 1 }), verdict: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  standards: Type.Optional(Type.Array(StandardCheck, { maxItems: 50 })), deliverables: Type.Optional(Type.Array(Uuid, { maxItems: 30 })) }, { additionalProperties: false });
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
  { name: "list_my_items", description: "列出我推进的执行事项，默认仅未完成；missions 是此刻可以挂执行事项的本月 Mission。List execution items I own (open by default) and the missions new items can belong to.", inputSchema: ListInput as Tool["inputSchema"], annotations: { readOnlyHint: true } },
  { name: "create_item", description: "按我正在做的事新建一条执行事项，直接生效、标为 Agent 建。先用 list_my_items 确认没有同一件事，有就写进展，不要重复建。title 写要交付的结果（30 字内）；doneDefinition 每行一条可检查的完成标准；对得上 list_my_items 里的 Mission 就带 missionId；startDate 填今天，知道截止就填 dueDate。clientId 是这次新建的随机 UUID，重试时沿用。Create an execution item for work I'm doing; check list_my_items first and never duplicate.", inputSchema: CreateInput as Tool["inputSchema"] },
  { name: "get_item", description: "读取我推进或协作的执行事项详情：完成标准（standards，按行拆好，index 从 0 起）、材料、进展、待验收的提交和验收记录。Read an execution item I own or collaborate on, with its done standards, materials, progress, pending submission and acceptance.", inputSchema: GetInput as Tool["inputSchema"], annotations: { readOnlyHint: true } },
  { name: "append_progress", description: "给我推进或协作的事项记录进展、证据和下一步；结果里的 item 是事项此刻的状态和版本（接着提交验收用这个版本）。Append progress and evidence to an item I own or collaborate on; the result's item carries the item's current status and version.", inputSchema: AppendInput as Tool["inputSchema"] },
  { name: "update_status", description: "把我推进的事项标为未启动或进行中，必须带当前版本。done 不会直接完成，而是提交给本人验收（同 submit_for_acceptance）。Set an item I own to not_started or in_progress; done only submits it for my acceptance.", inputSchema: StatusInput as Tool["inputSchema"] },
  { name: "submit_for_acceptance", description: "我推进的事项做完了，提交给本人验收，必须带当前版本；完成只能由本人在天枢验收。可附草稿：对 get_item 返回的 standards 逐条（index）写是否达到和一句依据（依据是材料时带 materialId）、一句结论、建议作为交付结果的材料 id。Submit an item I own for my acceptance; only I can mark it done in Tianshu.", inputSchema: SubmitInput as Tool["inputSchema"] },
  { name: "add_link", description: "把外部工具做出来的东西（文档、原型、PR 等）以链接放进我推进或协作的事项，出现在事项封面上；只收 http/https，同一个地址不会重复放；结果里的 item 是事项此刻的状态和版本。Attach a link (http/https) to an item I own or collaborate on; the result's item carries the item's current status and version.", inputSchema: LinkInput as Tool["inputSchema"] },
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
const reviewDefinitions: Tool[] = [
  { name: "list_pending", description: "列出待我处理的个人复盘；CEO 还可查议题、会议、月度计划和任务卡。", inputSchema: EmptyInput as Tool["inputSchema"], annotations: { readOnlyHint: true } },
  { name: "get_my_review", description: "读取本人当前个人复盘、Mission 全文、执行进展和写作要求。", inputSchema: EmptyInput as Tool["inputSchema"], annotations: { readOnlyHint: true } },
  { name: "save_review_draft", description: "按当前版本保存个人复盘草稿；不能提交，请本人到天枢确认后提交。", inputSchema: SaveReviewInput as Tool["inputSchema"] },
];
const memberNames = new Set(memberDefinitions.map((tool) => tool.name));
const ceoNames = new Set(ceoDefinitions.map((tool) => tool.name));
const access = (person: MemoryPerson) => ({ member: canUseMemberView(person), ceo: person.roles.includes("ceo") });
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

export async function createMeMcpSession(deps: { pool: Pool; q: Query; pepper: string; now: () => Date;
  names: () => Map<string, string>; findPerson: (personId: string) => MemoryPerson | undefined;
  people: () => MemoryPerson[]; initialPerson: MemoryPerson; publicOrigin?: string; authorization: string | undefined }) {
  const auth = () => authenticateMcpToken(deps.q, deps.authorization, deps.pepper, deps.now(), (id) => !!deps.findPerson(id), deps.publicOrigin ? oauthUrls(deps.publicOrigin).resource : undefined);
  /** 推进人写进展、放链接会让未启动的事项变进行中、版本跟着变：把事项此刻的状态和版本一起回给外部工具，接着提交验收直接用。 */
  const itemState = async (itemId: string) =>
    (await deps.q("SELECT status, version FROM tasks WHERE id=$1", [itemId])).rows[0] as { status: string; version: number } | undefined;
  const initialAccess = access(deps.initialPerson);
  const instructions = [
    ...(initialAccess.ceo ? ["公司业务只读：可以查待你处理的事、议题/会议/任务卡详情和全公司进展；拍板、签发、确认请回天枢网页操作。"] : []),
    ...(initialAccess.member ? [
      "可以查看自己的执行事项，记录真实进展，把做出来的东西用 add_link 放进去；做完用 submit_for_acceptance 提交给本人验收，完成只能由本人在天枢验收。",
      "不用等用户开口，主动把用户正在推进的工作同步进天枢：开始一件新工作（要交付一个结果、会持续一段时间；一次问答或顺手的小改动不算）时，先 list_my_items 找对应事项，找到就沿用，没有就用 create_item 建一条并告诉用户；做出阶段成果（提交、PR、文档、设计稿）或这段工作告一段落时，用 append_progress 写做了什么、证据和下一步，产出用 add_link 放进去；做完用 submit_for_acceptance 提交验收。只写真实做过的事。",
    ] : []),
    "任务卡正文是只读边界的例外：get_mission_card 只读本人可见卡；仅本人准备期间、editable=true时，用户已经明确具体改法可用edit_mission_card立即改有权限的任务字段并留痕。必须用刚读取的round填写sourceRound；本人已确认或已开始汇总时，只读正文和历史，先由本人取消确认或由战场 DRI 退回本人重新确认，不能自动绕过。保存备注不授权改文；仅明确修改意图可以写入。重新开放后需重新核对本次改法，不把旧改法直接套进新的本人准备窗口。不确定用户意思时先提问题与选项，最后一个选项为自己输入，澄清后立即改。不能自动向群聊发送私聊记录，不能签发或确认任务卡。遇到旧准备窗口、版本或原字段冲突必须重新读取。",
    "月末会有个人复盘待起草。用 list_pending 发现，get_my_review 读取本人的承诺、进展和写作要求，再用 save_review_draft 写入四部分草稿；不能替本人提交，请本人回天枢确认。",
  ].join("\n");
  const server = new Server({ name: "tianshu", version: "0.1.0" }, { capabilities: { tools: {} }, instructions });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const identity = await auth();
    const person = identity && deps.findPerson(identity.personId);
    if (!person) return { tools: [] };
    const roles = access(person);
    return { tools: [...(roles.member ? memberDefinitions : []), ...(roles.ceo ? ceoDefinitions : []),
      ...(roles.ceo || roles.member ? missionCardDefinitions : []), ...reviewDefinitions]
      .filter((tool) => !identity?.scopes || identity.scopes.includes("tianshu:write") || !MCP_WRITE_TOOLS.has(tool.name)) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = request.params.name, args = request.params.arguments ?? {};
    const identity = await auth();
    if (!identity) return result({ code: "UNAUTHORIZED", message: "身份已失效，请重新连接" }, true);
    const person = deps.findPerson(identity.personId);
    if (!person) return result({ code: "UNAUTHORIZED", message: "身份已失效，请重新连接" }, true);
    const roles = access(person);
    const write = MCP_WRITE_TOOLS.has(tool);
    if (write && identity.scopes && !identity.scopes.includes("tianshu:write")) return result({ code: "FORBIDDEN", message: "这次连接没有写入权限，请重新授权" }, true);
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
      const names = deps.names();
      const ceoContext = () => ({ q: deps.q, secret: deps.pepper, now: deps.now(), names,
        people: deps.people(), personId: identity.personId });
      switch (tool) {
        case "list_pending": {
          if (!Value.Check(EmptyInput, args)) break;
          const pending = roles.ceo ? await listPending(ceoContext()) : { items: [] };
          const review = await getCurrentPersonalReview(deps.q, identity.personId);
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
          const input = args as typeof CreateInput.static;
          const created = await createMyTask(deps.pool, identity.personId, names, { ...input, missionId: input.missionId ?? null }, deps.now(), "agent");
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
              mission: task.mission, startDate: task.startDate, dueDate: task.dueDate,
              collaborators: task.collaborators, latestProgress: task.latestProgress })),
            missions: await listAvailableMissions(deps.q, identity.personId, deps.now()) });
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
          const saved = await appendTaskProgress(deps.pool, itemId, identity.personId, identity.client,
            { body: args.body as string, links: args.links as { url: string; title?: string }[] | undefined,
              clientEventId: args.clientEventId as string | undefined ?? randomUUID() }, names, identity.tokenId);
          if ("error" in saved) { code = saved.error.code; return result(saved.error, true); }
          return result({ ...saved.entry, item: await itemState(itemId) });
        }
        case "update_status": {
          if (!Value.Check(StatusInput, args)) break;
          itemId = args.itemId as string;
          if (args.status === "done") {
            const submitted = await submitMyTaskForAcceptance(deps.pool, identity.personId, itemId, { version: args.version as number }, identity.client, names, deps.now());
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
          const submitted = await submitMyTaskForAcceptance(deps.pool, identity.personId, itemId, input, identity.client, names, deps.now());
          if ("notFound" in submitted) {
            const readable = await canReadTask(deps.q, itemId, identity.personId);
            code = readable ? "FORBIDDEN" : "TASK_NOT_FOUND";
            return result({ code, message: readable ? "只有推进人能提交验收" : "找不到这件执行事项" }, true);
          }
          if ("conflict" in submitted) { code = "VERSION_CONFLICT"; return result({ code, message: "版本已变化，请读取最新状态后重试", currentVersion: submitted.conflict.version, currentStatus: submitted.conflict.status }, true); }
          if ("error" in submitted) { code = submitted.error.code; return result(submitted.error, true); }
          return result({ status: submitted.task.status, version: submitted.task.version, submittedForAcceptance: true, message: "已提交验收，等本人在天枢确认" });
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
    } catch {
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
