"use client";

/**
 * 选模型的面板（设计 17.2 第 40、50 条，照 Claude Code）：入口是输入框下面的胶囊，点开三行——来源、模型、思考，左边行名、右边现在的值和「›」。
 * 桌面（50 条）：点一行或悬停一下，在第一层右边贴着弹出第二层（HeroUI 的子菜单，react-aria 算位置：顶边对齐这一行，放不下往上挪、右边放不下翻到左边）；
 * 第一层一直在，开着的那一行保持选中底色。第二层是能选的，选中的打勾；选了第二层收起、第一层不关。点别处、Esc 全关；第二层开着时 Esc、← 只收第二层，→、回车打开。
 * 手持上从底部升起（同权限档那个抽屉），地方不够，仍是同一个抽屉里翻到第二页（顶上「‹ 行名」回去）。
 * 只列得出一项的那一行没有「›」、不弹。子会话、开工对话框、项目对话三处共用；每一行的值和选项由调用方算（lib/local/modelPanel）。
 * 来源那一层最底下的「+ 添加来源」（52 条，ADD_SOURCE）这里接住：收起面板、开添加来源的小弹窗，不交给调用方。
 * busy：选了以后要等一会儿才换好的（子会话换执行方，本机要等新的那家起来）——那一行转圈、先写选的那个，换好之前三行都点不了，另外两行的「›」也收起来。
 */
import { useContext, useEffect, useRef, useState, type RefObject } from "react";
import { Dropdown } from "@heroui/react";
import { RootMenuTriggerStateContext } from "react-aria-components";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { ADD_SOURCE, rowOpens, type PanelOption, type PanelRow, type PanelRowKey } from "@/lib/local/modelPanel";
import { AddSourceDialog } from "./AddSourceDialog";
import { ICON, StateIcon } from "./StateIcon";
import h from "@/styles/home.module.css";

type Props = {
  /** 胶囊上写的（「Claude 订阅 · Opus 5.5 · 高」，modelLine），悬停 title。 */
  label: string;
  title?: string | null;
  rows: readonly PanelRow[];
  onPick: (row: PanelRowKey, id: string) => void;
  /** 正在换的那一行和选的那一项（见文件头）。 */
  busy?: { row: PanelRowKey; id: string } | null;
  /** 手持：从底部升起。 */
  sheet?: boolean;
  placement?: "top end" | "bottom start";
  testId?: string;
};

export function ModelPanel({ sheet = false, ...props }: Props) {
  const [adding, setAdding] = useState(false);
  const onAdd = () => setAdding(true);
  return (
    <>
      {sheet ? <PanelSheet {...props} onAdd={onAdd} /> : <PanelDropdown {...props} onAdd={onAdd} />}
      {adding ? <AddSourceDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}

const RowText = ({ row, busy }: { row: PanelRow; busy?: Props["busy"] }) => {
  const waiting = busy?.row === row.key ? busy : null;
  const value = waiting ? row.options.find((option) => option.id === waiting.id)?.label ?? row.value : row.value;
  return (
    <><span className={h.grow}>{row.name}</span><span className={h.panelValue}>{value}</span>
      <span className={h.panelMark}>{waiting ? <StateIcon state="running" label="正在换" /> : !busy && rowOpens(row) ? <ChevronRight {...ICON} className={h.chevron} aria-hidden /> : null}</span></>
  );
};
const BackText = ({ row }: { row: PanelRow }) => <span className={h.panelBack}><ChevronLeft {...ICON} className={h.chevron} aria-hidden />{row.name}</span>;
const OptionText = ({ option, selected }: { option: PanelOption; selected: boolean }) => (
  <><span className={h.grow}>{option.label}</span>{option.note ? <span className={h.menuFaint}>{option.note}</span> : null}<span className={h.panelMark}>{selected ? <Check {...ICON} aria-hidden /> : null}</span></>
);
const optionName = (option: PanelOption) => (option.note ? `${option.label} ${option.note}` : option.label);

function PanelDropdown({ label, title, rows, onPick, onAdd, busy = null, placement = "top end", testId = "model-panel" }: Omit<Props, "sheet"> & { onAdd: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  // 点不开的（只有一项）和换着的时候三行都不弹第二层、也点不了。
  const disabled = rows.filter((entry) => busy || !rowOpens(entry)).map((entry) => entry.key);
  return (
    <Dropdown>
      <Dropdown.Trigger className={h.sendTo} aria-label={`模型：${title ?? label}`} data-testid={testId}><b title={title ?? undefined}>{label}</b><ChevronDown {...ICON} /></Dropdown.Trigger>
      <Dropdown.Popover placement={placement} offset={8} className={h.pop}>
        <div ref={body} className={h.panelBody} data-testid="model-panel-body">
          <Dropdown.Menu aria-label="模型" className={h.menuList} disabledKeys={disabled}>
            {rows.map((entry) => {
              const item = (
                <Dropdown.Item key={entry.key} id={entry.key} textValue={`${entry.name} ${entry.value}`} className={h.menuItem} shouldCloseOnSelect={false} data-panel-key={entry.key} data-static={busy || !rowOpens(entry) ? "" : undefined} data-busy={busy?.row === entry.key ? "" : undefined} data-testid="model-panel-row">
                  <RowText row={entry} busy={busy} />
                </Dropdown.Item>
              );
              return busy || !rowOpens(entry) ? item : (
                <Dropdown.SubmenuTrigger key={entry.key}>
                  {item}
                  {/* 第二层：贴在这一行右边，顶边对齐（放不下 react-aria 自己往上挪、往左翻）。 */}
                  <Dropdown.Popover placement="end top" className={h.pop} data-testid="model-panel-sub">
                    <Options row={entry} onPick={onPick} onAdd={onAdd} body={body} />
                  </Dropdown.Popover>
                </Dropdown.SubmenuTrigger>
              );
            })}
          </Dropdown.Menu>
        </div>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** 第二层的项：选了只收第二层（第一层不关），焦点回到那一行；选中的那项行尾打勾。 */
function Options({ row, onPick, onAdd, body }: { row: PanelRow; onPick: Props["onPick"]; onAdd: () => void; body: RefObject<HTMLDivElement | null> }) {
  const root = useContext(RootMenuTriggerStateContext);
  const pick = (id: string) => {
    // 「+ 添加来源」：整个面板收起，开小弹窗。
    if (id === ADD_SOURCE) { root?.close(); onAdd(); return; }
    if (id !== row.selected) onPick(row.key, id);
    // 开着的第二层在第 0 级；它的键是 react-aria 给子菜单自己起的（不是这一行的 id），照栈里那个收。
    const open = root?.expandedKeysStack[0];
    if (open !== undefined) root?.closeSubmenu(open, 0);
    body.current?.querySelector<HTMLElement>(`[data-panel-key="${row.key}"]`)?.focus();
  };
  return (
    <Dropdown.Menu aria-label={row.name} className={h.menuList} disabledKeys={row.options.filter((option) => option.disabled).map((option) => option.id)} onAction={(key) => pick(String(key))}>
      {row.options.map((option) => (
        <Dropdown.Item key={option.id} id={option.id} textValue={optionName(option)} className={h.menuItem} shouldCloseOnSelect={false} data-panel-key={option.id} data-testid="model-panel-option">
          <OptionText option={option} selected={option.id === row.selected} />
        </Dropdown.Item>
      ))}
    </Dropdown.Menu>
  );
}

/** 手持上的同一个面板：底部抽屉里两页；Esc 第二页先回第一页，再按收起；点空白处收起。 */
function PanelSheet({ label, title, rows, onPick, onAdd, busy = null, testId = "model-panel" }: Omit<Props, "sheet" | "placement"> & { onAdd: () => void }) {
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
  const pick = (option: PanelOption) => {
    if (option.id === ADD_SOURCE) { close(); onAdd(); return; }
    if (row && option.id !== row.selected) onPick(row.key, option.id);
    setPage(null);
  };
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
              ) : rows.map((entry) => (rowOpens(entry) && !busy
                ? <button key={entry.key} type="button" className={h.menuItem} onClick={() => setPage(entry.key)} data-testid="model-panel-row"><RowText row={entry} /></button>
                : <div key={entry.key} className={h.menuItem} data-static="" data-busy={busy?.row === entry.key ? "" : undefined} data-testid="model-panel-row"><RowText row={entry} busy={busy} /></div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
