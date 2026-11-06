/**
 * 对本机「开始」一张卡或一个专题（V2 设计第 6.2 节）：交代从云端取（原样作为第一句话），模型和文件夹本人选（记住上一次）。
 * 卡的模型同时记到云端的卡上（只存名字）。云端接口还没有时，卡的交代用标题和完成标准拼一段。
 */
import type { TLocalModelProfile, TLocalSessionSummary } from "./runner";
import type { LocalRunner } from "./runner";
import { cardBrief, patchCard, topicBrief, CloudError } from "@/lib/board/cloud";
import type { CardItem } from "@/lib/board/cards";
import { cardRole, roleSection, rolesStubbed, setCardRole, type RoleView } from "@/lib/team/roles";

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
 * 换了岗位先记到卡上（交代按卡上的岗位出，第 19.4 节），再取交代。岗位接口还是桩时云端的交代里没有岗位，就把岗位的几段放在交代前面。
 */
export async function startCard(runner: LocalRunner, item: CardItem, model: TLocalModelProfile, cwd: string, role: RoleView | null = null): Promise<TLocalSessionSummary> {
  let version = item.version;
  if (role && role.id !== cardRole(item)?.id) version = (await setCardRole(item.id, version, { id: role.id, name: role.name })) ?? version;
  let brief: string;
  try {
    brief = (await cardBrief(item.id)).markdown;
  } catch (error) {
    if (!(error instanceof CloudError) || error.status !== 404) throw error;
    brief = fallbackCardBrief(item);
  }
  if (role && rolesStubbed()) brief = `${roleSection(role)}\n\n${brief}`;
  // 模型记到卡上（别的设备上看得到这张卡用的什么）；记不上不耽误开工。
  void patchCard(item.id, { version, model: { id: model.id, label: model.label, kind: model.source } }).catch(() => undefined);
  return runner.createSession({ subject: { kind: "card", cardId: item.id }, title: item.title.slice(0, 120), cwd, modelProfileId: model.id, firstMessage: brief });
}

export async function startTopic(runner: LocalRunner, topic: { id: string; title: string }, model: TLocalModelProfile): Promise<TLocalSessionSummary> {
  let brief: string;
  try {
    brief = (await topicBrief(topic.id)).markdown;
  } catch (error) {
    if (!(error instanceof CloudError) || error.status !== 404) throw error;
    brief = `# 调研专题：${topic.title}`;
  }
  return runner.createSession({ subject: { kind: "topic", topicId: topic.id }, title: topic.title.slice(0, 120), modelProfileId: model.id, firstMessage: brief });
}
