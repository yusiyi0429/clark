"use client";

/**
 * 连接和技能（设计 §17.2 第 22 条，照 Claude 设置的 Customize）：「我」菜单里一项，打开这一页。
 * 顶部左边两个标签「连接」「技能」，右边切换「我的 / 可添加」；内容是两列卡片网格（959 及以下一列）。
 * 老的两个页键都打开这一页：connections 落在「连接」，roles 落在「技能」。点技能卡进详情时只画详情（详情里有「全部技能」回来）。
 */
import { useState } from "react";
import { SegmentedSwitch } from "@/components/SegmentedSwitch";
import type { SecondaryPageProps } from "./index";
import { ConnectionsPage } from "./ConnectionsPage";
import { RolesPage, type SkillsView } from "./RolesPage";
import p from "@/styles/home-pages.module.css";

export type CustomizeTab = "connections" | "skills";
const TABS: { id: CustomizeTab; label: string }[] = [{ id: "connections", label: "连接" }, { id: "skills", label: "技能" }];
const VIEWS: { id: SkillsView; label: string }[] = [{ id: "mine", label: "我的" }, { id: "add", label: "可添加" }];

export function CustomizePage({ go, initial }: SecondaryPageProps & { initial: CustomizeTab }) {
  const [tab, setTab] = useState<CustomizeTab>(initial);
  const [view, setView] = useState<SkillsView>("mine");
  const [skill, setSkill] = useState<string | null>(null);
  if (tab === "skills" && skill) return <RolesPage go={go} selected={skill} onSelect={setSkill} />;
  return (
    <>
      <div className={p.customizeBar} data-testid="customize-bar">
        <SegmentedSwitch label="连接和技能" segments={TABS} selected={tab} onSelect={setTab} />
        <SegmentedSwitch label="我的或可添加" segments={VIEWS} selected={view} onSelect={setView} />
      </div>
      {tab === "connections" ? <ConnectionsPage go={go} view={view} /> : <RolesPage go={go} view={view} onSelect={setSkill} />}
    </>
  );
}

export const ConnectionsTabPage = (props: SecondaryPageProps) => <CustomizePage {...props} initial="connections" />;
export const SkillsTabPage = (props: SecondaryPageProps) => <CustomizePage {...props} initial="skills" />;
