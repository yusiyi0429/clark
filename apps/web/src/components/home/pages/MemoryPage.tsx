"use client";

/**
 * 我的记忆（个人菜单「我的记忆」，7a-2；新首页二级页，文档类版式 5.4.7）。老页面能做的这里都能做：
 * - 伙伴记住的（独立 Chat）：只读，没接、读不到、还没有时整块不出现。
 * - 搜索（停手 250ms 后搜，Esc 清空，命中的字高亮）、状态三段：现行 / 已被替代 / 已忘掉（后两个有才出现，带数字）。
 * - 四组列出；一条是标题、正文，下面一行时间、关于什么（能点的跳过去）、原话出处、「已被替代」。
 * - 点正文或「修改」就地改（⌘↵ 存、Esc 取消）；「⋯」里忘掉（提示条里能撤销）、彻底删除（原处再确认一次）；已忘掉的给「恢复」。
 * - 「导入」在原处展开：有没确认完的先看它们，「新导入」随时切过去（MemoryImportPanel / MemoryImportReview）。
 * 不写说明句；读不到在原处写「失败 · 重试」。
 * 老地址 /me/memory 和 CEO 的 /memory 也用这一个（MemoryScreen 只是套了老外壳）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dropdown } from "@heroui/react";
import { ArchiveRestore, Ellipsis, Pencil, Plus, Search, X } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { SegmentedSwitch } from "@/components/SegmentedSwitch";
import { FailedLine } from "@/components/work/DecisionBox";
import { MemoryImportPanel } from "@/components/memory/MemoryImportPanel";
import { MemoryImportReview } from "@/components/memory/MemoryImportReview";
import { PartnerMemories } from "@/components/memory/PartnerMemories";
import { anchorHref, anchorLabel, groupMemories, referenceSource, shortDate, SOURCE_LABEL, type MemoryImport, type MemoryItem, type PartnerMemoryList } from "@/components/memory/memoryModel";
import { browserApi } from "@/lib/api/client";
import { showWorkspaceToast } from "@/lib/toast";
import type { SecondaryPageProps } from "./index";
import { ICON, Loading, Section, useMe } from "./parts";
import h from "@/styles/home.module.css";
import p from "@/styles/home-pages.module.css";
import m from "@/components/memory/memory.module.css";

type Status = MemoryItem["status"];
const STATUS: { id: Status; label: string }[] = [{ id: "active", label: "现行" }, { id: "superseded", label: "已被替代" }, { id: "forgotten", label: "已忘掉" }];
const PENDING: MemoryImport["status"][] = ["processing", "awaiting_review", "failed"];

export function MemoryPage({ go, role }: SecondaryPageProps & { role?: "ceo" | "member" }) {
  const me = useMe();
  const viewer = role ?? me?.role ?? "member";
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("active");
  const [importing, setImporting] = useState(false);
  const [imports, setImports] = useState<MemoryImport[]>([]);
  const [partner, setPartner] = useState<PartnerMemoryList | null>(null);

  const load = useCallback(async (q: string) => {
    try {
      const { data, response } = await browserApi.GET("/api/me/memory/personal", { params: { query: { status: "all", ...(q.trim() ? { q: q.trim() } : {}) } } });
      if (response.status === 401) { window.location.assign("/access"); return; }
      setFailed(!data);
      if (data) setItems(data.items);
    } catch { setFailed(true); }
  }, []);
  const loadImports = useCallback(async () => {
    const { data } = await browserApi.GET("/api/me/memory/imports").catch(() => ({ data: undefined }));
    if (data) setImports(data.items);
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => void load(query), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);
  useEffect(() => { void loadImports(); }, [loadImports]);
  // 伙伴记住的：读不到（Chat 连不上、没接）就不显示那一块，不报错。
  useEffect(() => { void browserApi.GET("/api/me/memory/partner").then(({ data }) => setPartner(data ?? null), () => undefined); }, []);

  const counts = useMemo(() => Object.fromEntries(STATUS.map((tab) => [tab.id, items?.filter((item) => item.status === tab.id).length ?? 0])) as Record<Status, number>, [items]);
  // 当前状态没有条目了（比如最后一条恢复了），回到现行。
  useEffect(() => { if (items && status !== "active" && !counts[status]) setStatus("active"); }, [items, counts, status]);
  const shown = useMemo(() => groupMemories((items ?? []).filter((item) => item.status === status)), [items, status]);
  const replace = (next: MemoryItem) => setItems((current) => current?.map((item) => (item.id === next.id ? next : item)) ?? current);
  const pending = imports.filter((item) => PENDING.includes(item.status));

  const restore = async (item: MemoryItem) => {
    const { data } = await browserApi.POST("/api/me/memory/personal/items/{id}/restore", { params: { path: { id: item.id } } }).catch(() => ({ data: undefined }));
    if (!data) { showWorkspaceToast({ text: "没恢复，请重试" }); return; }
    replace(data);
  };
  const forget = async (item: MemoryItem) => {
    const { data } = await browserApi.DELETE("/api/me/memory/personal/items/{id}", { params: { path: { id: item.id } } }).catch(() => ({ data: undefined }));
    if (!data) { showWorkspaceToast({ text: "没忘掉，请重试" }); return; }
    replace(data);
    showWorkspaceToast({ text: "已忘掉", action: { label: "撤销", run: () => void restore(data) } });
  };
  /** 彻底删除：成了整份重读（被它替代的旧条目变成了已忘掉）；没成抛错，由那一行写「失败 · 重试」。 */
  const purge = async (item: MemoryItem) => {
    const { response } = await browserApi.DELETE("/api/me/memory/personal/items/{id}", { params: { path: { id: item.id }, query: { purge: "1" } } }).catch(() => ({ response: undefined }));
    if (!response?.ok) throw new Error("没删掉");
    void load(query);
  };
  const toggleImport = () => { if (importing) { void load(query); void loadImports(); } setImporting(!importing); };
  const empty = items !== null && !shown.length;

  return (
    <>
      <div className={m.toolbar}>
        <label className={m.search}>
          <Search {...ICON} aria-hidden />
          <input type="search" value={query} aria-label="搜索记忆" placeholder="搜索" onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); } }} />
          {query ? <button type="button" className={m.clear} aria-label="清空搜索" onClick={() => setQuery("")}><X size={14} aria-hidden /></button> : null}
        </label>
        {counts.superseded || counts.forgotten ? (
          <SegmentedSwitch label="状态" selected={status} onSelect={setStatus}
            segments={STATUS.filter((tab) => tab.id === "active" || counts[tab.id]).map((tab) => ({ id: tab.id, label: <>{tab.label}<span className={m.segCount}>{counts[tab.id]}</span></>, ariaLabel: `${tab.label} ${counts[tab.id]}` }))} />
        ) : null}
        <HeroButton variant="tertiary" size="sm" aria-expanded={importing} onPress={toggleImport}>
          {importing ? "收起" : <>导入{pending.length ? <span className={m.badge} aria-label={`${pending.length} 次待确认`}>{pending.length}</span> : null}</>}
        </HeroButton>
      </div>

      {importing ? (
        <Section title="导入" testId="memory-import">
          <ImportBody pending={pending} onConfirmed={() => { void load(query); void loadImports(); }} />
        </Section>
      ) : null}

      <PartnerMemories memory={partner} />

      {failed ? <FailedLine reason="没读到记忆" onRetry={() => void load(query)} /> : null}
      {items === null && !failed ? <Loading /> : null}
      {empty ? (
        <div className={m.empty}>
          {query || status !== "active" || !partner?.items.length ? <p>{query ? "没有找到" : status === "active" ? "还没有记忆" : "没有"}</p> : null}
          {!query && status === "active" && !importing ? <HeroButton variant="tertiary" size="sm" onPress={() => setImporting(true)}><Plus {...ICON} aria-hidden />导入</HeroButton> : null}
        </div>
      ) : null}
      {shown.map((group) => (
        <Section key={group.id} title={`${group.label} ${group.items.length}`} testId={`memory-${group.id}`}>
          <ul className={m.list}>
            {group.items.map((item) => (
              <MemoryRow key={item.id} item={item} query={query} role={viewer} replacedBy={items?.find((other) => other.id === item.supersededBy)}
                onSaved={replace} onForget={() => void forget(item)} onRestore={() => void restore(item)} onPurge={() => purge(item)} go={go} />
            ))}
          </ul>
        </Section>
      ))}
    </>
  );
}

/** 导入：有没确认完的先看它们（多次时上面一排切换），「新导入」随时切过去。 */
function ImportBody({ pending, onConfirmed }: { pending: MemoryImport[]; onConfirmed: () => void }) {
  const [view, setView] = useState<string>(pending[0]?.id ?? "new");
  const [known, setKnown] = useState<MemoryImport[]>(pending);
  const tabs = [...known.map((item) => ({ id: item.id, label: `${SOURCE_LABEL[item.source]} · ${shortDate(item.createdAt)}` })), { id: "new", label: "新导入" }];
  return (
    <div className={m.importBody}>
      {known.length ? <SegmentedSwitch label="导入" segments={tabs} selected={view} onSelect={setView} /> : null}
      {view === "new" ? (
        <MemoryImportPanel onCreated={(created) => { setKnown((current) => [created, ...current]); setView(created.id); }} />
      ) : (
        <MemoryImportReview key={view} importId={view} onConfirmed={onConfirmed}
          onDiscarded={() => { const rest = known.filter((item) => item.id !== view); setKnown(rest); setView(rest[0]?.id ?? "new"); }} />
      )}
    </div>
  );
}

/** 搜索词高亮。 */
function marked(text: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const parts: ReactNode[] = [];
  const lower = text.toLowerCase(), target = needle.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(target); at >= 0; at = lower.indexOf(target, from)) {
    parts.push(text.slice(from, at), <mark key={at}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return parts;
}

function MemoryRow({ item, query, role, replacedBy, onSaved, onForget, onRestore, onPurge, go }: {
  item: MemoryItem; query: string; role: "ceo" | "member"; replacedBy?: MemoryItem;
  onSaved: (item: MemoryItem) => void; onForget: () => void; onRestore: () => void; onPurge: () => Promise<void>; go: (href: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: item.title, text: item.text });
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [purging, setPurging] = useState<"ask" | "busy" | "failed" | null>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const editable = item.status === "active";
  const reference = item.references[item.references.length - 1];

  const start = () => { if (!editable) return; setDraft({ title: item.title, text: item.text }); setSaveFailed(false); setEditing(true); };
  const save = async () => {
    const title = draft.title.trim(), text = draft.text.trim();
    if (!title || !text) return;
    if (title === item.title && text === item.text) { setEditing(false); return; }
    setSaving(true);
    const { data } = await browserApi.PATCH("/api/me/memory/personal/items/{id}", { params: { path: { id: item.id } }, body: { title, text } }).catch(() => ({ data: undefined }));
    setSaving(false);
    if (!data) { setSaveFailed(true); return; }
    onSaved(data);
    setEditing(false);
  };
  const purge = () => {
    setPurging("busy");
    onPurge().catch(() => setPurging("failed"));
  };
  useEffect(() => { if (editing) textArea.current?.focus(); }, [editing]);

  if (editing) {
    return (
      <li className={m.row} data-editing="">
        <form className={m.editor} onSubmit={(event) => { event.preventDefault(); void save(); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(false); }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
          }}>
          <input className={p.input} value={draft.title} maxLength={200} aria-label="标题" onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          <textarea ref={textArea} className={p.textarea} value={draft.text} maxLength={4000} aria-label="内容" rows={3}
            onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
          <div className={m.editBar}>
            {saveFailed ? <span className={p.error} role="alert">没存上</span> : null}
            <span className={m.kbd} aria-hidden>⌘↵</span>
            <HeroButton variant="ghost" size="sm" isDisabled={saving} onPress={() => setEditing(false)}>取消</HeroButton>
            <HeroButton variant="primary" size="sm" type="submit" isDisabled={saving || !draft.title.trim() || !draft.text.trim()}>保存</HeroButton>
          </div>
        </form>
      </li>
    );
  }
  return (
    <li className={m.row} data-status={item.status}>
      <div className={m.body} onClick={start} onKeyDown={(event) => { if (event.key === "Enter" && editable) start(); }}
        role={editable ? "button" : undefined} tabIndex={editable ? 0 : undefined} aria-label={editable ? `修改：${item.title}` : undefined}>
        <p className={m.title}>{marked(item.title, query)}</p>
        <p className={m.text}>{marked(item.text, query)}</p>
      </div>
      <div className={m.meta}>
        <time dateTime={item.createdAt}>{shortDate(item.createdAt)}</time>
        {item.anchors.map((anchor) => {
          const href = anchorHref(anchor, role);
          const label = anchorLabel(anchor);
          return href ? <a key={anchor.target} className={m.anchor} href={href} onClick={(event) => { event.preventDefault(); go(href); }}>{label}</a>
            : <span key={anchor.target} className={m.anchor}>{anchor.target.startsWith("topic:") ? `# ${label}` : label}</span>;
        })}
        {reference ? (
          <span className={m.quote} title={reference.quote ?? undefined}>
            <span className={m.source}>{referenceSource(reference.ref)}</span>{reference.quote ? <q>{marked(reference.quote, query)}</q> : null}
          </span>
        ) : null}
        {item.status === "superseded" ? <span className={p.chip} title={replacedBy ? `新：${replacedBy.title}` : undefined}>已被替代</span> : null}
      </div>
      <div className={m.actions} data-open={purging ? "" : undefined}>
        {purging === "ask" || purging === "busy" ? <>
          <span className={m.ask}>彻底删除？</span>
          <HeroButton variant="ghost" size="sm" isDisabled={purging === "busy"} onPress={() => setPurging(null)}>取消</HeroButton>
          <HeroButton variant="danger" size="sm" isDisabled={purging === "busy"} onPress={purge}>删除</HeroButton>
        </> : purging === "failed" ? <FailedLine inline reason="没删掉" onRetry={purge} /> : <>
          {editable ? <HeroButton variant="ghost" size="sm" isIconOnly aria-label="修改" onPress={start}><Pencil {...ICON} aria-hidden /></HeroButton> : null}
          {item.status === "forgotten" ? <HeroButton variant="tertiary" size="sm" onPress={onRestore}><ArchiveRestore {...ICON} aria-hidden />恢复</HeroButton> : null}
          <Dropdown>
            <Dropdown.Trigger className={m.more} aria-label="更多操作"><Ellipsis {...ICON} aria-hidden /></Dropdown.Trigger>
            <Dropdown.Popover placement="bottom end" offset={8} className={h.pop}>
              <Dropdown.Menu aria-label="这条记忆的更多操作" className={h.menuList} onAction={(key) => (key === "forget" ? onForget() : setPurging("ask"))}>
                {item.status === "active" ? <Dropdown.Item id="forget" textValue="忘掉" aria-label="忘掉" className={h.menuItem}>忘掉</Dropdown.Item> : null}
                <Dropdown.Item id="purge" textValue="彻底删除" aria-label="彻底删除" className={`${h.menuItem} ${m.danger}`}>彻底删除</Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </>}
      </div>
    </li>
  );
}
