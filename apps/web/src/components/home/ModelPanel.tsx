"use client";

/**
 * 选模型的面板（设计 17.2 第 40 条，照 Claude Code）：入口是输入框下面的胶囊，点开三行——来源、模型、思考，左边行名、右边现在的值和「›」。
 * 点一行，同一个弹层翻到第二页：顶上一行「‹ 行名」回去，下面是能选的，选中的打勾；选完回到三行，弹层不关。点别处、Esc 关；第二页按 Esc 先回第一页。
 * 只列得出一项的那一行没有「›」、点不了。手持上从底部升起（同权限档那个抽屉）。子会话、开工对话框、项目对话三处共用；每一行的值和选项由调用方算（lib/local/modelPanel）。
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Dropdown } from "@heroui/react";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { rowOpens, type PanelOption, type PanelRow, type PanelRowKey } from "@/lib/local/modelPanel";
import { ICON } from "./StateIcon";
import h from "@/styles/home.module.css";

const BACK = "back";
type Props = {
  /** 胶囊上写的（「Opus 5.5 · 高」），悬停 title。 */
  label: string;
  title?: string | null;
  rows: readonly PanelRow[];
  onPick: (row: PanelRowKey, id: string) => void;
  /** 手持：从底部升起。 */
  sheet?: boolean;
  placement?: "top end" | "bottom start";
  testId?: string;
};

export function ModelPanel({ sheet = false, ...props }: Props) {
  return sheet ? <PanelSheet {...props} /> : <PanelDropdown {...props} />;
}

const RowText = ({ row }: { row: PanelRow }) => (
  <><span className={h.grow}>{row.name}</span><span className={h.panelValue}>{row.value}</span><span className={h.panelMark}>{rowOpens(row) ? <ChevronRight {...ICON} className={h.chevron} aria-hidden /> : null}</span></>
);
const BackText = ({ row }: { row: PanelRow }) => <span className={h.panelBack}><ChevronLeft {...ICON} className={h.chevron} aria-hidden />{row.name}</span>;
const OptionText = ({ option, selected }: { option: PanelOption; selected: boolean }) => (
  <><span className={h.grow}>{option.label}</span>{option.note ? <span className={h.menuFaint}>{option.note}</span> : null}<span className={h.panelMark}>{selected ? <Check {...ICON} aria-hidden /> : null}</span></>
);
const optionName = (option: PanelOption) => (option.note ? `${option.label} ${option.note}` : option.label);

function PanelDropdown({ label, title, rows, onPick, placement = "top end", testId = "model-panel" }: Omit<Props, "sheet">) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<PanelRowKey | null>(null);
  const body = useRef<HTMLDivElement>(null);
  // 翻页后焦点落在哪一项：进第二页是选中的那个，回第一页是刚才那一行。
  const focus = useRef<string | null>(null);
  const row = rows.find((entry) => entry.key === page) ?? null;
  // 翻页时这一页的项会卸掉：先把焦点收到弹层里，不让它掉到页面上（不然这时按 Esc 就不归弹层管了）。
  const go = (next: PanelRowKey | null, key: string) => { focus.current = key; body.current?.focus(); setPage(next); };
  useEffect(() => {
    const key = focus.current;
    focus.current = null;
    if (!key) return;
    // 菜单的项晚一拍才画出来，等它画完再把焦点放上去。
    const timer = window.setTimeout(() => [...(body.current?.querySelectorAll<HTMLElement>("[data-panel-key]") ?? [])].find((item) => item.dataset.panelKey === key)?.focus());
    return () => window.clearTimeout(timer);
  }, [page]);
  const act = (key: string) => {
    if (!row) { const next = rows.find((entry) => entry.key === key); if (next && rowOpens(next)) go(next.key, next.selected); return; }
    if (key !== BACK && key !== row.selected) onPick(row.key, key);
    go(null, row.key);
  };
  // 第二页按 Esc 先回第一页（抢在弹层自己关之前接住）。
  const onKey = (event: ReactKeyboardEvent) => {
    if (event.key !== "Escape" || !row) return;
    event.preventDefault();
    event.stopPropagation();
    go(null, row.key);
  };
  const disabled = row ? row.options.filter((option) => option.disabled).map((option) => option.id) : rows.filter((entry) => !rowOpens(entry)).map((entry) => entry.key);
  return (
    <Dropdown isOpen={open} onOpenChange={(next) => { setOpen(next); if (!next) setPage(null); }}>
      <Dropdown.Trigger className={h.sendTo} aria-label={`模型：${title ?? label}`} data-testid={testId}><b title={title ?? undefined}>{label}</b><ChevronDown {...ICON} /></Dropdown.Trigger>
      <Dropdown.Popover placement={placement} offset={8} className={h.pop}>
        <div ref={body} tabIndex={-1} className={h.panelBody} onKeyDownCapture={onKey} data-testid="model-panel-body" data-page={page ?? "rows"}>
          <Dropdown.Menu key={page ?? "rows"} aria-label={row ? row.name : "模型"} className={h.menuList} disabledKeys={disabled} onAction={(key) => act(String(key))}>
            {row ? (
              <>
                <Dropdown.Section className={h.menuSection}>
                  <Dropdown.Item id={BACK} textValue={row.name} className={h.menuItem} shouldCloseOnSelect={false} data-panel-key={BACK} data-testid="model-panel-back"><BackText row={row} /></Dropdown.Item>
                </Dropdown.Section>
                <Dropdown.Section className={h.menuSection}>
                  {row.options.map((option) => (
                    <Dropdown.Item key={option.id} id={option.id} textValue={optionName(option)} className={h.menuItem} shouldCloseOnSelect={false} data-panel-key={option.id} data-testid="model-panel-option">
                      <OptionText option={option} selected={option.id === row.selected} />
                    </Dropdown.Item>
                  ))}
                </Dropdown.Section>
              </>
            ) : rows.map((entry) => (
              <Dropdown.Item key={entry.key} id={entry.key} textValue={`${entry.name} ${entry.value}`} className={h.menuItem} shouldCloseOnSelect={false} data-panel-key={entry.key} data-static={rowOpens(entry) ? undefined : ""} data-testid="model-panel-row">
                <RowText row={entry} />
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </div>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** 手持上的同一个面板：底部抽屉里两页；Esc 第二页先回第一页，再按收起；点空白处收起。 */
function PanelSheet({ label, title, rows, onPick, testId = "model-panel" }: Omit<Props, "sheet" | "placement">) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [page, setPage] = useState<PanelRowKey | null>(null);
  const row = rows.find((entry) => entry.key === page) ?? null;
  const close = () => { setClosing(true); window.setTimeout(() => { setOpen(false); setClosing(false); setPage(null); }, 160); };
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (page) setPage(null); else close();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, page]);
  const pick = (option: PanelOption) => { if (row && option.id !== row.selected) onPick(row.key, option.id); setPage(null); };
  return (
    <>
      <button type="button" className={h.sendTo} aria-haspopup="dialog" aria-label={`模型：${title ?? label}`} onClick={() => setOpen(true)} data-testid={testId}>
        <b>{label}</b><ChevronDown {...ICON} />
      </button>
      {open ? (
        <div className={h.sheetBackdrop} data-closing={closing ? "" : undefined} onClick={close}>
          <div className={h.sheet} role="dialog" aria-modal="true" aria-label={row ? row.name : "模型"} onClick={(event) => event.stopPropagation()} data-testid="model-panel-sheet">
            <span className={h.grabber} aria-hidden />
            <div className={h.sheetList} key={page ?? "rows"}>
              {row ? (
                <>
                  <button type="button" className={h.menuItem} onClick={() => setPage(null)} data-testid="model-panel-back"><BackText row={row} /></button>
                  {row.options.map((option) => (
                    <button key={option.id} type="button" role="radio" aria-checked={option.id === row.selected} className={h.menuItem} disabled={option.disabled} autoFocus={option.id === row.selected}
                      onClick={() => pick(option)} data-testid="model-panel-option"><OptionText option={option} selected={option.id === row.selected} /></button>
                  ))}
                </>
              ) : rows.map((entry) => (rowOpens(entry)
                ? <button key={entry.key} type="button" className={h.menuItem} onClick={() => setPage(entry.key)} data-testid="model-panel-row"><RowText row={entry} /></button>
                : <div key={entry.key} className={h.menuItem} data-static="" data-testid="model-panel-row"><RowText row={entry} /></div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
