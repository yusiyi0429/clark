import { fallbackModelFor, streamFastResponse, type ResponsesClientOptions } from './conversationRouting.js';
import type { MemoryKind } from './personalMemory.js';

/**
 * 个人记忆的召回：每轮让快模型（MEMORY_RECALL_MODEL，见 memoryRecallModels）读一遍本人现行记忆的目录（编号、日期、类别、标题、正文开头），挑出这一轮用得上的条目。
 * 字面重合认不出换说法、上位概念和跨话题相关（10/18 冒烟：「还有哪些没定」对不上「还没想好……扩编」）。
 * 实验（.scratch/memory-recall/结论.md）：300 条记忆、79 条查询，召回率 0.69 → 0.94–0.96，精确率 0.25 → 0.88–0.94，干扰问题误召回 100% → 0%；
 * 目录约 1.5 万 token，旧条目在前、新条目追加在末尾，前缀可被网关缓存；挑选与分诊同时跑。约 500 条以上要换分层目录或向量预筛（见结论）。
 * 失败、超时或没配模型时由 personalMemory.ts 退回字面重合。
 */
export type RecallCandidate = { id: string; kind: MemoryKind; title: string; text: string; createdAt: string };
export type MemoryRecall = (input: { message: string; items: RecallCandidate[] }) => Promise<string[]>;

/** 一轮最多挑几条（偏好类常驻，不占这个数）：实验里 8 条时上位概念类问题（「渠道这块我的思路」）召回 0.82–0.84，放到 12 条升到 0.91–0.92，精确率只降 0.02–0.04。 */
export const RECALL_LIMIT = 12;
/**
 * 召回用哪个快模型：MEMORY_RECALL_MODEL，没配时依次退回 TRIAGE_MODEL、LIGHT_MODEL；出错时换 LIGHT_MODEL 再挑一次。
 * 与分诊分开配：推荐 deepseek-v4.1-flash（实验 300 条召回 0.96、P90 约 1.7 秒），分诊模型不受影响。
 */
export function memoryRecallModels(env: { memoryRecallModel?: string; triageModel?: string; lightModel: string }): { modelId: string; fallbackModelId: string } {
    return { modelId: env.memoryRecallModel || env.triageModel || env.lightModel, fallbackModelId: env.lightModel };
}

/** 整次召回的时限：主回答拼上下文包时会等它；分诊本身最多 5 秒，300 条时 terra 的 P90 约 3.8 秒、DeepSeek 约 1.6 秒。 */
export const RECALL_TIMEOUT_MS = 6_000;
const SNIPPET_CHARS = 60;
const KIND_LABEL: Record<MemoryKind, string> = { idea: '想法', stance: '立场', open_question: '未决问题', reason: '理由', preference: '偏好', practice: '做法' };
const companyDay = (at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

export const RECALL_PROMPT = `你替一位用户从他的个人记忆里挑出这一轮回答用得上的条目，交给主助手参考。每条记忆是他自己以前说过的想法、立场、还没定的问题、理由或做法。
挑选规则：
- 直接相关的要选；问题没明说、但他的这些想法会影响怎么回答的也要选（比如问要不要加人，他关于人效、预算、现金的立场也算）。
- 问题只提了上位概念（比如「渠道」「组织」「明年」）时，选这个范围里最核心的几条。
- 他在问自己以前说过的某句话时，把那条找出来，措辞不同也要认得出。
- 同一件事前后说法不同时，较新的那条一定要选，旧的可以一起选。
- 和他个人想法无关的问题（常识、翻译、计算、写诗、闲聊、外部新闻等）返回空数组，不要硬凑。
最多 ${RECALL_LIMIT} 条，最相关的在前。只输出 JSON：{"ids":["M3","M17"]}`;

/** 目录按时间先后排（新条目追加在末尾，目录前缀不变，网关能缓存）；编号 M1… 只在这一次调用里有效，模型不接触真实 id。 */
export function recallDirectory(items: RecallCandidate[]): string {
    return items.map((item, index) => {
        const text = item.text.replace(/\s+/g, ' ').trim();
        return `M${index + 1}｜${companyDay(new Date(item.createdAt))}｜${KIND_LABEL[item.kind] ?? item.kind}｜${item.title}：${text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS)}…` : text}`;
    }).join('\n');
}

/** 取模型输出里的 {"ids":[…]}，编号换回真实 id；编出来的编号丢掉。解析不出来返回 null（空数组是「这一轮没有相关记忆」）。 */
export function parseRecall(text: string, items: RecallCandidate[]): string[] | null {
    const match = /\{[\s\S]*?\}/.exec(text);
    if (!match) return null;
    try {
        const value = JSON.parse(match[0]) as { ids?: unknown };
        if (!Array.isArray(value.ids)) return null;
        const ids = value.ids.map((handle) => items[Number(String(handle).trim().replace(/^M/i, '')) - 1]?.id).filter((id): id is string => Boolean(id));
        return [...new Set(ids)].slice(0, RECALL_LIMIT);
    } catch {
        return null;
    }
}

/** 网宿 Responses 网关上的召回：快模型、关思考，读到第一个完整 JSON 就停；出错时限里还来得及就换备用模型再挑一次，都不行就抛错。 */
export function createMemoryRecall(options: ResponsesClientOptions & { timeoutMs?: number; now?: () => Date }): MemoryRecall {
    return async ({ message, items }) => {
        if (!items.length) return [];
        const ordered = [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
        const instructions = `${RECALL_PROMPT}\n\n个人记忆目录（编号｜日期｜类别｜标题：内容开头）：\n${recallDirectory(ordered)}`;
        const input = `今天是 ${companyDay(options.now?.() ?? new Date())}。本轮问题：${message.slice(0, 2_000)}`;
        const budgetMs = options.timeoutMs ?? RECALL_TIMEOUT_MS;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), budgetMs);
        const startedAt = Date.now();
        const attempt = (modelId: string) => streamFastResponse({ ...options, modelId }, { instructions, input, maxOutputTokens: 200, signal: controller.signal },
            (text) => (/\}/.test(text) ? parseRecall(text, ordered) ?? undefined : undefined))
            .then((result) => (result ? result.early ?? parseRecall(result.text, ordered) : null), () => null);
        try {
            const first = await attempt(options.modelId);
            if (first) return first;
            const fallback = fallbackModelFor(options, { signal: controller.signal, startedAt, budgetMs, minRemainingMs: 2_000, what: '个人记忆召回' });
            const second = fallback ? await attempt(fallback) : null;
            if (second) return second;
            throw Object.assign(new Error('Personal memory recall failed'), { code: controller.signal.aborted ? 'PERSONAL_MEMORY_RECALL_TIMEOUT' : 'PERSONAL_MEMORY_RECALL_FAILED' });
        } finally {
            clearTimeout(timer);
        }
    };
}
