import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TBattlefieldProgressGroup } from "@warmap/contracts";
import { GroupView } from "./BattlefieldProgressScreen";

const me = { personId: "sun", name: "孙铭泽" }, renhao = { personId: "renhao", name: "刘人豪" }, siyi = { personId: "siyi", name: "于斯一" };
const help = (extra: Partial<TBattlefieldProgressGroup["help"][number]>): TBattlefieldProgressGroup["help"][number] => ({
  kind: "blocked", person: renhao, mission: { missionId: "m-r", title: "Chat 回答质量" }, task: { taskId: "t1", title: "新 Chat 题库打分" },
  reason: null, waitingOn: null, waitingOnMe: false, days: null, dueDate: null, neededDays: null, leftDays: null, canOpen: false, ...extra,
});
const group: TBattlefieldProgressGroup = {
  id: "agents", name: "Agents", kind: "capability", goal: null,
  counts: { missions: 4, onTrack: 1, slow: 2, blocked: 1 },
  help: [
    help({ reason: "等预发 Chat 服务上线才能打分", waitingOn: me, waitingOnMe: true, days: 2 }),
    help({ kind: "deadline", person: siyi, mission: { missionId: "m-s", title: "本体首验" }, task: null, neededDays: 4, leftDays: 3 }),
    help({ kind: "overdue", person: me, mission: { missionId: "m-me", title: "CEO / DRI Agent 从能用到在用" }, task: { taskId: "t2", title: "按真实会态控制回流" }, dueDate: "2026-10-16", days: 4, canOpen: true }),
  ],
  people: [
    { person: me, me: true, movedThisWeek: 6, latest: null, missions: [{ missionId: "m-me", title: "CEO / DRI Agent 从能用到在用", done: 3, total: 7, flag: "slow" }] },
    { person: renhao, me: false, movedThisWeek: 3, latest: { text: "题库补到 14 题", at: "2026-10-23T03:00:00.000Z" }, missions: [{ missionId: "m-r", title: "Chat 回答质量", done: 1, total: 5, flag: "blocked" }] },
  ],
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const card = (html: string, attr: string) => html.match(new RegExp(`<li[^>]*${attr}[^>]*>.*?</li>(?=<li|</ul>)`, "s"))?.[0] ?? "";

describe("战场进展（成员）", () => {
  it("业务域组：没有目标就不写，盘点一行；需要搭把手按服务端顺序，每张写清卡在哪 / 慢在哪，在等我时写「等你」", () => {
    const html = renderToStaticMarkup(<GroupView group={group} onNavigate={vi.fn()} onBook={vi.fn()} />);
    expect(text(html)).toContain("4 个 Mission 1 在轨道上 2 慢了 1 卡住");
    expect([...html.matchAll(/data-help="([a-z_]+)"/g)].map((match) => match[1])).toEqual(["blocked", "deadline", "overdue"]);
    expect(text(card(html, 'data-help="blocked"'))).toBe("刘 刘人豪 · Chat 回答质量 新 Chat 题库打分 等预发 Chat 服务上线才能打分 卡住 2 天 · 等你 约会议 发请求");
    expect(text(card(html, 'data-help="deadline"'))).toBe("于 于斯一 · 本体首验 本体首验 还需 4 个工作日，剩 3 个 按截止做不完 约会议 发请求");
    // 我自己的事：只有「看看」。
    expect(text(card(html, 'data-help="overdue"'))).toBe("孙 我 · CEO / DRI Agent 从能用到在用 按真实会态控制回流 截止 10/16，已过 4 个工作日 慢了 看看");
  });

  it("每人一张卡：我排第一写「我」；Mission 一行写已完成 a/b 或状态；最近一条进展", () => {
    const html = renderToStaticMarkup(<GroupView group={group} onNavigate={vi.fn()} onBook={vi.fn()} />);
    expect([...html.matchAll(/data-person="([a-z]+)"/g)].map((match) => match[1])).toEqual(["sun", "renhao"]);
    expect(text(card(html, 'data-person="sun"'))).toBe("孙 我 本周动了 6 件 CEO / DRI Agent 从能用到在用 慢了");
    expect(text(html.slice(html.indexOf('data-person="renhao"')))).toMatch(/^data-person="renhao"> 刘 刘人豪 本周动了 3 件 Chat 回答质量 卡住 最近：题库补到 14 题 · /);
  });

  it("约会议先填好这个人，发请求进新请求并写好找谁、关于哪件事，看看进详情", () => {
    const onNavigate = vi.fn(), onBook = vi.fn();
    const element = GroupView({ group, onNavigate, onBook });
    const buttons: { props: { children?: unknown; onClick?: (event: unknown) => void } }[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      const el = node as { type?: unknown; props?: { children?: unknown } };
      if (el.type === "button") buttons.push(el as never);
      if (typeof el.type === "function") walk((el.type as (props: unknown) => unknown)(el.props));
      else walk(el.props?.children);
    };
    walk(element);
    const press = (label: string, index = 0) => buttons.filter((button) => button.props.children === label)[index].props.onClick!({ currentTarget: null });
    press("约会议");
    expect(onBook).toHaveBeenCalledWith(["renhao"]);
    press("发请求");
    expect(onNavigate).toHaveBeenCalledWith(`/me/requests/new?prompt=${encodeURIComponent("关于「新 Chat 题库打分」，找刘人豪：")}`, null);
    press("看看");
    expect(onNavigate).toHaveBeenLastCalledWith("/me/tasks/t2", null);
  });
});
