"use client";

import { useMemo, useState } from "react";
import { browserApi, type Card } from "@/lib/api/client";
import { DetailHeader } from "@/components/shell/DetailHeader";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { SignalArticle, type SignalReading, type SignalState } from "@/cards/SignalArticle";
import { SignalStoryView } from "@/cards/SignalStory";
import { upNextSignals } from "@/cards/SignalCard";
import { PERSONAL_ORDER, goToAccess, listingDateText, personalStory, type PersonalSignal, type PersonalSignalBrief } from "./personalRadar";

const EMPTY_CARDS: Card[] = [];

/** 个人信号映射到共用的阅读正文：关系写「和你的方向」，正文用命中理由；没有「尚未确定」，也没有配图。 */
export function personalReading(signal: PersonalSignal): SignalReading {
  return {
    title: signal.source.title,
    sourceLabel: signal.source.label,
    publishedAt: signal.source.publishedAt ?? signal.source.listedOn,
    // 榜单条目（02b）：写上榜日、语言与时段 star，不写「发布于」；原文是榜单上那一行，如实说明没读仓库内容
    ...(signal.source.listedOn
      ? { dateText: listingDateText(signal), excerptNote: `${signal.source.label} 的榜单条目，未读取仓库内容` }
      : {}),
    summary: signal.summary,
    unknowns: [],
    relation: { heading: "和你的方向", text: signal.reason, tag: { label: `你的方向 · ${signal.direction.text}` } },
    excerpt: signal.excerpt,
    images: [],
    evidenceQuote: signal.evidenceQuote,
    fullText: signal.fullText,
    collectedAt: signal.collectedAt,
    url: signal.source.url,
  };
}

/**
 * 个人信号阅读：与公司信号同一份正文排版；收藏、隐藏（隐藏后留在原地，可以当场恢复）、已读都只记在本人名下。
 * 不挂对话（成员只有全局对话），也不能发给别人或变成执行事项。list 是本人列表里的信号：含当前这条时，「继续浏览」从它往后排。
 */
export function MemberSignalScreen({ signal, list }: { signal: PersonalSignal; list: PersonalSignalBrief[] }) {
  const { navigate, close } = useWorkspace();
  const [state, setState] = useState(signal.state);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<SignalState | null>(null);
  const upNext = useMemo(() => upNextSignals<PersonalSignalBrief>(signal, list, PERSONAL_ORDER), [signal, list]);
  useRegisterDetail({ scope: "global", label: signal.source.title, mark: null, cards: EMPTY_CARDS });

  async function update(next: SignalState): Promise<boolean> {
    setLast(next);
    setPending(true);
    setError(null);
    try {
      const { data, error: failure, response } = await browserApi.PATCH("/api/me/radar/signals/{id}/state", { params: { path: { id: signal.id } }, body: next });
      if (response.status === 401) {
        goToAccess();
        return false;
      }
      if (response.ok && data) {
        setState(data.state);
        return true;
      }
      setError(response.status === 404 ? "这条信号已经不在了。" : ((failure as { message?: string } | undefined)?.message ?? "状态更新失败，请重试。"));
      return false;
    } catch {
      setError("网络连接失败，请再试一次。");
      return false;
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <DetailHeader
        mark="signal"
        eyebrow="信号详情 · 我的雷达"
        back={{ label: "返回我的雷达", onPress: () => navigate("/me/radar") }}
        closeLabel="关闭我的雷达"
        onClose={close}
      />
      <SignalArticle
        reading={personalReading(signal)}
        state={state}
        pending={pending}
        error={error}
        onUpdate={update}
        onRetry={() => {
          if (last) void update(last);
        }}
        upNext={upNext.map((item) => (
          <SignalStoryView key={item.id} {...personalStory(item)} onOpen={navigate} />
        ))}
      />
    </>
  );
}
