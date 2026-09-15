"use client";

import { useState } from "react";
import { ActionButton } from "@/components/action-button";
import { AsyncBoundary } from "@/components/async-boundary";
import { Panel, PanelHead } from "@/components/panel";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError } from "@/lib/data/client";
import { formatDay } from "@/lib/format";
import type { DriReportedSignal } from "@/lib/data/types";
import { useInvalidate, useResource } from "@/lib/use-resource";

/**
 * 上报信号。一屏一个表单，四个字段。
 *
 * 「动摇哪条判断」**允许留空**，而且默认就是空：要求上报人先答出这个问题等于把
 * 上报门槛提到没人愿意报。那道门槛属于出卡侧（一号位挑的时候要问的），不属于
 * 收件侧。
 *
 * 提交完不跳转 —— 他大概率还有第二条要报。刚提交的那条立刻出现在下面「我报过的」
 * 里，这是他唯一需要的回执（这一版没有通知，spec §9）。
 */
export function DriReportView() {
  const judgments = useResource("dri-judgments", () => api.listMyDomainJudgments());
  const mine = useResource<DriReportedSignal[]>("dri-reports", () => api.listMyReports());
  const invalidate = useInvalidate();

  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [text, setText] = useState("");
  const [why, setWhy] = useState("");
  const [shakes, setShakes] = useState("");
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const submit = async () => {
    setPending(true);
    setFailure(null);
    try {
      await api.submitDriSignal({ title, source, text, why, url, shakes });
      setTitle("");
      setSource("");
      setText("");
      setWhy("");
      setShakes("");
      setUrl("");
      /**
       * 这里用 `invalidate` 而不是 H2 约束的 `mutate(..., { revalidate: false })`。
       *
       * 理由一：类型不匹配。`submitDriSignal` 返回 `InboxSignal`（完整的收件对象），
       * 而 `listMyReports` 返回 `DriReportedSignal[]`（只有该给 DRI 看的四样：标题、
       * 日期、处置状态、议题 id）。要走 `mutate` 就得在客户端再实现一遍这层映射。
       *
       * 理由二：幂等键机制。`submitDriSignal` 按 `dedupeKey` 幂等——同一条报第二次
       * 不会新增一行，而是返回已存在的那条。但客户端拿返回值 prepend 进列表，会在
       * 屏幕上凭空多出一条服务端并不存在的记录。那正是 H2 要防的事：乐观更新造成
       * 客户端与服务端状态分叉。
       *
       * 所以这个调用点重新拉一次列表。代价是一次多余的往返，换来的是屏幕上那一栏
       * 永远是服务端说的。这两个 key 都挂在这一屏上，所以都要列进去 —— 没列进去的
       * 会被清空，而清空会让下拉掉回骨架。
       */
      invalidate("dri-reports", "dri-judgments");
    } catch (err) {
      /*
       * `api.` 那一层的失败全带着一句中文（client.ts 翻译过），原文照显。
       * else 只剩这个 catch 块后面那几行自己崩了 —— 那时候请求**已经发出去而且成了**，
       * 所以这句话不许说「没送出去」，也不许叫他再点一次（会重复提交一遍）。
       */
      setFailure(
        err instanceof ApiError
          ? err.message
          : "这一下没有走完。"
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Panel>
      <PanelHead
        eyebrow="上报信号"
        title="你看到了什么"
      />

      <div className="mt-8 space-y-6">
        <Field label="一句话" hint="必填">
          <Textarea value={title} onChange={(e) => setTitle(e.target.value)} rows={2} />
        </Field>
        <Field label="出处">
          <Textarea value={source} onChange={(e) => setSource(e.target.value)} rows={1} />
        </Field>
        <Field label="链接" hint="可空">
          <Textarea value={url} onChange={(e) => setUrl(e.target.value)} rows={1} />
        </Field>
        <Field label="为什么是现在">
          <Textarea value={why} onChange={(e) => setWhy(e.target.value)} rows={2} />
        </Field>
        <Field label="原文或细节" hint="可空">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} />
        </Field>
        <Field label="你觉得它动摇哪条判断" hint="可空">
          {/* 这一栏允许留空是产品判断，但「我的域没有判断」和「这一栏取不到」是两件事，长得一样就是在骗人。 */}
          <AsyncBoundary resource={judgments} skeleton={<div className="h-8" />}>
            {(list) => (
              <NativeSelect value={shakes} onChange={(e) => setShakes(e.target.value)}>
                <option value="">（不填）</option>
                {list.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.id} · {j.statement}
                  </option>
                ))}
              </NativeSelect>
            )}
          </AsyncBoundary>
        </Field>

        {failure ? <p className="text-sm text-counter">{failure}</p> : null}

        <ActionButton
          pending={pending}
          pendingLabel="正在上报…"
          onAction={submit}
          disabled={!title.trim()}
        >
          上报
        </ActionButton>
      </div>

      <section className="mt-14 border-t border-hairline pt-8">
        <h2 className="meta text-ink-muted">我报过的</h2>
        <AsyncBoundary resource={mine} skeleton={<div className="mt-3 h-6" />}>
          {(list) =>
            list.length ? (
              <ul className="mt-4 space-y-3">
                {list.map((s) => (
                  <li key={s.dedupeKey} className="text-base text-ink">
                    {s.title}
                    <span className="meta ml-2 text-ink-muted">
                      {formatDay(s.receivedAt)} · {disposalWord(s)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              /* 空就说空。这一侧上线第一天本来就是空的。 */
              <p className="mt-3 text-base text-ink-muted">还没有。</p>
            )
          }
        </AsyncBoundary>
      </section>
    </Panel>
  );
}

/** 处置成什么了。**没被挑过就说没被挑过**，不写「处理中」——那会像在等一个进度。 */
function disposalWord(s: DriReportedSignal): string {
  if (!s.disposedAs) return "他还没挑到";
  if (s.disposedAs === "issue") return "已开成议题";
  if (s.disposedAs === "watch") return "他先放进待定";
  return "他看过，没往下走";
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-base text-ink">{label}</span>
      {hint ? <span className="meta mt-0.5 block text-ink-muted">{hint}</span> : null}
      <div className="mt-2">{children}</div>
    </label>
  );
}
