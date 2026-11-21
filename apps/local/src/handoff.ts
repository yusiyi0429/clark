import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TLocalAgentKind, TLocalSessionEvent } from "@warmap/contracts";
import { homeDir } from "./agents/claudeEnv.js";

/**
 * 换执行方时接上下文、两边规矩一致（契约 LocalSessionModelRequest「换执行方」）。都不调模型：
 * - 从事件记录里把轮次整理成字：本人说的、执行方回的原样，工具调用一行一个（「运行 git status → ok」）；
 * - 换过去的那家只补它没看到的最近几轮（handoffText），更早的它用本会话 MCP 的 read_earlier_turns 翻（earlierTurns）；
 * - 仓库里只有 CLAUDE.md 时它的内容一并给 Codex，只有 AGENTS.md 时给 Claude Code（otherRules，本机不往仓库里写文件）。
 */
export const AGENT_NAME: Record<TLocalAgentKind, string> = { "claude-code": "Claude Code", codex: "Codex" };

/** 一次最多带几轮、总共多少字（同项目对话接上下文的口径：最近 8 轮、约 4 万字；最新那一轮再长也带）；read_earlier_turns 一次最多几轮。 */
export const HANDOFF_TURNS = 8;
const PAGE_CHARS = 40_000;
const MAX_PAGE_TURNS = 20;
/** 执行方的一段话最多带多少字（本人的一句话契约里最多 2 万字，原样带）、一轮最多带多少步工具调用（只留最后这些）、改动文件最多列多少个、另一家的规矩文件最多带多少字。 */
const TEXT_CHARS = 20_000;
const TOOL_LINES = 40;
const FILE_NAMES = 50;
const RULES_CHARS = 20_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…（共 ${s.length} 字）` : s);

/**
 * 一轮：到 turn_end 为止；换执行方的地方也断开（原来那家没做完就停了的那一段自成一轮，不和新的那家的第一轮混在一起）。
 * n 从 1 起，整个会话里连着编；firstSeq 是这一轮第一条内容的事件序号。
 */
export interface Turn { n: number; firstSeq: number; agent: TLocalAgentKind | null; lines: string[] }

const STOPPED: Record<string, string> = { interrupted: "本人停下了", usage_limit: "额度用完了", balance: "余额不足", auth: "登录失效了" };

export function turnsOf(events: TLocalSessionEvent[]): Turn[] {
  const turns: Turn[] = [];
  let agent: TLocalAgentKind | null = null;
  let firstSeq = 0;
  /** 按先后：本人说的、执行方说的、旁注、一步工具调用（结果回来了补上「→ ok」）。 */
  let items: { who: "user" | "agent" | "note" | "tool"; text: string; id?: string }[] = [];
  const flush = () => {
    const name = agent ? AGENT_NAME[agent] : "执行方";
    const extra = items.filter((i) => i.who === "tool").length - TOOL_LINES;
    let skip = Math.max(0, extra);
    const lines: string[] = [];
    for (const i of items) {
      if (i.who === "tool" && skip > 0) {
        if (skip-- === extra) lines.push(`（这里还有 ${extra} 步工具调用没列）`);
        continue;
      }
      lines.push(i.who === "user" ? `本人：${i.text}` : i.who === "agent" ? `${name}：${i.text}` : i.who === "tool" ? `· ${i.text}` : `（${i.text}）`);
    }
    if (lines.length) turns.push({ n: turns.length + 1, firstSeq, agent, lines });
    items = [];
    firstSeq = 0;
  };
  for (const e of events) {
    switch (e.type) {
      case "agent_info": agent = e.agent; break;
      case "user_message": {
        // 附件的路径不在原话里（事件里的 text 是本人说的原话）：接在后面，只带附件没说话的也算一句
        const files = e.attachments?.length ? `（附件：${e.attachments.map((a) => a.path).join("、")}）` : "";
        if (e.text.trim() || files) items.push({ who: "user", text: `${e.text}${files}` });
        break;
      }
      case "assistant_text": items.push({ who: "agent", text: clip(e.text, TEXT_CHARS) }); break;
      case "tool_call": items.push({ who: "tool", text: e.title, id: e.toolUseId }); break;
      case "tool_result": {
        const t = items.find((x) => x.who === "tool" && x.id === e.toolUseId);
        if (t) t.text += e.isError ? ` → 出错：${clip(e.preview.split("\n")[0] ?? "", 120)}` : " → ok";
        break;
      }
      case "question": items.push({ who: "agent", text: `（问本人）${e.request.questions.map((q) => q.question).join("；")}` }); break;
      case "question_resolved": {
        const answer = [...(e.choices ?? []).flat(), ...(e.text ? [e.text] : [])].join("；");
        if (answer) items.push({ who: "user", text: `（回答）${answer}` });
        break;
      }
      case "handback": items.push({ who: "note", text: `交回了：${clip(e.summary, 500)}` }); break;
      case "verdict": items.push({ who: "note", text: `验收${e.passed ? "过了" : "没过"}：${clip(e.summary, 500)}` }); break;
      case "turn_end":
        if (e.isError) items.push({ who: "note", text: `这一轮没做完：${STOPPED[e.errorKind ?? ""] ?? "出错了"}` });
        if (!firstSeq) firstSeq = e.seq;
        flush();
        break;
      case "notice":
        // 换了执行方：原来那家还开着的一轮（强停、额度用完直接退出，没有 turn_end）到这里为止
        if (e.code === "harness_changed") {
          if (items.some((i) => i.who !== "note")) items.push({ who: "note", text: "这一轮没做完就停了" });
          flush();
          agent = null;
        }
        break;
      default: break;
    }
    if (!firstSeq && items.length) firstSeq = e.seq;
  }
  flush();
  return turns;
}

function render(turns: Turn[]): string {
  return turns.map((t) => [`— 第 ${t.n} 轮${t.agent ? `（${AGENT_NAME[t.agent]}）` : ""} —`, ...t.lines].join("\n")).join("\n\n");
}

/** 从最新的往前取：最多 max 轮、总共约 PAGE_CHARS 字以内（最新那一轮再长也带）；返回从早到晚。 */
function latest(turns: Turn[], max: number): Turn[] {
  const page: Turn[] = [];
  let chars = 0;
  for (const t of turns.slice().reverse()) {
    chars += t.lines.reduce((n, l) => n + l.length, 0);
    if (page.length && (page.length >= max || chars > PAGE_CHARS)) break;
    page.unshift(t);
  }
  return page;
}

/**
 * 接着做的交代：这一家没看到的轮次（事件序号在 seen 之后开始的）里最近几轮，再附上工作目录里 git 看得到的改动文件。
 * 接在给它的下一句话前面；没有它没看到的轮次就是 null。
 */
export function handoffText(events: TLocalSessionEvent[], seen: number, files: string[], readTool: string): string | null {
  const unseen = turnsOf(events).filter((t) => t.firstSeq > seen);
  if (!unseen.length) return null;
  const shown = latest(unseen, HANDOFF_TURNS);
  const who = [...new Set(shown.map((t) => (t.agent ? AGENT_NAME[t.agent] : null)).filter(Boolean))].join("、") || "别的执行方";
  const older = unseen.length > shown.length ? `更早的用 ${readTool}（before=${shown[0]!.n}）翻。` : "";
  const changed = files.length ? `\n\n工作目录里有改动的文件（git）：${files.slice(0, FILE_NAMES).join("、")}${files.length > FILE_NAMES ? ` 等 ${files.length} 个` : ""}` : "";
  return [
    `［接着做］这件事之前是 ${who} 在做，现在换你接着做。下面是你没看到的最近 ${shown.length} 轮（本人说的、它回的原样，工具调用一行一个）。${older}`,
    render(shown) + changed,
    "［以上是之前的经过。下面是现在要你做的］",
  ].join("\n\n");
}

/** read_earlier_turns：第 before 轮之前的 limit 轮（before 不带从最新一轮起），从早到晚；太长就少给几轮。 */
export function earlierTurns(events: TLocalSessionEvent[], before: number | undefined, limit: number | undefined): string {
  const all = turnsOf(events);
  const page = latest(all.filter((t) => before === undefined || t.n < before), Math.min(Math.max(limit ?? HANDOFF_TURNS, 1), MAX_PAGE_TURNS));
  if (!page.length) return "没有更早的轮次了。";
  const first = page[0]!.n;
  return `这个会话一共 ${all.length} 轮，下面是第 ${first}–${page.at(-1)!.n} 轮。${first > 1 ? `更早的带 before=${first} 再翻。` : "这就是最早的了。"}\n\n${render(page)}`;
}

/**
 * 另一家的规矩文件：Claude Code 自己读 CLAUDE.md、Codex 自己读 AGENTS.md。从工作目录往上到仓库根（有 .git 的那一层；不在仓库里就只看工作目录），
 * 哪一层只有另一家那份，就把它的内容接进本会话的系统提示词，两边照同一份规矩做。两份都有就各读各的。本人主目录那一层不看（那是本人的全局记忆，干净会话不带）。
 */
export function otherRules(agent: TLocalAgentKind, cwd: string): string {
  const [own, other] = agent === "codex" ? ["AGENTS.md", "CLAUDE.md"] : ["CLAUDE.md", "AGENTS.md"];
  let dirs = [cwd];
  for (let d = cwd; !existsSync(join(d, ".git")); d = dirname(d)) {
    if (dirname(d) === d) { dirs = [cwd]; break; }
    dirs.unshift(dirname(d));
  }
  const home = homeDir();
  const parts: string[] = [];
  for (const dir of dirs) {
    if (dir === home || existsSync(join(dir, own)) || !existsSync(join(dir, other))) continue;
    let text = "";
    try { text = readFileSync(join(dir, other), "utf8").trim(); } catch { /* 读不了就不带 */ }
    if (text) parts.push(`## 这个仓库的规矩（${join(dir, other)}）\n这个仓库的规矩写在 ${other} 里，照着做：\n\n${clip(text, RULES_CHARS)}`);
  }
  return parts.length ? `\n${parts.join("\n\n")}\n` : "";
}
