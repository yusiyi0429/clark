"use client";

/**
 * 在项目里开一个子会话（设计第 68 条，项目行右边的「+」）：页头是项目名，下面空着，底部是首页那个输入框。
 * 说出第一句话就建一个自由子会话（带 free 的专题：没有完成标准、没有验收员），云端登记开工，这台电脑认领后开，页面换到这个子会话。
 * 没建成由输入框自己写「失败」、话留在框里。
 */
import type { Project } from "@/lib/home/projects";
import { InputBar } from "./InputBar";
import { useViewChrome } from "./view";
import h from "@/styles/home.module.css";

export function NewSubView({ project, onCreate }: { project: Pick<Project, "id" | "name">; onCreate: (firstMessage: string) => Promise<void> }) {
  const chrome = useViewChrome();
  const send = async (text: string, files: File[]) => {
    // 第一句话只收文字（交代就是这句话）；附件进了子会话再发。
    if (files.length) throw new Error("只能发文字");
    await onCreate(text.trim());
    return true;
  };
  return (
    <div className={h.homeView} data-testid="new-sub">
      <header className={h.viewHead}>{chrome.lead}<h1 className={h.viewTitle} tabIndex={-1}>{project.name}</h1>{chrome.trail}</header>
      <div className={h.homeScroll} />
      <div className={h.composerDock}>
        <InputBar placeholder="说点什么…" textRequired onSend={send} draftKey={`tianshu-home-draft-v1:new:${project.id}`} />
      </div>
    </div>
  );
}
