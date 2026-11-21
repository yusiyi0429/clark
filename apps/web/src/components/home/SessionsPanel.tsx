"use client";

/**
 * 右边「会话」面板（设计 4.3，取代原来的「后台任务」），从上到下：
 * 1. 会话：项目页（含这个项目的卡、专题页）只列这个项目的子会话（派活单的先后）；其余页面按项目分组（组名淡色，没有子会话的项目不列），
 *    最后「其他」放不挂项目的和「随手」项目的（本人 11/19 收到幕后，不写「随手」）。一行就是左栏原来那一行（SubRow，「…」菜单照旧），名字后面一个淡色短状态（subStatus）。
 * 2. 「新会话」：规矩同原来项目行上的「+」。项目页直接去这个项目的新建页；其余页面先弹一列能加的项目，选了再去；一个能加的都没有不出。
 * 3. 「已归档 N」：点开就地列出这个范围里归档了的子会话，「…」里能恢复；没有不出。
 * 4. 发丝线 → 这台电脑（资源块）→ 后台任务。手机的底部抽屉：会话那几样，下面接原来的 BackgroundPanel。
 */
import { useContext, useState } from "react";
import { Dropdown } from "@heroui/react";
import { LaptopMinimal, Plus } from "lucide-react";
import type { TArchivedSubSession } from "@warmap/contracts";
import { newSubHref, type Project } from "@/lib/home/projects";
import type { BackgroundItem, SubSession } from "@/lib/home/types";
import { LocalContext } from "@/lib/local/LocalRunnerProvider";
import type { Resources } from "@/lib/work/useWork";
import { BackgroundPanel, BackgroundTasks, MachineBlock } from "./BackgroundPanel";
import { ICON, type IconState } from "./StateIcon";
import { ActionsContext, ArchivedSubRow, SubRow, planOrder, subHref, subIcon, subKey, type RowActions } from "./SubRows";
import type { View } from "./view";
import h from "@/styles/home.module.css";

/** 面板只看一个项目的时候：项目对话、项目详情、新子会话页、挂在项目上的 Task，和这个项目的卡、专题；其余页面为 null（列全部）。 */
export function panelProject(view: View, projects: readonly Project[]): Project | null {
  switch (view.kind) {
    case "project": case "projectInfo": return projects.find((project) => project.id === view.id) ?? null;
    case "newSub": return projects.find((project) => project.id === view.projectId) ?? null;
    case "task": case "info": return projects.find((project) => project.goals.some((goal) => goal.taskId === view.taskId)) ?? null;
    case "card": case "topic": return projects.find((project) => project.subSessions.some((sub) => sub.id === view.id)) ?? null;
    default: return null;
  }
}

/**
 * 会话行的短状态（设计 4.3），跟着行上的图标走（subIcon，同左栏和页头细环的认法）：在跑（含第一次验收没过、还在改的，5.4.2）、
 * 等你（在等本人批准、回答、拿主意、补、合回）、已交回（做完了）、失败（出错停下）；别的（排队、做完一轮、本人停的）不写。
 * 在跑不写几分钟：首页数据里子会话没有这一轮的开始时间。
 */
const STATUS: Partial<Record<IconState, string>> = { running: "在跑", waiting: "等你", done: "已交回" };
export function subStatus(sub: Pick<SubSession, "state" | "waiting" | "stopWhy">): string | null {
  const icon = subIcon(sub).state;
  if (icon === "stopped") return sub.stopWhy === "error" ? "失败" : null;
  return STATUS[icon] ?? null;
}

export function SessionsPanel({ view, projects, other, archivedSubs, actions, go, items, onStop, resources, handheld = false, onOpenSub, cardAt }: {
  view: View;
  projects: Project[];
  other: SubSession[];
  archivedSubs: TArchivedSubSession[];
  actions: RowActions | null;
  go: (href: string) => void;
  items: BackgroundItem[];
  onStop: (item: BackgroundItem) => Promise<void>;
  resources: Resources;
  handheld?: boolean;
  /** 点一行；不给就去那个子会话。 */
  onOpenSub?: (sub: SubSession) => void;
  /** 卡的建出时间（派活先后，planOrder）：会话跑起来行不挪。 */
  cardAt?: ReadonlyMap<string, string>;
}) {
  const [archivedOpen, setArchivedOpen] = useState(false);
  const local = useContext(LocalContext);
  const scoped = panelProject(view, projects);
  const open = onOpenSub ?? ((sub: SubSession) => go(subHref(sub)));
  const rows = (subs: SubSession[]) => (
    <ul className={h.subs}>{planOrder(subs, cardAt).map((sub) => <SubRow key={subKey(sub)} sub={sub} view={view} go={() => open(sub)} status={subStatus(sub)} />)}</ul>
  );
  // 同原来项目行上的「+」：有菜单动作、项目没归档；这台电脑的本机程序连着却开不了自由子会话（protocol < 4）时不出，手机、没连上照出。
  const canAddTo = (project: Project) => !!actions && !project.archived && !(local?.phase === "ready" && !local.runner.freeSessions);
  const scratch = projects.find((project) => project.scratch);
  const addable = scoped ? (canAddTo(scoped) ? [scoped] : []) : projects.filter((project) => !project.scratch && canAddTo(project));
  const canAdd = addable.length > 0;
  const archived = scoped ? archivedSubs.filter((sub) => sub.projectId === scoped.id) : archivedSubs;
  const groups = scoped ? [] : projects.filter((project) => !project.scratch && project.subSessions.length);
  const loose = scratch ? [...other, ...scratch.subSessions] : other;
  const listed = scoped ? scoped.subSessions.length > 0 : groups.length > 0 || loose.length > 0;
  return (
    <ActionsContext.Provider value={actions}>
      <div className={h.sessions} data-testid="sessions-panel">
        {listed || canAdd || archived.length ? (
          <div className={h.sessionsList}>
            {scoped ? rows(scoped.subSessions) : <>
              {groups.map((project) => (
                <section key={project.id} aria-label={project.name}><p className={h.sessionsGroup}>{project.name}</p>{rows(project.subSessions)}</section>
              ))}
              {loose.length ? <section aria-label="其他"><p className={h.sessionsGroup}>其他</p>{rows(loose)}</section> : null}
            </>}
            {canAdd && scoped ? (
              <button type="button" className={h.sessionsRow} onClick={() => go(newSubHref(scoped.id))} data-testid="panel-new-sub"><Plus {...ICON} />新会话</button>
            ) : canAdd ? (
              <Dropdown>
                <Dropdown.Trigger className={h.sessionsRow} data-testid="panel-new-sub"><Plus {...ICON} />新会话</Dropdown.Trigger>
                <Dropdown.Popover placement="bottom start" offset={4} className={h.pop}>
                  <Dropdown.Menu aria-label="新会话" className={h.menuList} onAction={(key) => go(newSubHref(String(key)))}>
                    {addable.map((project) => <Dropdown.Item key={project.id} id={project.id} textValue={project.name} className={h.menuItem}>{project.name}</Dropdown.Item>)}
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown>
            ) : null}
            {archived.length ? (
              <button type="button" className={h.sessionsRow} data-faint="" aria-expanded={archivedOpen} onClick={() => setArchivedOpen(!archivedOpen)} data-testid="panel-archived">
                {`已归档 ${archived.length}`}
              </button>
            ) : null}
            {archivedOpen && archived.length ? <ul className={h.subs}>{archived.map((sub) => <ArchivedSubRow key={subKey(sub)} sub={sub.projectId && sub.projectId === scratch?.id ? { ...sub, projectName: null } : sub} go={go} />)}</ul> : null}
          </div>
        ) : null}
        {handheld ? <BackgroundPanel items={items} resources={resources} onStop={onStop} handheld /> : <>
          {listed || canAdd || archived.length ? <hr className={h.sessionsRule} /> : null}
          <MachineBlock resources={resources} />
          <div className={h.bgBody}><BackgroundTasks items={items} onStop={onStop} /></div>
        </>}
      </div>
    </ActionsContext.Provider>
  );
}

/** 页头的「会话」按钮（设计 4.2，取代后台任务按钮）：有在跑的时候图标外一圈慢转的细环；手机上额度快用完时右上角一颗点（同原来）。 */
export function SessionsButton({ running, open, handheld = false, alert, onPress }: {
  running: boolean; open: boolean; handheld?: boolean; alert: "warning" | "danger" | null; onPress: () => void;
}) {
  return (
    <button type="button" className={h.icon} aria-label="会话" title="会话" aria-pressed={handheld ? undefined : open} onClick={onPress}
      data-running={running ? "" : undefined} data-testid={handheld ? "phone-sessions" : "sessions-button"}>
      <LaptopMinimal {...ICON} />
      {handheld && alert ? <i className={h.cornerDot} data-tone={alert === "danger" ? "danger" : undefined} aria-hidden /> : null}
    </button>
  );
}
