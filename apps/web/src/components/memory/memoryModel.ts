import type { components } from "@/lib/api/schema";

export type MemoryItem = components["schemas"]["PersonalMemoryItem"];
export type MemoryImport = components["schemas"]["MemoryImport"];
export type MemoryImportDetail = components["schemas"]["MemoryImportDetail"];
export type ImportCandidate = MemoryImportDetail["candidates"][number];
export type ImportSource = MemoryImport["source"];

/** 「我的记忆」页的四组（7a-2）：kind → 组。理由（reason）跟想法、立场放一起。 */
export const MEMORY_GROUPS = [
  { id: "preference", label: "偏好与表达方式", kinds: ["preference"] },
  { id: "practice", label: "做法", kinds: ["practice"] },
  { id: "thinking", label: "想法与立场", kinds: ["idea", "stance", "reason"] },
  { id: "open", label: "没定的问题", kinds: ["open_question"] },
] as const satisfies readonly { id: string; label: string; kinds: readonly MemoryItem["kind"][] }[];

export function groupMemories(items: MemoryItem[]) {
  return MEMORY_GROUPS.map((group) => ({ ...group, items: items.filter((item) => (group.kinds as readonly string[]).includes(item.kind)) }))
    .filter((group) => group.items.length);
}

export const SOURCE_LABEL: Record<ImportSource, string> = { chatgpt: "ChatGPT", claude: "Claude", claude_code: "Claude Code", codex: "Codex" };

/** 出处 ref 的来源：对话（chat:）、导入（import:<来源>:…）、别的对象。 */
export function referenceSource(ref: string): string {
  if (ref.startsWith("chat:")) return "对话";
  const imported = /^import:([a-z_]+):/.exec(ref);
  if (imported) return SOURCE_LABEL[imported[1] as ImportSource] ?? "导入";
  return "资料";
}

const ANCHOR_TYPE: Record<string, string> = { issue: "议题", meeting: "会议", mission: "Mission", task: "执行事项", signal: "信号", "mission-card": "Mission 卡", "monthly-plan": "月计划", "personal-review": "复盘", "monthly-review-item": "复盘" };
/** anchor（关于什么）：主题直接写主题；对象写类型和现在的标题，没查到标题只写类型。 */
export function anchorLabel(anchor: MemoryItem["anchors"][number]): string {
  const split = anchor.target.indexOf(":");
  const type = anchor.target.slice(0, split), rest = anchor.target.slice(split + 1);
  if (type === "topic") return rest;
  const name = ANCHOR_TYPE[type] ?? type;
  return anchor.title ? `${name} · ${anchor.title}` : name;
}
/** 对象 anchor 的页面地址（按身份）；主题和没有页面的类型返回 null。 */
export function anchorHref(anchor: MemoryItem["anchors"][number], role: "ceo" | "member"): string | null {
  const split = anchor.target.indexOf(":");
  const type = anchor.target.slice(0, split), id = encodeURIComponent(anchor.target.slice(split + 1));
  const base = role === "ceo" ? "" : "/me";
  if (type === "issue") return `${base}/issues/${id}`;
  if (type === "meeting") return `${base}/meetings/${id}`;
  if (type === "task" && role === "member") return `/me/tasks/${id}`;
  if (type === "mission" && role === "ceo") return `/missions/${id}`;
  return null;
}

const DAY = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric" });
const YEAR_DAY = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric" });
export function shortDate(iso: string, now = new Date()): string {
  const at = new Date(iso);
  return at.getFullYear() === now.getFullYear() ? DAY.format(at) : YEAR_DAY.format(at);
}

/** 浏览器里算原文字节的 sha256（导入接口要核对）。 */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export type ImportFile = components["schemas"]["CreateMemoryImportRequest"]["files"][number];
export async function textFile(path: string, text: string, mtime = new Date()): Promise<ImportFile> {
  return { path, content: text, sha256: await sha256Hex(new TextEncoder().encode(text)), mtime: mtime.toISOString() };
}
/** 上传的文件：zip 按 base64 发（服务端只解记忆相关的），其余按文本。 */
export async function uploadFile(file: File): Promise<ImportFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mtime = new Date(file.lastModified || Date.now()).toISOString();
  if (/\.zip$/i.test(file.name)) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return { path: file.name, content: btoa(binary), sha256: await sha256Hex(bytes), mtime, encoding: "base64" };
  }
  const text = new TextDecoder().decode(bytes);
  return { path: file.name, content: text, sha256: await sha256Hex(new TextEncoder().encode(text)), mtime };
}

/** 确认页：要本人看的两组；其余按组折叠成数字。 */
export const REVIEW_GROUPS = ["conflict", "uncertain"] as const;
export const FOLDED_GROUPS = [
  { id: "import", label: "导入" }, { id: "skipped", label: "未导入" }, { id: "company", label: "公司" }, { id: "project", label: "项目" },
  { id: "duplicate", label: "重复" }, { id: "dropped", label: "不导入" },
] as const;

/**
 * 让 ChatGPT 或 Claude 自己逐条列出记忆的提示词（导入设计 3.1）：界面上唯一允许出现的引导文字，平时折叠，只有一颗「复制提示词」。
 * 字段格式要一字不差，服务端按它拆分（memoryImport.ts）。
 */
export const MEMORY_EXPORT_PROMPT = `请把你存储的关于我的全部记忆，以及你从我们过往对话里了解到的关于我的情况，逐条列出来。

规则：
1. 一行只写一件事。能用我的原话就用原话，尤其是我要求你遵守的规则和偏好。
2. 只写你确实存着、或确实在对话里看到过的内容。不要推测，不要补全，不要编造。拿不准的可以写，但把握标「低」。
3. 不要输出密码、密钥、令牌、证件号、银行卡号；遇到这类内容，整行写成「[已省略：敏感信息]」。
4. 每行固定五个字段，用「 | 」分隔：
   类别 | 内容 | 来源 | 时间 | 把握
   - 类别只能是：规则（我要求你怎么做）、偏好（我的习惯、口味、做事方式）、身份（我是谁、做什么工作）、公司（我所在公司或团队的事实）、项目（只和某个具体项目有关的信息或要求）、其他
   - 内容：属于某个项目的，开头写「[项目名]」
   - 来源只能是：已保存记忆、自定义指令、项目指令、过往对话、不确定
   - 时间：写 YYYY-MM-DD；只知道月份写 YYYY-MM；不知道写「未知」
   - 把握只能是：高、中、低
5. 按类别分组，组内按时间从早到晚。
6. 全部内容放进一个代码块。
7. 代码块后面单独一行写「完整」，或「未完，还有约 N 条」。我回复「继续」时，你从断开处接着写，格式不变。
8. 如果你没有任何关于我的记忆，只输出一行：其他 | 无 | 不确定 | 未知 | 低`;

export const SOURCE_HOME: Partial<Record<ImportSource, string>> = { chatgpt: "https://chatgpt.com/", claude: "https://claude.ai/new" };
