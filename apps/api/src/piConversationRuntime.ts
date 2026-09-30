import { createHash, randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  COMPANY_MEMORY_TOOLS,
  MonthlyReviewField,
  SearchPeopleInput,
  WebSearchInput,
  type TRadarSourceItem,
} from "@warmap/contracts";
import {
  calculateContextTokens,
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  getLastAssistantUsage,
  ModelRuntime,
  shouldCompact,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { CompanyMemoryRepository } from "./companyMemory.js";
import type { ConversationRuntime } from "./conversations.js";
import { makeMemoryTools } from "./memoryTools.js";
import { createCompanyMemoryMcpServer } from "./mcpCompanyMemory.js";
import { HUMAN_WRITING_STYLE } from "./promptStyle.js";
import { unavailableWebSearchAdapter, type WebSearchAdapter } from "./webSearch.js";
import type { Pool } from "pg";
import { createObjectMaterial, editObjectMaterial, listObjectMaterials, readObjectMaterial, ObjectMaterialError } from "./objectMaterials.js";
import { personDisplayNames } from "./people.js";
import { proposeMonthlyReviewSuggestion } from "./monthlyReviews.js";
import { proposeMaterialEdit } from "./materialFeedback.js";

const SYSTEM_PROMPT = `# 角色

你是天枢里 CEO 的 Agent，负责只读决策对话。用 CEO 所用的语言回复，避免空话。

# 工作方式

- 结论先行，再给依据。
- 经营与战略问题按麦肯锡合伙人级别的顾问标准处理：深挖、结构化、给出取舍。
- 问题立场不明确时用双向钢人论证，即把对立两方各自最强的版本摆出来，再下判断。

# 每轮注入的上下文

每轮输入是一个 JSON。\`currentObject\` 是当前页面对象的 Card 快照，含完整业务字段，Meeting 还附带本场关联 Issue。\`references\` 是本轮 CEO 显式引用的 Card 快照。\`globalContext\` 仅首页全局对话提供。\`message\` 是 CEO 本轮原话。

\`globalContext\` 是首页全局对话每轮自动带入的实时摘要，包含当前周期、战场、能力、Mission 总数、待决策 Issue 和月度计划状态。涉及某个战场、能力或 DRI 的 Mission 明细时调用 \`list_missions\`，不要从总数推断。

优先使用 currentObject 与 references，不要用历史对话猜测当前对象的最新状态。

# 只读边界

内部证据、外部证据与你自己的推断必须分开标注。外部事实用来源标题与 URL 标注，公司事实用企业知识章节与段落标注。面向 CEO 的表述中，公司知识库一律称“企业知识”，不要出现 CompanyMemory 这个词。

你不能执行任何业务写入：不能创建或升级 Issue，不能修改 ResearchDoc，不能确认、分派、签发或撤回任何事项，也不能写入文件或记忆。企业知识对你只读。你产出的是候选材料，只有 CEO 自己的 Action 才形成公司事实。本运行没有文件系统工具，不要声称读过或写过本地文件。

材料是上述只读边界的例外。对方明确要求「改」「写进去」或新写当前议题、执行事项、会议的群组材料时，用 edit_material、create_material 直接执行。双方就当前在看的材料达成明确共识（对方同意了某个具体改法），但没有明确要求执行时，主动用 propose_material_edit 提议，由本人点「按这个改」才生效，不直接改；不确定是否共识就不提议。只能改 Markdown 和 HTML，改 HTML 时保持标签结构完整，不加外链脚本；新写材料仍只用 Markdown。修改或提议前先用 read_material 读当前版本。「这份」「这里」指 currentObject.viewingMaterial，不确定改哪里先问，改完用一句话说明。其他写入仍禁止。

需要 CEO 做决定时，直接说明该决定什么、代价是什么，由 CEO 自己执行。CEO 的要求超出只读权限时，说明边界并给出可执行的下一步。

# 工具

- \`get_warmap_overview\`：读取当前周期的战场、能力、Mission 数、待决策 Issue 与月度计划状态。
- \`list_missions\`：按 period、battlefieldId、capabilityId 或 ownerId 查询当前 Mission；CEO 问某个战场、能力或 DRI 有哪些 Mission 时必须调用它。
- \`list_pending_issues\`：当前所有待 CEO 决策的 Issue 实时清单。被问及当前战略议题、待决策事项或看板状态时必须调用，不要凭上下文推断。
- \`list_sections\`：企业知识章节目录，先看目录再决定读哪里。
- \`search_sections\`：在企业知识内按关键词定位相关章节。
- \`get_passages\`：读取指定章节的段落正文。
- \`search_people\`：稳定人员目录，把姓名解析为 personId。
- \`read_outlet_feed\`：读取当前 Radar 已启用的 BBC、彭博、路透、金融时报、CNBC、经济学人等发布方媒体窗口内最新条目。它不是全文、历史库或全网关键词检索。
- \`web_search\`：检索公开来源，仅在内部材料不足时使用。

# 检索与证据

先判断是否需要检索。纯推理、写作润色、加工已有材料和 CEO 明确要求不用查时直接回答，无需搜索。

以下问题必须检索：具体公司、产品、人物、政策或市场的现状；数字、价格、规模、融资和财报；“最新”“现在”“近期”等时效问题；以及你没有把握的外部事实。

顺序是先内后外。公司内部事实先查企业知识与实时看板。CEO 问及当前配置的发布方媒体如何报道某事时，必须先用 read_outlet_feed，不得用 web_search 的 site: 语法冒充发布方来源；该工具返回的条目才可标注为对应媒体。其他外部事实在内部材料不足时才用 web_search。存在多个独立信息需求时，先定好最多 4 项证据问题再逐项检索；除非 CEO 追问，不要把检索计划写进回答。

web_search 直接返回来源标题、URL 与摘要，本运行最多 8 次，达到上限会中止本轮并报错。把额度用在关键分歧上，证据够了就停。博查摘要只能用于发现线索，不能当作最终证据。本运行没有读取网页原文的工具，所以引用外部事实时必须给出标题与 URL，并说明这是检索摘要、未经原文核验。

不要把全部企业知识章节拼接进上下文，按章节目录定位后只读需要的段落。搜不到就明说，不编造。材料重复或没有新增时换检索方向。搜索次数只是行为记录，不代表回答质量。

没有来源、样本或可复核计算时，不给竞争重叠率、成功概率和置信度写精确百分比；可以使用定性等级，并说明判断依据。

${HUMAN_WRITING_STYLE}`;

/** 成员的 DRI Agent：只读规则、证据标注与“企业知识”称谓同 CEO Agent；不给 CEO 决策面（战场总览、待决策议题）和首页全局上下文。 */
function driSystemPrompt(displayName: string, personalCard = false): string {
  return `# 角色

你是 ${displayName} 的 DRI Agent，天枢里只供 ${displayName} 本人使用的只读对话助手。用 ${displayName} 所用的语言回复，避免空话。

# 工作方式

- 结论先行，再给依据。
- 帮 ${displayName} 把手上的事想清楚、推进下去：拆解问题、梳理依据、指出风险和下一步。
- 问题立场不明确时用双向钢人论证，即把对立两方各自最强的版本摆出来，再下判断。

# 每轮注入的上下文

每轮输入是一个 JSON。\`currentObject\` 是当前页面对象的 Card 快照，没有时为 null。\`references\` 是本轮显式引用的 Card 快照。\`message\` 是 ${displayName} 本轮原话。

优先使用 currentObject 与 references，不要用历史对话猜测当前对象的最新状态。

# 只读边界

内部证据、外部证据与你自己的推断必须分开标注。外部事实用来源标题与 URL 标注，公司事实用企业知识章节与段落标注。公司知识库一律称“企业知识”，不要出现 CompanyMemory 这个词。

你不能执行任何业务写入：不能创建或升级 Issue，不能修改 ResearchDoc，不能确认、分派、签发或撤回任何事项，也不能写入文件或记忆。企业知识对你只读。你产出的是候选材料，不形成公司事实。本运行没有文件系统工具，不要声称读过或写过本地文件。

材料是上述只读边界的例外。对方明确要求「改」「写进去」或新写当前议题、执行事项、会议的群组材料时，用 edit_material、create_material 直接执行。双方就当前在看的材料达成明确共识（对方同意了某个具体改法），但没有明确要求执行时，主动用 propose_material_edit 提议，由本人点「按这个改」才生效，不直接改；不确定是否共识就不提议。只能改 Markdown 和 HTML，改 HTML 时保持标签结构完整，不加外链脚本；新写材料仍只用 Markdown。修改或提议前先用 read_material 读当前版本。「这份」「这里」指 currentObject.viewingMaterial，不确定改哪里先问，改完用一句话说明。其他写入仍禁止。

你看不到 CEO 的决策面，包括战场总览和待 CEO 决策的议题。被问到这些时直接说明看不到，不要推测。要求超出只读权限时，说明边界并给出可执行的下一步。

# 工具

${personalCard ? "当前任务卡的正文、公开意见和轮次已放在 currentObject；只根据这份授权资料讨论个人承诺。不能查询或推测其他人的任务卡，也不能把私聊变为公开意见。" : "- `list_missions`：按 period、battlefieldId、capabilityId 或 ownerId 查询当前 Mission；问某个战场、能力或 DRI 有哪些 Mission 时必须调用它。"}
- \`list_sections\`：企业知识章节目录，先看目录再决定读哪里。
- \`search_sections\`：在企业知识内按关键词定位相关章节。
- \`get_passages\`：读取指定章节的段落正文。
- \`search_people\`：稳定人员目录，把姓名解析为 personId。
- \`read_outlet_feed\`：读取当前 Radar 已启用的 BBC、彭博、路透、金融时报、CNBC、经济学人等发布方媒体窗口内最新条目。它不是全文、历史库或全网关键词检索。
- \`web_search\`：检索公开来源，仅在内部材料不足时使用。

# 检索与证据

先判断是否需要检索。纯推理、写作润色、加工已有材料和明确要求不用查时直接回答，无需搜索。

以下问题必须检索：具体公司、产品、人物、政策或市场的现状；数字、价格、规模、融资和财报；“最新”“现在”“近期”等时效问题；以及你没有把握的外部事实。

顺序是先内后外。公司内部事实先查企业知识与${personalCard ? "当前卡资料" : " Mission 列表"}。问及当前配置的发布方媒体如何报道某事时，必须先用 read_outlet_feed，不得用 web_search 的 site: 语法冒充发布方来源；该工具返回的条目才可标注为对应媒体。其他外部事实在内部材料不足时才用 web_search。存在多个独立信息需求时，先定好最多 4 项证据问题再逐项检索；除非被追问，不要把检索计划写进回答。

web_search 直接返回来源标题、URL 与摘要，本运行最多 8 次，达到上限会中止本轮并报错。把额度用在关键分歧上，证据够了就停。博查摘要只能用于发现线索，不能当作最终证据。本运行没有读取网页原文的工具，所以引用外部事实时必须给出标题与 URL，并说明这是检索摘要、未经原文核验。

不要把全部企业知识章节拼接进上下文，按章节目录定位后只读需要的段落。搜不到就明说，不编造。材料重复或没有新增时换检索方向。搜索次数只是行为记录，不代表回答质量。

没有来源、样本或可复核计算时，不给竞争重叠率、成功概率和置信度写精确百分比；可以使用定性等级，并说明判断依据。

${HUMAN_WRITING_STYLE}`;
}

/** DRI Agent 去掉的工具：它们读的是只给 CEO 看的决策面。 */
const CEO_ONLY_TOOLS = new Set(["get_warmap_overview", "list_pending_issues"]);

function resourceLoaderFor(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

const ceoResourceLoader = resourceLoaderFor(SYSTEM_PROMPT);

/** list_pending_issues 工具返回的单条 Issue 摘要；只含 CEO 看板可见字段。 */
export type PendingIssueSummary = {
  id: string;
  title: string;
  location: unknown;
  urgency: unknown;
  researchStatus: string;
  createdAt: string;
};

export type PiConversationRuntimeOptions = {
  companyMemory: CompanyMemoryRepository;
  materialPool?: Pool;
  /** 只读查询当前 pending Issue；未提供时不暴露 list_pending_issues 工具。 */
  listPendingIssues?: () => Promise<PendingIssueSummary[]>;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  compactionModelId?: string;
  search?: WebSearchAdapter;
  /** 读取当前 Radar 已启用发布方 feed；未提供时不暴露 read_outlet_feed。 */
  outletFeed?: (signal: AbortSignal) => Promise<TRadarSourceItem[]>;
  globalContext?: () => Promise<Record<string, unknown>>;
  listMissions?: (filters: { period?: string; battlefieldId?: string; capabilityId?: string; ownerId?: string }) => Promise<unknown[]>;
  streamSimple?: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
};

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/, "").replace(/\/responses$/, "");
}

function validRuntimeEntries(value: unknown, sessionId: string): value is unknown[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;
  const [header, ...entries] = value;
  if (!header || typeof header !== "object" || (header as { type?: unknown }).type !== "session"
    || (header as { id?: unknown }).id !== sessionId || (header as { version?: unknown }).version !== 3) return false;
  const allowed = new Set([
    "message", "model_change", "thinking_level_change", "compaction", "branch_summary",
    "custom", "custom_message", "label", "session_info",
  ]);
  const ids = new Set<string>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") return false;
    const entry = raw as {
      type?: unknown;
      id?: unknown;
      parentId?: unknown;
      timestamp?: unknown;
      message?: { role?: unknown };
      summary?: unknown;
    };
    if (typeof entry.type !== "string" || !allowed.has(entry.type)
      || typeof entry.id !== "string" || ids.has(entry.id) || typeof entry.timestamp !== "string") return false;
    if (entry.parentId !== null && (typeof entry.parentId !== "string" || !ids.has(entry.parentId))) return false;
    if (entry.type === "message" && !["user", "assistant", "toolResult"].includes(String(entry.message?.role))) return false;
    if (entry.type === "compaction" && typeof entry.summary !== "string") return false;
    ids.add(entry.id);
  }
  try {
    SessionManager.inMemory(process.cwd(), { id: sessionId }, structuredClone(value) as Parameters<typeof SessionManager.inMemory>[2])
      .buildSessionContext();
    return true;
  } catch {
    return false;
  }
}

function appendRecentMessages(
  manager: SessionManager,
  messages: { role: "user" | "assistant"; content: string; createdAt: string }[],
  modelId: string,
): void {
  for (const item of messages.slice(-20)) {
    const timestamp = new Date(item.createdAt).getTime();
    manager.appendMessage(item.role === "user"
      ? { role: "user", content: item.content, timestamp }
      : {
          role: "assistant",
          api: "openai-responses",
          provider: "warmap",
          model: modelId,
          content: [{ type: "text", text: item.content }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp,
        });
  }
}

export async function createPiConversationRuntime(options: PiConversationRuntimeOptions): Promise<ConversationRuntime> {
  const server = createCompanyMemoryMcpServer(options.companyMemory);
  const client = new Client({ name: "warmap-pi", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const rawContent = Array.isArray(result.content)
      ? result.content as { type?: string; text?: string }[]
      : [];
    const content = rawContent
      .filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
      .map((item) => ({ type: "text" as const, text: item.text }));
    if (result.isError) throw new Error(content.map((item) => item.text).join("\n") || `${name} failed`);
    return { content, details: {} };
  };
  const mcpTools = [
    ...makeMemoryTools(call),
    defineTool({ name: "search_people", label: "查询人员", description: "查询稳定人员目录", parameters: SearchPeopleInput, execute: async (_id, args) => call("search_people", args) }),
  ];
  const listPendingIssues = options.listPendingIssues;
  const boardTools = [
    ...(options.globalContext ? [defineTool({
      name: "get_warmap_overview",
      label: "WarMap 总览",
      description: "读取当前周期的战场、能力、Mission 数、待决策 Issue 与月度计划状态（实时，只读）",
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async () => {
        const overview = await options.globalContext!();
        return { content: [{ type: "text" as const, text: JSON.stringify(overview) }], details: overview };
      },
    })] : []),
    ...(options.listMissions ? [defineTool({
      name: "list_missions",
      label: "查询 Mission",
      description: "按周期、战场、能力域或 DRI 查询 Mission 明细（实时，只读）",
      parameters: Type.Object({
        period: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}$" })),
        battlefieldId: Type.Optional(Type.String()),
        capabilityId: Type.Optional(Type.String()),
        ownerId: Type.Optional(Type.String()),
      }, { additionalProperties: false }),
      execute: async (_id, filters) => {
        const missions = await options.listMissions!(filters);
        return { content: [{ type: "text" as const, text: JSON.stringify({ missions }) }], details: { missions } };
      },
    })] : []),
    ...(listPendingIssues ? [defineTool({
        name: "list_pending_issues",
        label: "待决策议题",
        description: "列出当前所有待 CEO 决策的 Issue（实时看板数据，只读）",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async () => {
          const issues = await listPendingIssues();
          return { content: [{ type: "text" as const, text: JSON.stringify({ issues }) }], details: { issues } };
        },
    })] : []),
  ];

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider("warmap", {
    name: "WarMap OpenAI-compatible Responses",
    baseUrl: normalizedBaseUrl(options.baseUrl),
    api: "openai-responses",
    streamSimple: options.streamSimple,
    models: [...new Set([options.modelId, options.compactionModelId ?? options.modelId])].map((id) => ({
      id,
      name: id,
      api: "openai-responses" as const,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    })),
  });
  await modelRuntime.setRuntimeApiKey("warmap", options.apiKey);
  const model = modelRuntime.getModel("warmap", options.modelId);
  if (!model) throw new Error(`Pi model not found: warmap/${options.modelId}`);
  const compactionModel = modelRuntime.getModel("warmap", options.compactionModelId ?? options.modelId);
  if (!compactionModel) throw new Error(`Pi compaction model not found: warmap/${options.compactionModelId}`);

  return {
    promptHash: createHash("sha256").update(SYSTEM_PROMPT).digest("hex"),
    modelSlot: "light",
    modelId: options.modelId,
    async run(input) {
      const search = options.search ?? unavailableWebSearchAdapter;
      let outletFeedRead = false;
      let searchCount = 0;
      let searchLimitReached = false;
      const searchBudgetError = Object.assign(new Error("Search limit reached (8)"), { code: "SEARCH_BUDGET_EXHAUSTED" });
      let abortSearchLoop: (() => Promise<void>) | undefined;
      const searchTool = defineTool({
        name: "web_search",
        label: "Web Search",
        description: "仅在内部材料不足时检索当前外部事实；证据充分后停止",
        parameters: WebSearchInput,
        execute: async (_id, args) => {
          searchCount += 1;
          const response = await search.search(args, input.signal);
          if (searchCount >= 8) {
            searchLimitReached = true;
            void abortSearchLoop?.();
            throw searchBudgetError;
          }
          const seen = new Set<string>();
          const results = response.results.flatMap((result) => {
            let url: string;
            try {
              url = new URL(result.url).toString();
            } catch {
              return [];
            }
            if (seen.has(url)) return [];
            seen.add(url);
            return [{ ...result, url }];
          });
          const value = { results, warnings: response.warnings };
          return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
        },
      });
      const outletFeedTools = options.outletFeed ? [defineTool({
        name: "read_outlet_feed",
        label: "限定发布方媒体",
        description: "读取当前 Radar 已启用发布方媒体（BBC、彭博、路透、金融时报、CNBC、经济学人等）窗口内的最新条目；不需要指定媒体，返回全部配置媒体。只能代表真实发布方来源，不是全网搜索。",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async () => {
          if (outletFeedRead) throw new Error("每轮对话最多读取一次发布方 feed；请基于已返回条目综合回答");
          // 读取失败不占用额度：否则一次网络抖动就让本轮再也拿不到来源
          const items = await options.outletFeed!(input.signal);
          outletFeedRead = true;
          const value = { items };
          return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
        },
      })] : [];
      const isCeo = input.viewer.role === "ceo";
      const personalCard = input.scope.startsWith("mission-card:");
      // The current card has already passed object authorization. The unscoped Mission query must not bypass that boundary.
      const viewerBoardTools = isCeo ? boardTools : boardTools.filter((tool) => !CEO_ONLY_TOOLS.has(tool.name) && !(personalCard && tool.name === "list_missions"));
      const materialScope = /^(issue|task|meeting):(.+)$/.exec(input.scope);
      const materialTools = materialScope && options.materialPool ? (() => {
        const ref = { objectType: materialScope[1] as "issue" | "task" | "meeting", objectId: materialScope[2] };
        const pool = options.materialPool!;
        const q = pool.query.bind(pool);
        const names = personDisplayNames(options.companyMemory);
        const viewer = input.viewer;
        const result = async (work: () => Promise<unknown>) => {
          try {
            const value = await work();
            return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
          } catch (cause) {
            if (!(cause instanceof ObjectMaterialError)) throw cause;
            const value = { error: cause.code, reason: cause.message, currentVersion: cause.version ?? null };
            return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
          }
        };
        return [
          defineTool({ name: "list_materials", label: "列出材料", description: "列出当前议题、执行事项或会议的群组材料",
            parameters: Type.Object({}, { additionalProperties: false }),
            execute: async () => result(async () => {
              const list = await listObjectMaterials(q, ref, viewer, names);
              return { materials: list.materials.map((m) => ({ id: m.id, fileName: m.fileName, format: m.format,
                editable: m.editable, version: m.version, owner: m.owner })) };
            }) }),
          defineTool({ name: "read_material", label: "阅读材料", description: "读取当前对象一份材料及版本；修改前必须调用。HTML 只返回最多 100,000 字符的源码，不返回去标签全文；截断时须用能唯一匹配的原文片段修改，或在文末追加",
            parameters: Type.Object({ materialId: Type.String({ format: "uuid" }), version: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }),
            execute: async (_id, args) => result(async () => {
              const material = await readObjectMaterial(q, ref, args.materialId, viewer, args.version);
              return { id: args.materialId, body: material.format === "html" ? material.body.slice(0, 100_000) : material.body,
                ...(material.format === "html" && material.body.length > 100_000 ? { truncated: true,
                  note: "材料太长只给了前 100,000 字符；改动请用能唯一匹配的原文片段，或在文末追加" } : {}), version: material.version,
                currentVersion: material.currentVersion, editable: material.format === "markdown" || material.format === "html" };
            }) }),
          defineTool({ name: "edit_material", label: "修改材料", description: "按当前版本修改 Markdown 或 HTML 材料；只在用户明确要求时使用。HTML 可能只读到前 100,000 字符；find 必须在完整源码中唯一匹配，append 会插在最后一个 </body> 前（没有时追加到文末）",
            parameters: Type.Object({ materialId: Type.String({ format: "uuid" }), baseVersion: Type.Integer({ minimum: 1 }),
              edits: Type.Array(Type.Union([
                Type.Object({ find: Type.String({ minLength: 1 }), replace: Type.String() }, { additionalProperties: false }),
                Type.Object({ append: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
              ]), { minItems: 1, maxItems: 20 }), summary: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
            execute: async (_id, args) => result(() => editObjectMaterial(pool, ref, args.materialId, viewer,
              args.baseVersion, args.edits, args.summary, input.runId ?? null)) }),
          defineTool({ name: "create_material", label: "新写材料", description: "在当前对象中新写 Markdown 材料；只在用户明确要求时使用",
            parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 237 }), body: Type.String({ minLength: 1, maxLength: 100000 }),
              summary: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
            execute: async (_id, args) => result(() => createObjectMaterial(pool, ref, viewer,
              args.title, args.body, args.summary, input.runId ?? null)) }),
          defineTool({ name: "propose_material_edit", label: "提议修改材料", description: "双方就当前材料的具体改法达成明确共识时提议；本人点『按这个改』才生效。先读最新版，find 必须唯一",
            parameters: Type.Object({ materialId: Type.String({ format: "uuid" }), summary: Type.String({ minLength: 1, maxLength: 200 }),
              edits: Type.Array(Type.Object({ find: Type.String({ minLength: 1 }), replace: Type.String() }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }) }, { additionalProperties: false }),
            execute: async (_id, args) => result(() => proposeMaterialEdit(pool, ref, args.materialId, viewer, args.summary, args.edits)) }),
        ];
      })() : [];
      // 复盘项对话：agent 只能给某一栏提改写建议，负责人点「采用」才写入；不经过 Action 签名，仓储函数锁内校验
      const reviewItemId = /^monthly-review-item:(.+)$/.exec(input.scope)?.[1];
      const reviewTools = reviewItemId && options.materialPool ? [defineTool({
        name: "propose_review_edit",
        label: "提改写建议",
        description: "给负责人某一栏复盘自评的改写建议；负责人点「采用」才写入。用户要求改写、或上传了手写复盘时使用",
        parameters: Type.Object({
          field: MonthlyReviewField,
          text: Type.String({ minLength: 1, maxLength: 4000 }),
          rationale: Type.String({ maxLength: 500 }),
        }, { additionalProperties: false }),
        execute: async (_id, args) => {
          const value = await proposeMonthlyReviewSuggestion(options.materialPool!, reviewItemId, input.viewer, args, new Date());
          return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value };
        },
      })] : [];
      const recreated = !validRuntimeEntries(input.runtimeEntries, input.piSessionId);
      const piSessionId = recreated ? randomUUID() : input.piSessionId;
      const warning = recreated ? "Pi runtime entries were corrupted; rebuilt from current object and recent raw messages" : undefined;
      const manager = SessionManager.inMemory(
        process.cwd(),
        { id: piSessionId },
        recreated ? undefined : structuredClone(input.runtimeEntries) as Parameters<typeof SessionManager.inMemory>[2],
      );
      if (recreated) {
        appendRecentMessages(manager, input.recentMessages ?? [], options.modelId);
        input.emit({ type: "warning", code: "RUNTIME_RECREATED", message: warning! });
      }
      const compactionSettings = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };
      const settings = SettingsManager.inMemory({ compaction: compactionSettings, retry: { enabled: false } });
      const { session } = await createAgentSession({
        model,
        modelRuntime,
        resourceLoader: isCeo ? ceoResourceLoader : resourceLoaderFor(driSystemPrompt(input.viewer.displayName, personalCard)),
        customTools: [...mcpTools, ...viewerBoardTools, ...materialTools, ...reviewTools, ...outletFeedTools, searchTool],
        tools: [...COMPANY_MEMORY_TOOLS, ...viewerBoardTools.map((tool) => tool.name), ...materialTools.map((tool) => tool.name), ...reviewTools.map((tool) => tool.name), ...outletFeedTools.map((tool) => tool.name), "web_search"],
        sessionManager: manager,
        settingsManager: settings,
        thinkingLevel: "off",
      });
      abortSearchLoop = () => session.abort();
      let checkpointDone = Promise.resolve();
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          input.emit({ type: "message", delta: event.assistantMessageEvent.delta });
        } else if (event.type === "tool_execution_start") {
          input.emit({ type: "tool", phase: "started", toolCallId: event.toolCallId, name: event.toolName });
        } else if (event.type === "tool_execution_end") {
          input.emit({ type: "tool", phase: "completed", toolCallId: event.toolCallId, name: event.toolName, isError: event.isError });
        } else if (event.type === "compaction_start") {
          input.emit({ type: "compaction", phase: "started" });
        } else if (event.type === "compaction_end" && event.result) {
          input.emit({ type: "compaction", phase: "completed" });
          const header = manager.getHeader();
          const entries = [...(header ? [header] : []), ...manager.getEntries()];
          checkpointDone = checkpointDone.then(() => input.checkpoint?.(entries));
        } else if (event.type === "message_end" && event.message.role === "assistant") {
          const usage = event.message.usage;
          input.emit({
            type: "usage",
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            totalTokens: usage.totalTokens,
          });
        }
      });
      const onAbort = () => void session.abort();
      input.signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (input.signal.aborted) throw new Error("Conversation aborted");
        const previousUsage = getLastAssistantUsage(manager.getEntries());
        if (previousUsage && shouldCompact(calculateContextTokens(previousUsage), model.contextWindow, compactionSettings)) {
          await session.setModel(compactionModel);
          await session.compact("保留 CEO WarMap 当前对象、证据来源、未决问题和明确结论；不要引入新事实。");
          await checkpointDone;
          await session.setModel(model);
        }
        const prompt = JSON.stringify({
          currentObject: input.currentObject,
          references: input.referencesSnapshot,
          globalContext: isCeo && input.scope === "global" && options.globalContext ? await options.globalContext() : null,
          message: input.message,
        });
        await session.prompt(prompt, { expandPromptTemplates: false, source: "rpc" });
        await checkpointDone;
        if (searchLimitReached) throw searchBudgetError;
        if (input.signal.aborted) throw new Error("Conversation aborted");
        const last = [...session.messages].reverse().find((item) => item.role === "assistant");
        if (!last || last.stopReason !== "stop") {
          throw new Error(last?.errorMessage || `Pi stopped without success: ${last?.stopReason ?? "missing response"}`);
        }
        const header = manager.getHeader();
        return {
          assistantMessage: session.getLastAssistantText() ?? "",
          runtimeEntries: [...(header ? [header] : []), ...manager.getEntries()],
          piSessionId,
          ...(warning ? { recovery: { recreated: true as const, warning } } : {}),
        };
      } finally {
        input.signal.removeEventListener("abort", onAbort);
        unsubscribe();
        session.dispose();
      }
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
