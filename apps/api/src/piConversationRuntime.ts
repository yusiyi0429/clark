import { createHash, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  COMPANY_MEMORY_TOOLS,
  GetPassagesInput,
  ListSectionsInput,
  SearchPeopleInput,
  SearchSectionsInput,
  WebSearchInput,
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

const SYSTEM_PROMPT = `你是 CEO WarMap 的只读决策对话助手。
优先使用本轮注入的当前对象与 Card 引用；需要公司背景时调用 CompanyMemory 只读工具。仅在这些内部材料不足以回答当前外部事实时调用 web_search，证据充分后立即停止搜索。
回答必须明确分开标注内部证据、外部证据与推断。你不能执行任何业务写入，不能创建 Issue、修改 ResearchDoc，也不能声称已确认、分派、签发或撤回。`;

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

export type PiConversationRuntimeOptions = {
  companyMemory: CompanyMemoryRepository;
  baseUrl: string;
  apiKey: string;
  modelId: string;
  compactionModelId?: string;
  search?: WebSearchAdapter;
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
    defineTool({ name: "list_sections", label: "CompanyMemory 章节", description: "列出公司记忆章节", parameters: ListSectionsInput, execute: async (_id, args) => call("list_sections", args) }),
    defineTool({ name: "search_sections", label: "搜索 CompanyMemory", description: "搜索相关公司记忆章节", parameters: SearchSectionsInput, execute: async (_id, args) => call("search_sections", args) }),
    defineTool({ name: "get_passages", label: "读取 CompanyMemory", description: "读取指定章节段落", parameters: GetPassagesInput, execute: async (_id, args) => call("get_passages", args) }),
    defineTool({ name: "search_people", label: "查询人员", description: "查询稳定人员目录", parameters: SearchPeopleInput, execute: async (_id, args) => call("search_people", args) }),
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
        customTools: [...mcpTools, searchTool],
        tools: [...COMPANY_MEMORY_TOOLS, "web_search"],
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
