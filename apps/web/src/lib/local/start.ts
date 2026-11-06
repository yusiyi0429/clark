/**
 * 对本机「开始」一张卡或一个专题（V2 设计第 6.2、19.5 节）：交代从云端取（markdown 原样作为第一句话，岗位原样转给本机），
 * 模型和文件夹本人选（记住上一次）。卡的模型同时记到云端的卡上（只存名字）。云端接口还没有时，卡的交代用标题和完成标准拼一段。
 */
import type { TLocalCreateSessionRequest, TLocalModelProfile, TLocalSessionSummary } from "./runner";
import type { LocalRunner } from "./runner";
import { cardBrief, patchCard, planBrief, topicBrief, CloudError } from "@/lib/board/cloud";
import type { CardItem } from "@/lib/board/cards";
import { cardRole, localRole, modelForTier, setCardRole, type RoleView } from "@/lib/team/roles";

const LAST_KEY = "tianshu-local-last-v1";
type Last = { modelId?: string; folderId?: string };

export function readLast(): Last {
  try { return JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}") as Last; } catch { return {}; }
}
export function writeLast(last: Last): void {
  try { localStorage.setItem(LAST_KEY, JSON.stringify({ ...readLast(), ...last })); } catch { /* 记不住就下次再选 */ }
}

export function fallbackCardBrief(item: CardItem): string {
  const standards = (item.doneDefinition ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return [`# ${item.title}`, item.mission ? `Mission：${item.mission.title}` : null, standards.length ? `完成标准：\n${standards.map((line, i) => `${i + 1}. ${line}`).join("\n")}` : null]
    .filter(Boolean).join("\n\n");
}

/**
 * 一张卡的开工请求：换了岗位先记到卡上（交代按卡上的岗位出），再取交代；模型记到卡上（记不上不耽误开工）。
 * 单开和一批开工（派活单）都用它。
 */
export async function cardStartRequest(item: CardItem, model: TLocalModelProfile, cwd: string, role: RoleView | null = null): Promise<TLocalCreateSessionRequest> {
  let version = item.version;
  if (role && role.id !== cardRole(item)?.id) version = await setCardRole(item.id, version, role);
  let firstMessage: string;
  let brief: Awaited<ReturnType<typeof cardBrief>> | null = null;
  try {
    brief = await cardBrief(item.id);
    firstMessage = brief.markdown;
  } catch (error) {
    if (!(error instanceof CloudError) || error.status !== 404) throw error;
    firstMessage = fallbackCardBrief(item);
  }
  void patchCard(item.id, { version, model: { id: model.id, label: model.label, kind: model.source } }).catch(() => undefined);
  // 要等的前面的卡（E 把卡上的 after 合进来之前，有就读）：本机等它们在这台电脑上合回再开始。
  const after = (item.card as { after?: string[] } | null | undefined)?.after ?? [];
  return { subject: { kind: "card", cardId: item.id }, title: item.title.slice(0, 120), cwd, modelProfileId: model.id, firstMessage, ...(brief?.role ? { role: localRole(brief.role) } : {}),
    ...(after.length ? { after } : {}) };
}

export async function startCard(runner: LocalRunner, item: CardItem, model: TLocalModelProfile, cwd: string, role: RoleView | null = null): Promise<TLocalSessionSummary> {
  return runner.createSession(await cardStartRequest(item, model, cwd, role));
}

/** 专题：交代带岗位和评审会用的挑刺岗位（critics 是本人点的那几个，不点用团队里的前三个），本机从最新一版往下编号。 */
export async function startTopic(runner: LocalRunner, topic: { id: string; title: string }, model: TLocalModelProfile, critics?: string[]): Promise<TLocalSessionSummary> {
  let request: TLocalCreateSessionRequest = { subject: { kind: "topic", topicId: topic.id }, title: topic.title.slice(0, 120), modelProfileId: model.id, firstMessage: `# 调研专题：${topic.title}` };
  try {
    const brief = await topicBrief(topic.id, critics);
    request = { ...request, firstMessage: brief.markdown, ...(brief.latestVersion ? { versionBase: brief.latestVersion } : {}),
      ...(brief.role ? { role: localRole(brief.role) } : {}), ...(brief.critics.length ? { critics: brief.critics.map(localRole) } : {}) };
  } catch (error) {
    if (!(error instanceof CloudError) || error.status !== 404) throw error;
  }
  return runner.createSession(request);
}

/**
 * 规划员的开工请求（第 21.3 节）：交代从云端取（GET /api/plan-tasks/:taskId/plan-brief，markdown 原样作为第一句话，规划员岗位原样转给本机），
 * 模型按规划员岗位的档位挑（没配岗位按强档）；不给目录时本机给它建一个专用目录。
 */
export async function planStartRequest(taskId: string, models: TLocalModelProfile[], cwd: string | undefined): Promise<TLocalCreateSessionRequest> {
  const brief = await planBrief(taskId);
  const model = modelForTier(models, brief.role?.modelTier ?? "strong");
  return { subject: { kind: "plan", taskId }, title: `拆卡：${brief.task.name}`.slice(0, 120), ...(cwd ? { cwd } : {}), ...(model ? { modelProfileId: model.id } : {}),
    firstMessage: brief.markdown, ...(brief.role ? { role: localRole(brief.role) } : {}) };
}
