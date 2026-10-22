"use client";

import { useState, type ReactNode } from "react";
import { ArrowUpRight, Check, ChevronRight, CircleCheck, FileText, Globe, Link2, Plus, Upload } from "lucide-react";
import { ActionButton, FormField, StatusBadge, TianshuPortalTheme } from "ts-design";
import { Button, Popover } from "ts-design/primitives";
import type { components } from "@/lib/api/schema";
import type { TMaterialView } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { dayLabel, daysBeforeDue, monthDayClock, monthDayTime } from "@/lib/companyTime";
import { TianshuMark } from "@/components/TianshuMark";
import { taskSourceLabel } from "./taskSource";
import { linkHost, type MaterialAreaApi } from "@/components/materials/ObjectMaterialArea";
import s from "./task-detail.module.css";
import c from "./task-cover.module.css";
import t from "@/styles/material-tabs.module.css";

type Detail = components["schemas"]["TaskDetailResponse"];
type Task = Detail["task"];
type Progress = Detail["progress"][number];

const SOURCE: Record<Progress["source"], string> = { web: "网页", codex: "Codex", claude: "Claude Code", github: "GitHub", other: "外部工具" };
const FORMAT: Record<TMaterialView["format"], string> = { markdown: "Markdown", docx: "Word", pdf: "PDF", html: "HTML", link: "链接" };
const dateLabel = (date: string | null) => date ? `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日` : null;
const formatTag = (material: TMaterialView) => material.format === "link" ? `链接 · ${linkHost(material.url ?? "")}` : FORMAT[material.format];
/** 卡片下面那一行：谁放进来、何时。Agent 写的沿用阅读页的说法。 */
const origin = (material: TMaterialView) => material.origin === "agent" ? `Agent 按${material.owner.displayName}的要求写`
  : `${material.owner.displayName} ${material.format === "link" ? "放进来" : "上传"}`;

/**
 * 执行事项的封面（design-12）：身份区、完成标准、正在推进的材料、执行过程。完成后换成完成记录：验收记录和结论、交付结果、
 * 逐条打勾的完成标准。材料清单和放材料的动作来自材料区（ObjectMaterialArea），点卡片和在页头下拉里选是同一个动作。
 */
export function TaskCover({ detail, area, editor, onEdit, onInvite, onProgress }: {
  detail: Detail;
  area: MaterialAreaApi;
  /** ⋯ → 编辑展开的表单，放在身份区下面。 */
  editor: ReactNode;
  onEdit: () => void;
  onInvite: () => void;
  /** 写了一条进展：页面换上这条，并重读这件事（推进人写进展会让未启动的变进行中）。 */
  onProgress: (entry: Progress) => void;
}) {
  const done = detail.task.status === "done";
  const acceptance = done ? detail.acceptance : null;
  return <div className={s.taskPane}><div className={s.pane}>
    <Identity detail={detail} onInvite={onInvite} />
    {editor}
    {acceptance ? <>
      <Deliverables ids={acceptance.deliverableMaterialIds} area={area} />
      <Standards detail={detail} area={area} onEdit={onEdit} />
    </> : <>
      <Standards detail={detail} area={area} onEdit={onEdit} />
      <Materials area={area} title={done ? "材料" : "正在推进"} adding={!done && area.canUpload} />
    </>}
    <Process detail={detail} area={area} onProgress={onProgress} />
  </div></div>;
}

function Identity({ detail, onInvite }: { detail: Detail; onInvite: () => void }) {
  const workspace = useWorkspace();
  const task = detail.task;
  const owner = detail.role === "owner";
  const acceptance = task.status === "done" ? detail.acceptance : null;
  const people = [task.owner, ...task.collaborators].map((person) => person.name).join("、");
  const due = dateLabel(task.dueDate);
  const start = dateLabel(task.startDate);
  const early = acceptance && task.dueDate ? daysBeforeDue(acceptance.at, task.dueDate) : null;
  return <section className={`${s.paneBlock} ${c.identity}`} aria-label="这件事">
    {task.mission ? owner
      ? <Button variant="ghost" className={`${s.longLink} ${c.missionLink}`} onPress={() => workspace.navigate(`/me/mission-cards/${encodeURIComponent(task.mission!.cardId)}`)}>{task.mission.title}<ArrowUpRight size={15} aria-hidden /></Button>
      : <p className={c.missionText}>{task.mission.title}</p>
      : <div className={s.paneRow}><StatusBadge tone="info"><span className={s.sourceBadge}>{taskSourceLabel(task)}</span></StatusBadge></div>}
    <p className={s.paneNote}>{task.mission?.battlefieldName || "未关联战场"} · {owner ? "你在推进" : `${task.owner.name}在推进`}</p>
    {task.status === "returned" ? <p className={c.returned}>已退回{task.returnReason ? `：${task.returnReason}` : ""}</p> : null}
    <div className={c.titleRow}>
      <h2 className={c.title}>{task.title}</h2>
    </div>
    <div className={c.metaRow}>
      <span className={c.meta}>{due ? `${due}前完成` : "截止日期待定"}{start ? ` · 计划 ${start}开始` : ""} · 参与：{people}</span>
      {owner && task.status !== "done" ? <Button variant="secondary" onPress={onInvite}>邀请协作</Button> : null}
    </div>
    {acceptance ? <div className={c.record}>
      <div className={c.recordHead}>
        <span className={c.recordBadge}><CircleCheck size={17} strokeWidth={2} aria-hidden />已验收</span>
        <span className={c.recordMeta}>{acceptance.by.name} · {monthDayClock(acceptance.at)}{early === null ? "" : early > 0 ? ` · 比计划早 ${early} 天` : early < 0 ? ` · 比计划晚 ${-early} 天` : " · 按期完成"}</span>
      </div>
      {acceptance.verdict ? <p className={c.verdict}>{acceptance.verdict}</p> : null}
    </div> : null}
  </section>;
}

function Standards({ detail, area, onEdit }: { detail: Detail; area: MaterialAreaApi; onEdit: () => void }) {
  const owner = detail.role === "owner";
  const acceptance = detail.task.status === "done" ? detail.acceptance : null;
  if (acceptance) {
    const met = acceptance.standards.filter((item) => item.met).length;
    if (!acceptance.standards.length) return null;
    return <section className={s.paneBlock} aria-label="完成标准">
      <div className={c.blockHead}><h3>完成标准</h3><span className={c.count} data-all={met === acceptance.standards.length}>{met} / {acceptance.standards.length}</span></div>
      <ul className={c.standards}>{acceptance.standards.map((item, index) => {
        const material = item.materialId ? area.materials.find((entry) => entry.id === item.materialId) : undefined;
        return <li key={index}>
          {item.met ? <span className={c.tick} role="img" aria-label="达到"><Check size={10} strokeWidth={3.4} aria-hidden /></span> : <span className={c.ring} role="img" aria-label="没达到" />}
          <span className={c.standardText}>{item.text}</span>
          {material ? <button type="button" className={c.evidence} onClick={() => area.open(material.id)}>{material.fileName}</button>
            : item.evidence ? <span className={c.evidence}>{item.evidence}</span> : null}
        </li>;
      })}</ul>
    </section>;
  }
  // 10/8 之前就完成、没有验收记录的老事项：有完成标准照常列出（不打勾、不写 N / M），没有就不出这一块。
  if (detail.task.status === "done" && !detail.standards.length) return null;
  return <section className={s.paneBlock} aria-label="完成标准">
    <h3>完成标准</h3>
    {detail.standards.length ? <ul className={c.standards}>{detail.standards.map((text, index) => <li key={index}><span className={c.ring} aria-hidden /><span className={c.standardText}>{text}</span></li>)}</ul>
      : <div className={c.emptyRow}>
        <p className={s.paneNote}>还没写完成标准。</p>
        {owner ? <Button variant="ghost" size="sm" onPress={onEdit}>写完成标准</Button> : null}
      </div>}
  </section>;
}

function Materials({ area, title, adding }: { area: MaterialAreaApi; title: string; adding: boolean }) {
  const { materials } = area;
  if (!materials.length && !adding) return null;
  return <section className={s.paneBlock} aria-label={title}>
    <div className={c.blockHead}><h3>{title}</h3>{materials.length ? <span className={c.count}>{materials.length} 份</span> : null}</div>
    {materials.length ? <div className={c.grid}>
      {materials.map((material) => <MaterialCard key={material.id} material={material} onOpen={() => area.open(material.id)} />)}
      {adding ? <AddCard area={area} /> : null}
    </div> : <>
      <div className={`${c.grid} ${c.entries}`}>
        <button type="button" className={c.entry} onClick={area.pickFile} disabled={area.uploading}>
          <Upload className={c.entryIcon} strokeWidth={1.8} aria-hidden /><span className={c.entryText}><strong>上传文件</strong><span>PDF、Word、Markdown、HTML</span></span>
        </button>
        <button type="button" className={c.entry} onClick={area.pasteLink}>
          <Link2 className={c.entryIcon} strokeWidth={1.8} aria-hidden /><span className={c.entryText}><strong>粘贴链接</strong></span>
        </button>
        {area.draft ? <button type="button" className={c.entry} onClick={area.draft}>
          <TianshuMark className={c.entryIcon} /><span className={c.entryText}><strong>起草文档</strong></span>
        </button> : null}
      </div>
    </>}
  </section>;
}

/** 「添加」卡：点开是同样三项（上传文件 / 粘贴链接 / 起草文档），和页头下拉单最后三项一致。 */
function AddCard({ area }: { area: MaterialAreaApi }) {
  const [open, setOpen] = useState(false);
  const pick = (run: () => void) => { setOpen(false); run(); };
  return <Popover isOpen={open} onOpenChange={setOpen}>
    <Button variant="ghost" className={`${c.entry} ${c.addCard}`} data-add="true" isDisabled={area.uploading}>
      <Plus className={c.entryIcon} strokeWidth={1.9} aria-hidden />
      <span className={c.entryText}><strong>添加</strong></span>
    </Button>
    <Popover.Content placement="bottom start" offset={6} className={t.popover}>
      <TianshuPortalTheme>
        <Popover.Dialog className={t.menu} aria-label="添加材料">
          <Button variant="ghost" className={t.item} onPress={() => pick(area.pickFile)}><Upload size={15} strokeWidth={1.8} aria-hidden /><span className={t.label}>上传文件</span></Button>
          <Button variant="ghost" className={t.item} onPress={() => pick(area.pasteLink)}><Link2 size={15} strokeWidth={1.8} aria-hidden /><span className={t.label}>粘贴链接</span></Button>
          {area.draft ? <Button variant="ghost" className={t.item} onPress={() => pick(area.draft!)}><TianshuMark className={c.menuMark} /><span className={t.label}>起草文档</span></Button> : null}
        </Popover.Dialog>
      </TianshuPortalTheme>
    </Popover.Content>
  </Popover>;
}

/** 按格式画的示意：文档几行线、PDF 一块图加线、HTML 一个标签框、链接一个小浏览器框。Co-Agent 在改时一行淡蓝的光扫过。 */
function Preview({ material }: { material: TMaterialView }) {
  if (material.format === "link") return <span className={c.sheet} data-format="link" aria-hidden><b><i /><i /><i /></b><span><i /><span><i /><i /></span></span></span>;
  if (material.format === "pdf") return <span className={c.sheet} data-format="pdf" aria-hidden><b /><span><i /><i /><i /></span></span>;
  if (material.format === "html") return <span className={c.sheet} data-format="html" aria-hidden><b /><span><i /><i /></span><i /></span>;
  return <span className={c.sheet} data-format={material.format} aria-hidden>
    <i />
    {material.working ? <><i /><i className={c.wash} /><span className={c.caretLine}><i /><em /></span></> : <><i /><i style={{ width: "86%" }} /><i style={{ width: "94%" }} /></>}
  </span>;
}

function MaterialCard({ material, onOpen }: { material: TMaterialView; onOpen: () => void }) {
  return <button type="button" className={c.card} data-working={material.working || undefined} onClick={onOpen}
    aria-label={`${material.fileName}，${formatTag(material)}${material.working ? "，Co-Agent 正在按批注修改" : ""}`}>
    <span className={c.preview}><span className={c.tag}>{formatTag(material)}</span><Preview material={material} /></span>
    <span className={c.cardBody}>
      <span className={c.cardName}>{material.fileName}</span>
      {material.working ? <span className={c.cardMeta} data-working="true"><span className={c.pulse} aria-hidden /><span className={c.cardMetaText}>Co-Agent 正在按批注修改</span></span>
        : <span className={c.cardMeta}>{origin(material)} · {dayLabel(material.createdAt)}</span>}
    </span>
  </button>;
}

/** 完成后的交付结果：验收时选中的第一份是大卡，其余一行一份。说明只写现有的元数据，不替材料编一句摘要。 */
function Deliverables({ ids, area }: { ids: string[]; area: MaterialAreaApi }) {
  const items = ids.map((id) => area.materials.find((material) => material.id === id)).filter((material): material is TMaterialView => !!material);
  if (!items.length) return null;
  const [first, ...rest] = items;
  return <section className={s.paneBlock} aria-label="交付结果">
    <h3>交付结果</h3>
    <div className={c.hero}>
      <span className={c.heroPreview}><Preview material={{ ...first, working: false }} /></span>
      <div className={c.heroText}>
        <div className={c.heroName}>{first.fileName}</div>
        <div className={c.heroMeta}>{first.format === "link" ? linkHost(first.url ?? "") : FORMAT[first.format]} · {first.owner.displayName} · {dayLabel(first.updatedAt)}</div>
        <Button variant="primary" className={c.open} onPress={() => area.open(first.id)}>打开</Button>
      </div>
    </div>
    {rest.map((material) => <button key={material.id} type="button" className={c.row} onClick={() => area.open(material.id)}>
      <span className={c.rowIcon} aria-hidden>{material.format === "link" ? <Globe size={15} strokeWidth={1.8} /> : <FileText size={15} strokeWidth={1.8} />}</span>
      <span className={c.rowName}>{material.fileName}</span>
      <span className={c.rowMeta}>{material.format === "link" ? `${linkHost(material.url ?? "")} · 外部链接` : `${FORMAT[material.format]} · ${material.owner.displayName}`}</span>
      <ArrowUpRight size={15} strokeWidth={1.9} color="#6B7482" aria-hidden />
    </button>)}
  </section>;
}

/**
 * 执行过程：默认折叠成一行。有进展、推进人的判断、会议原话任一样时才有这一块；三样都没有时只留一行「写一条进展」——
 * 进展是本体每周拉取（工单 13）和月度复盘起草读的数据，入口不能没有。
 */
function Process({ detail, area, onProgress }: { detail: Detail; area: MaterialAreaApi; onProgress: (entry: Progress) => void }) {
  const task = detail.task;
  const quote = task.origin?.quote ?? null;
  const has = detail.progress.length > 0 || !!detail.judgment || !!quote;
  const [open, setOpen] = useState(false);
  const [writing, setWriting] = useState(false);
  const reference = task.status === "done" && detail.acceptance
    ? area.materials.filter((material) => !detail.acceptance!.deliverableMaterialIds.includes(material.id)).length : 0;
  const latest = detail.progress[0];
  const summary = [
    detail.progress.length ? `${detail.progress.length} 条进展` : detail.judgment ? "推进人的判断" : quote ? "会议原话" : "",
    latest ? `最近：${latest.body.replace(/\s+/g, " ").slice(0, 40)}` : "",
    reference ? `另有 ${reference} 份参考材料` : "",
  ].filter(Boolean).join(" · ");
  if (!has) return writing
    ? <ProgressComposer taskId={task.id} onSaved={(entry) => { setWriting(false); setOpen(true); onProgress(entry); }} onCancel={() => setWriting(false)} />
    : <button type="button" className={c.toggle} onClick={() => setWriting(true)}><Plus size={14} strokeWidth={2} aria-hidden /><span className={c.toggleText}>写一条进展</span></button>;
  return <>
    <button type="button" className={c.toggle} aria-expanded={open} aria-controls="task-process" onClick={() => setOpen((value) => !value)}>
      <ChevronRight size={14} strokeWidth={2} aria-hidden /><span className={c.toggleText}>执行过程 · {summary}</span>
    </button>
    {open ? <section id="task-process" className={`${s.paneBlock} ${c.process}`} aria-label="执行过程">
      {quote ? <div className={c.pinned}><small>会议原话 · {task.origin?.meetingTitle}</small><p>{quote}</p></div> : null}
      {detail.judgment ? <div className={c.pinned}><small>推进人的判断{detail.judgmentAt ? ` · ${task.owner.name}写于 ${monthDayTime(detail.judgmentAt)}` : ""}</small><p>{detail.judgment}</p></div> : null}
      {detail.progress.length ? <div className={s.progressList}>{detail.progress.map((entry) => <article key={entry.id} className={s.progressEntry}>
        <div className={s.progressMeta}><span className={s.progressSource}>{SOURCE[entry.source]}</span><span>{entry.author.name}</span><time dateTime={entry.createdAt}>{monthDayTime(entry.createdAt)}</time></div>
        <p>{entry.body}</p>{entry.links.length ? <div className={s.progressLinks}>{entry.links.map((link) => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">{link.title || link.url}</a>)}</div> : null}
      </article>)}</div> : null}
      <ProgressComposer taskId={task.id} onSaved={onProgress} />
    </section> : null}
  </>;
}

/** 写一条进展（推进人和协作者都能写；只有推进人写的会让未启动的事项进行中）。按 clientEventId 幂等，失败保留输入。 */
function ProgressComposer({ taskId, onSaved, onCancel }: { taskId: string; onSaved: (entry: Progress) => void; onCancel?: () => void }) {
  const [text, setText] = useState("");
  const [eventId, setEventId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (!text.trim() || busy) return;
    const clientEventId = eventId ?? crypto.randomUUID();
    setEventId(clientEventId); setBusy(true); setError("");
    try {
      const { data, error: failure } = await browserApi.POST("/api/me/tasks/{id}/progress", { params: { path: { id: taskId } }, body: { clientEventId, body: text.trim() } });
      if (!data) throw new Error(failure?.message ?? "进展没保存，请重试");
      setText(""); setEventId(null);
      window.dispatchEvent(new Event("member-tasks-changed"));
      onSaved(data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "进展没保存，输入已保留"); }
    finally { setBusy(false); }
  };
  return <div className={c.composer}>
    <FormField label="写一条进展" value={text} onChange={(value) => { setText(value); setEventId(null); }} multiline rows={3} />
    <div className={s.paneRow}>
      <ActionButton intent="secondary" isDisabled={busy || !text.trim() || text.length > 2000} onPress={() => void save()}>保存</ActionButton>
      {onCancel ? <Button variant="ghost" onPress={onCancel}>取消</Button> : null}
      {error ? <span className={s.error} role="alert">{error}</span> : null}
    </div>
  </div>;
}
