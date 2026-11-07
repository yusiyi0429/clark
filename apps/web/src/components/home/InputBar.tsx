"use client";

/**
 * 新首页的输入框（设计 14.5）：首页、总管线、Task 管线、子会话四处一样。
 * - 空着时是一行高的长条：左边「+」加文件和图片，右边空着是麦克风、有内容才换成发送（回答进行中是停止）。
 * - 回车发送，Shift + 回车换行；写多了往上长，最多 7 行再在框里滚。
 * - 附件三种加法：「+」、粘贴、拖进来；显示在框里、字的上方（图片 56 的缩略图，文件是类型 + 名字 + 大小），鼠标移上去右上角出 ✕。
 *   加不上的在附件下面一行红字写原因（「文件名：格式不支持」「超过 30 MB」「最多 20 个」）。
 * - 「关于：…」胶囊在框里左上角（从 Mission 详情点「问伙伴」带进来的），✕ 去掉。
 * - 「发给」（只在首页）在框下面，由调用方给 under。
 * 发送：按下的一刻字和附件一起清掉，交给 onSend（它负责传附件、发出去）；没发出去（false 或报错）放回去，框里写「失败 · 重试」。
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Mic, Plus, Square, X } from "lucide-react";
import { FailedLine } from "@/components/work/DecisionBox";
import { DictationControls } from "@/conversation/DictationControls";
import { DictationMirror } from "@/conversation/DictationMirror";
import { useDictation } from "@/conversation/useDictation";
import { ATTACHMENT_ACCEPT, admit, attachmentKind, fileNameOf, sizeText } from "@/lib/home/attachments";
import h from "@/styles/home.module.css";

type Draft = { key: number; file: File; url: string | null };
const MAX_HEIGHT = 168;

export function InputBar({ placeholder, onSend, busy = false, onStop, disabled = false, textRequired = false, context, under, dock, draftKey, fill, onText, onHeight }: {
  placeholder: string;
  /** 发出去：true 收下；false 或报错放回去。 */
  onSend: (text: string, files: File[]) => Promise<boolean>;
  /** 回答进行中：右边是停止，回车不发。 */
  busy?: boolean;
  onStop?: () => void;
  disabled?: boolean;
  /** 只带附件不说话能不能发（Chat 要有一句话；子会话可以只带附件）。 */
  textRequired?: boolean;
  context?: { label: string; onClear: () => void } | null;
  under?: ReactNode;
  /** 框上面那一条（「N 个问题等你 / 回到最新」）。 */
  dock?: ReactNode;
  /** 草稿按这个键存在本机浏览器里（切走再回来不丢）；不给不存。 */
  draftKey?: string;
  /** 往框里填一段（回答末尾的选项）：nonce 变了才填，不发。 */
  fill?: { text: string; nonce: number } | null;
  /** 字变了（首页「发给 · 自动」据此猜发给谁）。 */
  onText?: (text: string) => void;
  /** 输入框此刻多高：对话列据此给正文让位。 */
  onHeight?: (height: number) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !onHeight) return;
    const observer = new ResizeObserver(() => onHeight(Math.round(element.offsetHeight)));
    observer.observe(element);
    return () => observer.disconnect();
  }, [onHeight]);
  const [text, setTextState] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ reason: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const sending = useRef(false);
  const version = useRef(0);
  const nextKey = useRef(0);
  const setText = (value: string) => {
    version.current += 1;
    setTextState(value);
    onText?.(value);
    if (!draftKey) return;
    try { if (value) localStorage.setItem(draftKey, value); else localStorage.removeItem(draftKey); } catch { /* 存不了就只留在这一页 */ }
  };
  const dictation = useDictation({ field, value: text, onValue: (value) => setText(value) });

  useEffect(() => {
    if (!draftKey) return;
    try { const saved = localStorage.getItem(draftKey) ?? ""; setTextState(saved); onText?.(saved); } catch { /* 同上 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在换了草稿键时读
  }, [draftKey]);
  useEffect(() => {
    if (!fill) return;
    setText(fill.text);
    requestAnimationFrame(() => { const element = field.current; element?.focus({ preventScroll: true }); element?.setSelectionRange(fill.text.length, fill.text.length); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只响应新的一次填入
  }, [fill?.nonce]);
  // 一行起，跟着字往上长，最多 168（7 行），再多在框里滚。
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);
  // 缩略图的临时地址：去掉、发出、离开时收回。
  const urls = useRef(new Set<string>());
  useEffect(() => () => { for (const url of urls.current) URL.revokeObjectURL(url); }, []);
  const release = (list: Draft[]) => { for (const draft of list) if (draft.url) { URL.revokeObjectURL(draft.url); urls.current.delete(draft.url); } };

  const add = (files: File[]) => {
    if (!files.length || disabled) return;
    const { ok, error: why } = admit(drafts.length, files);
    setError(why);
    setDrafts((current) => [...current, ...ok.map((file) => {
      const url = attachmentKind(fileNameOf(file)) === "image" || file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      if (url) urls.current.add(url);
      return { key: ++nextKey.current, file, url };
    })]);
  };
  const remove = (key: number) => setDrafts((current) => { release(current.filter((draft) => draft.key === key)); return current.filter((draft) => draft.key !== key); });

  const has = (value: string) => !!value.trim() || (!textRequired && drafts.length > 0);
  async function submit(raw = text) {
    if (busy || disabled || sending.current) return;
    sending.current = true;
    const value = (dictation.polishing ? await dictation.settle() : raw).trim();
    if (!value && (textRequired || !drafts.length)) { sending.current = false; return; }
    const kept = drafts;
    setText("");
    setDrafts([]);
    setError(null);
    setFailed(null);
    const cleared = version.current;
    let ok = false;
    try { ok = await onSend(value, kept.map((draft) => draft.file)); }
    catch (cause) { setFailed({ reason: cause instanceof Error ? cause.message : "" }); }
    finally { sending.current = false; }
    if (ok) { release(kept); return; }
    // 没发出去：字放回去（期间又写了就不覆盖），附件放回去。
    if (version.current === cleared) setText(value);
    setDrafts((current) => [...kept, ...current]);
    setFailed((now) => now ?? { reason: "" });
  }
  async function sendDictation() {
    const next = await dictation.finish();
    if (next !== null) await submit(next);
  }

  const showSend = has(text);
  return (
    <div className={h.inputDock} ref={root} data-composer="">
      {dock}
      <div className={h.bar} data-drag={dragging ? "" : undefined} data-disabled={disabled ? "" : undefined} data-testid="input-bar"
        onDragOver={(event) => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); setDragging(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
        onDrop={(event) => { if (!event.dataTransfer.files.length) return; event.preventDefault(); setDragging(false); add([...event.dataTransfer.files]); }}
        onMouseDown={(event) => {
          // 点框里的空白处落到文字框里。
          const target = event.target as HTMLElement;
          if (target !== event.currentTarget || !field.current || field.current.disabled) return;
          event.preventDefault();
          field.current.focus();
        }}>
        {context ? (
          <span className={h.barContext} data-testid="input-context">{context.label}
            <button type="button" aria-label={`去掉 ${context.label}`} onClick={context.onClear}><X size={12} strokeWidth={1.8} aria-hidden /></button>
          </span>
        ) : null}
        {drafts.length ? (
          <ul className={h.atts} aria-label="附件">
            {drafts.map((draft) => {
              const name = fileNameOf(draft.file);
              const dot = name.lastIndexOf(".");
              return (
                <li key={draft.key} className={h.att} data-image={draft.url ? "" : undefined} data-testid="input-attachment">
                  {draft.url ? <img src={draft.url} alt={name} /> : (
                    <>
                      <span className={h.attType}>{dot > 0 ? name.slice(dot + 1) : "file"}</span>
                      <span className={h.attName}><b title={name}>{name}</b><span className={h.num}>{sizeText(draft.file.size)}</span></span>
                    </>
                  )}
                  <button type="button" className={h.attRemove} aria-label={`去掉 ${name}`} onClick={() => remove(draft.key)}><X size={12} strokeWidth={1.8} aria-hidden /></button>
                </li>
              );
            })}
          </ul>
        ) : null}
        {error ? <p className={h.barError} role="alert">{error}</p> : null}
        {dictation.error ? <p className={h.barError} role="alert">{dictation.error}</p> : null}
        {failed && !sending.current ? <div className={h.barFailed}><FailedLine inline reason={failed.reason} onRetry={() => void submit()} /></div> : null}
        <div className={h.barRow}>
          <button type="button" className={h.barTool} title="添加文件或图片" aria-label="添加文件或图片" disabled={disabled} onClick={() => picker.current?.click()}><Plus size={16} strokeWidth={1.8} aria-hidden /></button>
          <input ref={picker} type="file" multiple accept={ATTACHMENT_ACCEPT} hidden onChange={(event) => { add([...(event.target.files ?? [])]); event.target.value = ""; }} />
          <span className={h.barField}>
            <DictationMirror field={field} value={text} marks={dictation.marks} polishing={dictation.polishing} fresh={dictation.fresh} />
            <textarea ref={field} rows={1} value={text} disabled={disabled}
              placeholder={dictation.phase === "finishing" ? "正在收尾…" : dictation.active ? (dictation.live ? "正在听…" : "正在录音，结束后转写…") : placeholder}
              aria-label={placeholder}
              onChange={(event) => { if (!dictation.change(event.target.value)) setText(event.target.value); }}
              onPaste={(event) => { const files = [...event.clipboardData.files]; if (!files.length) return; event.preventDefault(); add(files); }}
              onCompositionStart={() => { composing.current = true; dictation.composition(true); }}
              onCompositionEnd={() => { composing.current = false; dictation.composition(false); }}
              onKeyDown={(event) => {
                if (dictation.keyDown(event)) return;
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) {
                  if (event.key === "Escape") event.stopPropagation();
                  return;
                }
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); event.currentTarget.blur(); return; }
                if (event.key !== "Enter" || event.shiftKey) return;
                event.preventDefault();
                if (dictation.phase === "listening") void sendDictation();
                else if (!dictation.active) void submit();
              }} />
          </span>
          {dictation.active ? (
            <DictationControls dictation={dictation} onToInput={() => dictation.stop()} onSend={sendDictation} canSend={!busy} />
          ) : busy && onStop ? (
            <button type="button" className={h.barSend} aria-label="停止本次回答" title="停止" onClick={onStop}><Square size={12} strokeWidth={2.4} fill="currentColor" aria-hidden /></button>
          ) : showSend ? (
            <button type="button" className={h.barSend} aria-label="发送" title="发送" disabled={disabled || busy} onClick={() => void submit()} data-testid="input-send"><ArrowUp size={16} strokeWidth={2.2} aria-hidden /></button>
          ) : (
            <button type="button" className={h.barTool} aria-label="说话" title="说话" disabled={disabled} onClick={() => void dictation.start()}><Mic size={16} strokeWidth={1.8} aria-hidden /></button>
          )}
        </div>
      </div>
      {under ? <div className={h.barUnder}>{under}</div> : null}
    </div>
  );
}
