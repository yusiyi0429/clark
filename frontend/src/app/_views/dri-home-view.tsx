"use client";

import Link from "next/link";
import { AsyncBoundary } from "@/components/async-boundary";
import { Panel, PanelHead } from "@/components/panel";
import { api } from "@/lib/data/client";
import type { CommitmentScreen, DriHandoff, DriReportedSignal, Person } from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";

/**
 * DRI 侧的入口。**是入口，不是仪表盘** —— 没有统计、没有进度条、没有健康度。
 * 三句话：我的 OM 到哪一步了 / 派给我几件研究 / 我上报的被怎么处置了。
 *
 * 三段各自去问自己的数据，一段慢不拖另外两段。哪一段是空的就照实说空 ——
 * 上线第一天这一页应该基本是空的，那是诚实的空。
 */
export function DriHomeView() {
  const me = useResource<Person>("dri-viewer", () => api.getViewer());
  const commitments = useResource<CommitmentScreen[]>("dri-commitments", () => api.listMyCommitments());
  const handoffs = useResource<DriHandoff[]>("dri-handoffs", () => api.listMyHandoffs());
  const reports = useResource<DriReportedSignal[]>("dri-reports", () => api.listMyReports());

  return (
    <Panel>
      <AsyncBoundary resource={me} skeleton={<div className="h-20" />}>
        {(person) => (
          <PanelHead eyebrow="DRI" title={person.name} />
        )}
      </AsyncBoundary>

      <section className="mt-10 space-y-8">
        <AsyncBoundary resource={commitments} skeleton={<div className="h-16" />}>
          {(data) => {
            if (data.length === 0) {
              return <Line title="本期 OM" body="还没有纲领" href={null} />;
            }
            const total = data.length;
            const pending = data.filter((c) => c.status === "drafted" || c.status === "adjudicated").length;
            const effective = data.filter((c) => c.status === "effective").length;
            let body: string;
            if (effective === total) {
              /**
               * 一个人可能负责两个域，两份承诺的 rounds 可以不同。
               * 不拿第一份的轮次代表所有份 —— 轮次进页面里看。
               */
              body = `已生效`;
            } else if (pending > 0) {
              body = `${total} 份，其中 ${pending} 份等你标注`;
            } else {
              body = `${total} 份，已全部回传`;
            }
            const href = `/dri/commitment/${data[0].periodId}`;
            return <Line title="本期 OM" body={body} href={href} />;
          }}
        </AsyncBoundary>
        <AsyncBoundary resource={handoffs} skeleton={<div className="h-16" />}>
          {(data) => {
            const total = data.length;
            if (total === 0) {
              return <Line title="派给我的研究" body="还没有" href={null} />;
            }
            const pending = data.filter((h) => !h.submitted).length;
            const body = `${total} 件，其中 ${pending} 件还没回传`;
            return (
              <div>
                <div className="meta text-ink-muted">派给我的研究</div>
                <div className="mt-1 text-base text-ink">{body}</div>
                <ul className="mt-2 space-y-1">
                  {data.map((h) => (
                    <li key={h.issueId}>
                      <Link
                        href={`/dri/handoff/${h.issueId}`}
                        className="text-base text-ink underline decoration-hairline underline-offset-2 transition-colors hover:text-ink hover:decoration-ink-faint"
                      >
                        {h.issueId} · {h.title}
                        {h.submitted ? (
                          <span className="meta ml-2 text-ink-muted">已回传</span>
                        ) : null}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          }}
        </AsyncBoundary>
        <AsyncBoundary resource={reports} skeleton={<div className="h-16" />}>
          {(data) => {
            const total = data.length;
            if (total === 0) {
              return <Line title="我上报的信号" body="还没报过" href="/dri/report" />;
            }
            const pending = data.filter((s) => !s.disposedAs).length;
            const body = `报过 ${total} 条，其中 ${pending} 条他还没挑到`;
            return <Line title="我上报的信号" body={body} href="/dri/report" />;
          }}
        </AsyncBoundary>
      </section>
    </Panel>
  );
}

function Line({ title, body, href }: { title: string; body: string; href: string | null }) {
  const inner = (
    <>
      <div className="meta text-ink-muted">{title}</div>
      <div className="mt-1 text-base text-ink">{body}</div>
    </>
  );
  return href ? (
    <Link href={href} className="block rounded-[3px] transition-colors hover:text-ink">
      {inner}
    </Link>
  ) : (
    <div>{inner}</div>
  );
}
