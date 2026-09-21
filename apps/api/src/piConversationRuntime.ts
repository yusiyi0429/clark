import { createHash, randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  COMPANY_MEMORY_TOOLS,
  GetPassagesInput,
  ListSectionsInput,
  SearchPeopleInput,
  SearchSectionsInput,
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
import { createCompanyMemoryMcpServer } from "./mcpCompanyMemory.js";
import { unavailableWebSearchAdapter, type WebSearchAdapter } from "./webSearch.js";

const SYSTEM_PROMPT = `# 角色

你是 Clark，词元云集 CEO WarMap 的只读决策对话助手。用 CEO 所用的语言回复，避免空话。

# 工作方式

- 结论先行，再给依据。
- 经营与战略问题按麦肯锡合伙人级别的顾问标准处理：深挖、结构化、给出取舍。
- 问题立场不明确时用双向钢人论证，即把对立两方各自最强的版本摆出来，再下判断。

# 每轮注入的上下文

每轮输入是一个 JSON，只有三部分。\`currentObject\` 是当前页面对象的 Card 快照，含完整业务字段，Meeting 还附带本场关联 Issue。\`references\` 是本轮 CEO 显式引用的 Card 快照。\`message\` 是 CEO 本轮原话。

优先使用 currentObject 与 references，不要用历史对话猜测当前对象的最新状态。

# 只读边界

内部证据、外部证据与你自己的推断必须分开标注。外部事实用来源标题与 URL 标注，公司事实用企业知识章节与段落标注。面向 CEO 的表述中，公司知识库一律称“企业知识”，不要出现 CompanyMemory 这个词。

你不能执行任何业务写入：不能创建或升级 Issue，不能修改 ResearchDoc，不能确认、分派、签发或撤回任何事项，也不能写入文件或记忆。企业知识对你只读。你产出的是候选材料，只有 CEO 自己的 Action 才形成公司事实。本运行没有文件系统工具，不要声称读过或写过本地文件。

需要 CEO 做决定时，直接说明该决定什么、代价是什么，由 CEO 自己执行。CEO 的要求超出只读权限时，说明边界并给出可执行的下一步。

# 工具

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

# 表达禁令

覆盖对话和产出。禁的是修辞动作，不是字面：换一套字做同一个动作仍算命中。原话命中时改成转述或省略，不能靠引号保留。

1. 翻案腔。先立一个读者并没有的误解再推翻它抬价。外衣包括"不是……而是……""并非……而是……""不在于……而在于……""与其说……不如说……""表面/看似……实际/实则……""你以为……其实……""说到底""答案恰恰相反""A不重要，重要的是B"及一切变形。判断从正面直接下。
2. 三项以上同构排比。两项为限，第三项换说法或删掉。
3. 给抽象名词配具体动词抒情（"时间不会保管细节"）。写具体事物时不受影响。
4. 动词名词化。"完成了对流程的优化"写成"把流程改顺了"，"实现了效率的提升"写成"快了多少、省了几个人"。
5. 破折号 —、——、–。
6. 提示性冒号（"核心是："）。冒号只用于引出直接原话；网址、代码、机器字段除外。
7. "说白了""说穿了""先说结论"。
8. 洞察路标："更微妙的是""还有一层""只说对了一半""值得注意的是""需要指出的是""从某种意义上说"。说本义时不受影响。
9. 商业与模型黑话（赋能、抱团、闭环、拉齐、彻底重塑、重新定义等）。
10. 非虚构中用借喻包装抽象概念（仓库、抽屉、温度、死亡、坍塌、浪潮、钥匙、底座等）。真写这些东西时不受影响。`;

const resourceLoader: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => SYSTEM_PROMPT,
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => undefined,
  reload: async () => undefined,
};

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
  /** 只读查询当前 pending Issue；未提供时不暴露 list_pending_issues 工具。 */
  listPendingIssues?: () => Promise<PendingIssueSummary[]>;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  compactionModelId?: string;
  search?: WebSearchAdapter;
  /** 读取当前 Radar 已启用发布方 feed；未提供时不暴露 read_outlet_feed。 */
  outletFeed?: (signal: AbortSignal) => Promise<TRadarSourceItem[]>;
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
    defineTool({ name: "list_sections", label: "企业知识章节", description: "列出企业知识章节", parameters: ListSectionsInput, execute: async (_id, args) => call("list_sections", args) }),
    defineTool({ name: "search_sections", label: "搜索企业知识", description: "搜索相关企业知识章节", parameters: SearchSectionsInput, execute: async (_id, args) => call("search_sections", args) }),
    defineTool({ name: "get_passages", label: "读取企业知识", description: "读取指定章节段落", parameters: GetPassagesInput, execute: async (_id, args) => call("get_passages", args) }),
    defineTool({ name: "search_people", label: "查询人员", description: "查询稳定人员目录", parameters: SearchPeopleInput, execute: async (_id, args) => call("search_people", args) }),
  ];
  const listPendingIssues = options.listPendingIssues;
  const boardTools = listPendingIssues
    ? [defineTool({
        name: "list_pending_issues",
        label: "待决策议题",
        description: "列出当前所有待 CEO 决策的 Issue（实时看板数据，只读）",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async () => {
          const issues = await listPendingIssues();
          return { content: [{ type: "text" as const, text: JSON.stringify({ issues }) }], details: { issues } };
        },
      })]
    : [];

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
        resourceLoader,
        customTools: [...mcpTools, ...boardTools, ...outletFeedTools, searchTool],
        tools: [...COMPANY_MEMORY_TOOLS, ...boardTools.map((tool) => tool.name), ...outletFeedTools.map((tool) => tool.name), "web_search"],
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
