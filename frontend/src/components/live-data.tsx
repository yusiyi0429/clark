"use client";

import { useEffect } from "react";

import { noteRevision } from "@/lib/live-data";

/**
 * 这一页上唯一的那条「库改过了」的连接。挂在外壳里，不画任何东西。
 *
 * 服务端一改就推一个号过来（`/api/data/changes`），号变大之后屏幕上挂着的那几份数据
 * 自己重问一遍（`lib/use-resource.ts` 里挂的钩子）。没有它，服务端自己做完的那些事
 * ——深研跑完、报告读成判断、一条信号被开成议题——在屏幕上永远不出现，他得按 F5。
 *
 * ## 为什么是一条，而且在外壳里
 *
 * HTTP/1.1 之下每个域名只有六条并发连接，一条挂着不放的 SSE 就长期占掉一条（`/api/stage`
 * 已经占了一条，但那是投影屏那一台机器，不和这里同时开）。所以按页开、按组件开都不行,
 * 只能整个外壳一条 —— 这也正好是「换页不断线」想要的：`layout` 在路由之间不重挂。
 *
 * ## 断线怎么办
 *
 * `EventSource` 自己重连（笔记本合盖、网切了），不用在这里写重试。断着的那几分钟里
 * 的改动没有补发，靠的是重连后服务端先报一次眼下这个号：号比见过的大，屏幕就补问
 * 一轮（那条路由里讲了这一帧存在的理由）。
 *
 * 身份不对（401）的时候浏览器**不会**重连 —— 按规范非 200 就是彻底失败。这是对的：
 * 没登录的人不该有一条每三秒重试一次的连接。他登录之后这一页会重新加载，连接跟着
 * 重新开。
 */
export function LiveData() {
  useEffect(() => {
    const source = new EventSource("/api/data/changes");

    const read = (e: MessageEvent<string>) => {
      try {
        const { rev } = JSON.parse(e.data) as { rev?: unknown };
        if (typeof rev === "number") noteRevision(rev);
      } catch {
        /* 帧读不懂就丢掉。这条线只运一个数字，丢一帧下一帧会补上。 */
      }
    };

    // 刚连上报眼下这个号；之后每改一次报一次。两种帧同一个处理 —— 都只是「号是多少」。
    source.addEventListener("ready", read);
    source.addEventListener("rev", read);

    return () => source.close();
  }, []);

  return null;
}
