/**
 * 项目转交（新首页设计 16.7）的数据和规矩。B 的 project_transfers 接口、D 的交接检查还没出，网页先照这份形状写：
 * - 转出：选人 →「准备交接」（有在跑的会话先问等做完还是停掉；绑了文件夹的等本机检查，也能不检查直接转）→ 交接说明卡 →「交给 {名字}」→ 等接手，可以撤回。
 * - 接手：等你里一条，点开只读预览（交接说明在最上面），「接手」「不接」。接手以后对话从分隔线「{日期} {原负责人} → {接手人}」开始（默认不带对话记录）。
 * 交接说明只写要哪些钥匙、找谁要，不写值；发出前按常见密钥样式查一遍，命中就挡住（云端会再查一次）。
 */
import type { Project } from "./projects";

export type Person = { personId: string; name: string };
export type TransferStatus = "preparing" | "sent" | "accepted" | "declined" | "withdrawn";

/** 交接说明：几段，每段几行；没内容的段不画。 */
export type HandoverSection = { title: string; lines: string[] };

export type Transfer = {
  id: string;
  projectId: string;
  projectName: string;
  from: Person;
  to: Person;
  status: TransferStatus;
  startedAt: string;
  /** 发出 / 接手 / 不接的时间。 */
  decidedAt: string | null;
  /** 带不带对话记录（默认不带，16.7 用户改的）。 */
  includeHistory: boolean;
  /** 准备交接时本人做的选择：在跑的会话等做完还是停掉；文件夹等本机检查还是不检查直接转。null 是还没问到或用不着问。 */
  running: "wait" | "stop" | null;
  check: "wait" | "skip" | null;
  note: HandoverSection[] | null;
};

/** 交接说明的几段，顺序照 16.7：到哪了、没做完的事、关键决定和原因、怎么跑起来、代码在哪、坑、可以问谁。 */
export const NOTE_TITLES = ["到哪了", "没做完的事", "关键决定和原因", "怎么跑起来", "代码在哪", "坑", "可以问谁"] as const;

/**
 * 网页先拼一份交接说明（管线写的那份到了以后换掉）：从项目里已有的东西拼——本月目标、没做完的会话和事项、文件夹、原负责人。
 * 关键决定、怎么跑起来、坑要读对话和交付物，留给管线写；这里没有就不画那几段。
 */
export function draftNote(project: Project, from: Person): HandoverSection[] {
  const sections: HandoverSection[] = [
    { title: "到哪了", lines: project.current.map((goal) => `${Number(goal.period.slice(5))} 月目标：${goal.name} · ${goal.due} 验收`) },
    { title: "没做完的事", lines: [
      ...project.subSessions.filter((sub) => sub.state !== "done").map((sub) => sub.title),
      ...project.items.filter((item) => item.status !== "done").map((item) => item.title),
    ] },
    { title: "代码在哪", lines: project.folder ? [project.folder] : [] },
    { title: "可以问谁", lines: [from.name] },
  ];
  return sections.filter((section) => section.lines.length);
}

/** 常见密钥样式（16.7 第 4 条）。只认长得像值的，变量名（OPENAI_API_KEY）不算。 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/, /ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /AKIA[0-9A-Z]{16}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /xox[abprs]-[A-Za-z0-9-]{10,}/,
];

/** 交接说明里像密钥的地方：哪一段第几行、命中的那一截（只露前 6 位）。 */
export function secretHits(note: HandoverSection[]): { section: string; line: number; sample: string }[] {
  return note.flatMap((section) => section.lines.flatMap((text, index) => {
    const match = SECRET_PATTERNS.map((pattern) => pattern.exec(text)?.[0]).find(Boolean);
    return match ? [{ section: section.title, line: index + 1, sample: `${match.slice(0, 6)}…` }] : [];
  }));
}

/** 转交在项目行第二行写什么（优先于 16.2 的那几档）：发出了「等 {名字} 接手」，接走了「已交给 {名字}」。 */
export function transferLine(transfer: Pick<Transfer, "status" | "to"> | null): string | null {
  if (transfer?.status === "sent") return `等 ${transfer.to.name} 接手`;
  if (transfer?.status === "accepted") return `已交给 ${transfer.to.name}`;
  return null;
}

/** 对话里换人的分隔线：「11/7 孙铭泽 → 陈晨星」。 */
export const handoverRule = (transfer: Pick<Transfer, "decidedAt" | "from" | "to">) => {
  const at = transfer.decidedAt ? new Date(transfer.decidedAt) : null;
  return `${at ? `${at.getMonth() + 1}/${at.getDate()} ` : ""}${transfer.from.name} → ${transfer.to.name}`;
};
