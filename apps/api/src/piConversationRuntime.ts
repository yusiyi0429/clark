import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  COMPANY_MEMORY_TOOLS,
  GetPassagesInput,
  ListSectionsInput,
  SearchPeopleInput,
  SearchSectionsInput,
} from "@warmap/contracts";
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
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

const SYSTEM_PROMPT = `你是 CEO WarMap 的只读决策对话助手。
优先使用本轮注入的当前对象与 Card 引用；需要公司背景时调用 CompanyMemory 只读工具。
明确区分内部证据与推断。你不能执行任何业务写入，不能创建 Issue、修改 ResearchDoc，也不能声称已确认、分派、签发或撤回。`;

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
  streamSimple?: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
};

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/+$/, "").replace(/\/responses$/, "");
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
  const tools = [
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
    models: [{
      id: options.modelId,
      name: options.modelId,
      api: "openai-responses",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    }],
  });
  await modelRuntime.setRuntimeApiKey("warmap", options.apiKey);
  const model = modelRuntime.getModel("warmap", options.modelId);
  if (!model) throw new Error(`Pi model not found: warmap/${options.modelId}`);

  return {
    async run(input) {
      const manager = SessionManager.inMemory(
        process.cwd(),
        { id: input.piSessionId },
        structuredClone(input.runtimeEntries) as Parameters<typeof SessionManager.inMemory>[2],
      );
      const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const { session } = await createAgentSession({
        model,
        modelRuntime,
        resourceLoader,
        customTools: tools,
        tools: [...COMPANY_MEMORY_TOOLS],
        sessionManager: manager,
        settingsManager: settings,
        thinkingLevel: "off",
      });
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          input.emit({ type: "message", delta: event.assistantMessageEvent.delta });
        } else if (event.type === "tool_execution_start") {
          input.emit({ type: "tool", phase: "started", toolCallId: event.toolCallId, name: event.toolName });
        } else if (event.type === "tool_execution_end") {
          input.emit({ type: "tool", phase: "completed", toolCallId: event.toolCallId, name: event.toolName, isError: event.isError });
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
        const prompt = JSON.stringify({
          currentObject: input.currentObject,
          references: input.referencesSnapshot,
          message: input.message,
        });
        await session.prompt(prompt, { expandPromptTemplates: false, source: "rpc" });
        if (input.signal.aborted) throw new Error("Conversation aborted");
        const last = [...session.messages].reverse().find((item) => item.role === "assistant");
        if (!last || last.stopReason !== "stop") {
          throw new Error(last?.errorMessage || `Pi stopped without success: ${last?.stopReason ?? "missing response"}`);
        }
        const header = manager.getHeader();
        return {
          assistantMessage: session.getLastAssistantText() ?? "",
          runtimeEntries: [...(header ? [header] : []), ...manager.getEntries()],
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
