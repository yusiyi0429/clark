"use client";

/**
 * 请求列表（参照 Linear Inbox）：收到的 / 发出的两段；一行一件事，未读一个点、标题、谁和什么时候，右边是状态或进度。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { TRequestBox, TRequestListItem } from "@warmap/contracts";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { SegmentedSwitch } from "@/components/SegmentedSwitch";
import { browserApi, type Card } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import { REQUESTS_CHANGED } from "./requestApi";
import { statusTone } from "./RequestScreen";
import s from "./requests.module.css";

const NO_CARDS: Card[] = [];

/** initialBox：先打开哪一段（成员首页「等回复」带 ?box=sent 进来）；不给时是「收到的」。 */
export function RequestListScreen({ base, initialBox = "inbox" }: { base: string; initialBox?: TRequestBox }) {
  const workspace = useWorkspace();
  const [box, setBox] = useState<TRequestBox>(initialBox);
  const [items, setItems] = useState<TRequestListItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  useRegisterDetail(useMemo(() => ({ scope: "global", label: "请求", mark: null, cards: NO_CARDS }), []));

  const load = useCallback(async (which: TRequestBox) => {
    try {
      const { data, response } = await browserApi.GET("/api/me/requests", { params: { query: { box: which } } });
      if (response.status === 401) { window.location.assign("/access"); return; }
      setFailed(!data);
      if (data) setItems(data.items);
    } catch { setFailed(true); }
  }, []);
  useEffect(() => {
    setItems(null);
    void load(box);
    const reload = () => void load(box);
    window.addEventListener(REQUESTS_CHANGED, reload);
    window.addEventListener("focus", reload);
    return () => { window.removeEventListener(REQUESTS_CHANGED, reload); window.removeEventListener("focus", reload); };
  }, [box, load]);

  return (
    <div className={s.screen}>
      <DetailFrame title="请求" subtitle="传话" onBack={() => workspace.close()}>
        <div className={s.content}>
          <div className={s.stack}>
            <div className={s.listBar}>
              <SegmentedSwitch label="请求" selected={box} onSelect={setBox} segments={[{ id: "inbox", label: "收到的" }, { id: "sent", label: "发出的" }]} />
              <Button variant="ghost" className={s.ghost} onPress={() => workspace.navigate(`${base}/new`)}><Plus size={16} aria-hidden="true" />新请求</Button>
            </div>
            {failed ? <p className={s.error} role="alert">没有读到请求</p> : null}
            {items && !items.length ? <p className={s.empty}>没有{box === "inbox" ? "收到的" : "发出的"}请求</p> : null}
            {items?.length ? (
              <ul className={s.list}>
                {items.map((item) => <RequestRow key={item.id} item={item} box={box} onOpen={(from) => workspace.navigate(`${base}/${encodeURIComponent(item.id)}`, from)} />)}
              </ul>
            ) : null}
          </div>
        </div>
      </DetailFrame>
    </div>
  );
}

function RequestRow({ item, box, onOpen }: { item: TRequestListItem; box: TRequestBox; onOpen: (from: Element | null) => void }) {
  const status = statusTone(item, item.myStatus);
  const meta = [box === "inbox" ? item.initiatorName : item.recipientNames.join("、"), monthDayTime(item.sentAt ?? item.createdAt)].filter(Boolean).join(" · ");
  return (
    <li>
      <button type="button" className={s.row} data-unread={item.unread ? "" : undefined} onClick={(event) => onOpen(event.currentTarget)}>
        <span className={s.dot} aria-label={item.unread ? "未读" : undefined} />
        <span className={s.rowText}>
          <span>{item.title}</span>
          <small>{meta}</small>
        </span>
        <span className={s.rowMeta}>
          {item.openQuestions ? <span className={s.tag} data-tone="wait">{item.openQuestions} 问</span> : null}
          {box === "sent" && item.status !== "draft" ? <span className={s.ratio} data-done={item.recipientsDone === item.recipientNames.length ? "" : undefined}>{item.recipientsDone}/{item.recipientNames.length}</span> : null}
          <span className={s.chip} data-tone={status.tone}>{status.label}</span>
        </span>
      </button>
    </li>
  );
}
