"use client";

/**
 * 「我的记忆」（7a-2，参照 ChatGPT 的「管理记忆」、Claude 的记忆设置、Notion 的列表与就地编辑）：
 * - 顶上一个搜索框，右边按状态切换：现行 / 已被替代 / 已忘掉（后两个有才出现，带数字）；
 * - 按四组列：偏好与表达方式、做法、想法与立场、没定的问题；每条是标题、正文，下面一行时间、关于什么、原话出处；
 * - 点正文就地修改（⌘↵ 保存、Esc 取消）；「⋯」里忘掉（提示条可撤销，之后在「已忘掉」里恢复）、彻底删除（要确认）；
 * - 页头「导入」打开导入弹窗：有没确认完的导入先显示确认组件，否则新建。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Modal } from "@heroui/react";
import { TianshuPortalTheme } from "ts-design";
import { Button, Popover } from "ts-design/primitives";
import { ArchiveRestore, Download, Ellipsis, EyeOff, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { browserApi } from "@/lib/api/client";
import type { Card } from "@/lib/api/client";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { MenuDialog } from "@/components/AccountMenu";
import { showWorkspaceToast } from "@/lib/toast";
import { MemoryImportPanel } from "./MemoryImportPanel";
import { MemoryImportReview } from "./MemoryImportReview";
import { anchorHref, anchorLabel, groupMemories, referenceSource, shortDate, SOURCE_LABEL, type MemoryImport, type MemoryItem } from "./memoryModel";
import t from "@/styles/material-tabs.module.css";
import c from "@/styles/confirm-dialog.module.css";
import s from "./memory.module.css";

type Status = MemoryItem["status"];
const NO_CARDS: Card[] = [];
const STATUS_TABS: { id: Status; label: string }[] = [{ id: "active", label: "现行" }, { id: "superseded", label: "已被替代" }, { id: "forgotten", label: "已忘掉" }];
const PENDING: MemoryImport["status"][] = ["processing", "awaiting_review", "failed"];

export function MemoryScreen({ role }: { role: "ceo" | "member" }) {
  const workspace = useWorkspace();
  useRegisterDetail(useMemo(() => ({ scope: "global", label: "我的记忆", mark: null, cards: NO_CARDS }), []));
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("active");
  const [importing, setImporting] = useState(false);
  const [imports, setImports] = useState<MemoryImport[]>([]);
  const [purging, setPurging] = useState<MemoryItem | null>(null);

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

  const counts = useMemo(() => Object.fromEntries(STATUS_TABS.map((tab) => [tab.id, items?.filter((item) => item.status === tab.id).length ?? 0])) as Record<Status, number>, [items]);
  // 当前状态没有条目了（比如最后一条恢复了），回到现行。
  useEffect(() => { if (items && status !== "active" && !counts[status]) setStatus("active"); }, [items, counts, status]);
  const shown = useMemo(() => groupMemories((items ?? []).filter((item) => item.status === status)), [items, status]);
  const replace = (next: MemoryItem) => setItems((current) => current?.map((item) => (item.id === next.id ? next : item)) ?? current);
  const pending = imports.filter((item) => PENDING.includes(item.status));

  const forget = async (item: MemoryItem) => {
    const { data } = await browserApi.DELETE("/api/me/memory/personal/items/{id}", { params: { path: { id: item.id } } }).catch(() => ({ data: undefined }));
    if (!data) { showWorkspaceToast({ text: "没忘掉，请重试" }); return; }
    replace(data);
    showWorkspaceToast({ text: "已忘掉", action: { label: "撤销", run: () => void restore(data, false) } });
  };
  const restore = async (item: MemoryItem, toast = true) => {
    const { data } = await browserApi.POST("/api/me/memory/personal/items/{id}/restore", { params: { path: { id: item.id } } }).catch(() => ({ data: undefined }));
    if (!data) { showWorkspaceToast({ text: "没恢复，请重试" }); return; }
    replace(data);
    if (toast) showWorkspaceToast({ text: "已恢复" });
  };
  const purge = async (item: MemoryItem) => {
    const { response } = await browserApi.DELETE("/api/me/memory/personal/items/{id}", { params: { path: { id: item.id }, query: { purge: "1" } } }).catch(() => ({ response: undefined }));
    setPurging(null);
    if (!response?.ok) { showWorkspaceToast({ text: "没删掉，请重试" }); return; }
    // 被它替代的旧条目变成了已忘掉：整份重读。
    void load(query);
    showWorkspaceToast({ text: "已彻底删除" });
  };

  return (
    <div className={s.screen}>
      <DetailFrame title="我的记忆" onBack={() => workspace.close()}
        actions={<Button variant="ghost" className={s.headerButton} onPress={() => setImporting(true)}>
          <Download size={16} aria-hidden />导入{pending.length ? <span className={s.badge} aria-label={`${pending.length} 次待确认`}>{pending.length}</span> : null}
        </Button>}>
        <div className={s.content}>
          <div className={s.stack}>
            <div className={s.toolbar}>
              <label className={s.search}>
                <Search size={16} aria-hidden />
                <input type="search" value={query} aria-label="搜索记忆" placeholder="搜索" onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); setQuery(""); } }} />
                {query ? <button type="button" className={s.clear} aria-label="清空搜索" onClick={() => setQuery("")}><X size={14} aria-hidden /></button> : null}
              </label>
              <div className={s.tabs} role="tablist" aria-label="状态">
                {STATUS_TABS.filter((tab) => tab.id === "active" || counts[tab.id]).map((tab) => (
                  <button key={tab.id} type="button" role="tab" aria-selected={status === tab.id} className={s.tab} onClick={() => setStatus(tab.id)}>
                    {tab.label}<span>{counts[tab.id]}</span>
                  </button>
                ))}
              </div>
            </div>
            {failed ? <p className={s.error} role="alert">没读到记忆</p> : null}
            {items === null && !failed ? <div className={s.skeleton} aria-busy="true"><i /><i /><i /><i /></div> : null}
            {items && !shown.length ? (
              <div className={s.empty}>
                <p>{query ? "没有找到" : status === "active" ? "还没有记忆" : "没有"}</p>
                {!query && status === "active" ? <Button variant="ghost" className={s.ghost} onPress={() => setImporting(true)}><Plus size={15} aria-hidden />导入</Button> : null}
              </div>
            ) : null}
            {shown.map((group) => (
              <section key={group.id} className={s.group} aria-labelledby={`memory-${group.id}`}>
                <h2 id={`memory-${group.id}`} className={s.groupHead}>{group.label}<span className={s.count}>{group.items.length}</span></h2>
                <ul className={s.list}>
                  {group.items.map((item) => (
                    <MemoryRow key={item.id} item={item} query={query} role={role} replacedBy={items?.find((other) => other.id === item.supersededBy)}
                      onSaved={replace} onForget={() => void forget(item)} onRestore={() => void restore(item)} onPurge={() => setPurging(item)}
                      onOpen={(href, from) => workspace.navigate(href, from)} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </DetailFrame>
      {importing ? (
        <MenuDialog title="导入" wide onClose={() => { setImporting(false); void loadImports(); }}>
          <ImportDialogBody pending={pending} onConfirmed={() => { void load(query); void loadImports(); }} />
        </MenuDialog>
      ) : null}
      <Modal isOpen={Boolean(purging)} onOpenChange={(open) => { if (!open) setPurging(null); }}>
        <Modal.Backdrop className={c.backdrop} isDismissable>
          <Modal.Container size="sm">
            <Modal.Dialog className={c.dialog} role="alertdialog" aria-labelledby="memory-purge-title">
              <h2 id="memory-purge-title" className={s.dialogTitle}>彻底删除？</h2>
              <p className={c.text}>{purging?.title}</p>
              <div className={c.actions}>
                <Button variant="tertiary" autoFocus onPress={() => setPurging(null)}>取消</Button>
                <Button variant="danger" onPress={() => purging && void purge(purging)}>删除</Button>
              </div>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}

/** 导入弹窗：有没确认完的导入先看它们（多次时上面一排切换），「新导入」随时切过去。 */
function ImportDialogBody({ pending, onConfirmed }: { pending: MemoryImport[]; onConfirmed: () => void }) {
  const [view, setView] = useState<string>(pending[0]?.id ?? "new");
  const [known, setKnown] = useState<MemoryImport[]>(pending);
  const tabs = [...known.map((item) => ({ id: item.id, label: `${SOURCE_LABEL[item.source]} · ${shortDate(item.createdAt)}` })), { id: "new", label: "新导入" }];
  return (
    <div className={s.importBody}>
      {known.length ? (
        <div className={s.tabs} role="tablist" aria-label="导入">
          {tabs.map((tab) => (
            <button key={tab.id} type="button" role="tab" aria-selected={view === tab.id} className={s.tab} onClick={() => setView(tab.id)}>
              {tab.id === "new" ? <Plus size={14} aria-hidden /> : null}{tab.label}
            </button>
          ))}
        </div>
      ) : null}
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

function MemoryRow({ item, query, role, replacedBy, onSaved, onForget, onRestore, onPurge, onOpen }: {
  item: MemoryItem; query: string; role: "ceo" | "member"; replacedBy?: MemoryItem;
  onSaved: (item: MemoryItem) => void; onForget: () => void; onRestore: () => void; onPurge: () => void; onOpen: (href: string, from: Element | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ title: item.title, text: item.text });
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [menu, setMenu] = useState(false);
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
  useEffect(() => { if (editing) textArea.current?.focus(); }, [editing]);

  return (
    <li className={s.row} data-status={item.status} data-editing={editing ? "" : undefined}>
      {editing ? (
        <form className={s.editor} onSubmit={(event) => { event.preventDefault(); void save(); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(false); }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save(); }
          }}>
          <input className={s.titleInput} value={draft.title} maxLength={200} aria-label="标题" onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          <textarea ref={textArea} className={s.textInput} value={draft.text} maxLength={4000} aria-label="内容" rows={3}
            onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
          <div className={s.editBar}>
            {saveFailed ? <span className={s.error} role="alert">没存上</span> : null}
            <span className={s.kbd} aria-hidden>⌘↵</span>
            <Button variant="ghost" className={s.quiet} isDisabled={saving} onPress={() => setEditing(false)}>取消</Button>
            <Button variant="ghost" className={s.primary} type="submit" isDisabled={saving || !draft.title.trim() || !draft.text.trim()}>保存</Button>
          </div>
        </form>
      ) : (
        <>
          <div className={s.body} onClick={start} onKeyDown={(event) => { if (event.key === "Enter" && editable) start(); }}
            role={editable ? "button" : undefined} tabIndex={editable ? 0 : undefined} aria-label={editable ? `修改：${item.title}` : undefined}>
            <p className={s.title}>{marked(item.title, query)}</p>
            <p className={s.text}>{marked(item.text, query)}</p>
          </div>
          <div className={s.meta}>
            <time dateTime={item.createdAt}>{shortDate(item.createdAt)}</time>
            {item.anchors.map((anchor) => {
              const href = anchorHref(anchor, role);
              const label = anchorLabel(anchor);
              return href ? <a key={anchor.target} className={s.anchor} href={href} onClick={(event) => { event.preventDefault(); onOpen(href, event.currentTarget); }}>{label}</a>
                : <span key={anchor.target} className={s.anchor}>{anchor.target.startsWith("topic:") ? `# ${label}` : label}</span>;
            })}
            {reference ? (
              <span className={s.quote} title={reference.quote ?? undefined}>
                <span className={s.source}>{referenceSource(reference.ref)}</span>{reference.quote ? <q>{marked(reference.quote, query)}</q> : null}
              </span>
            ) : null}
            {item.status === "superseded" ? <span className={s.stateTag} title={replacedBy ? `新：${replacedBy.title}` : undefined}>已被替代</span> : null}
          </div>
          <div className={s.actions}>
            {editable ? <Button variant="ghost" isIconOnly className={s.iconButton} aria-label="修改" onPress={start}><Pencil size={15} aria-hidden /></Button> : null}
            {item.status === "forgotten" ? <Button variant="ghost" className={s.restore} onPress={onRestore}><ArchiveRestore size={15} aria-hidden />恢复</Button> : null}
            <Popover isOpen={menu} onOpenChange={setMenu}>
              <Button variant="ghost" isIconOnly className={s.iconButton} aria-label="更多操作"><Ellipsis size={16} aria-hidden /></Button>
              <Popover.Content placement="bottom end" offset={6} className={t.popover}>
                <TianshuPortalTheme>
                  <Popover.Dialog aria-label="这条记忆的更多操作" className={t.menu}>
                    {item.status === "active" ? (
                      <Button variant="ghost" className={`${t.item} ${s.menuRow}`} onPress={() => { setMenu(false); onForget(); }}>
                        <EyeOff size={15} strokeWidth={1.8} aria-hidden /><span className={t.label}>忘掉</span>
                      </Button>
                    ) : null}
                    <Button variant="ghost" className={`${t.item} ${s.menuRow}`} data-danger="" onPress={() => { setMenu(false); onPurge(); }}>
                      <Trash2 size={15} strokeWidth={1.8} aria-hidden /><span className={t.label}>彻底删除…</span>
                    </Button>
                  </Popover.Dialog>
                </TianshuPortalTheme>
              </Popover.Content>
            </Popover>
          </div>
        </>
      )}
    </li>
  );
}
