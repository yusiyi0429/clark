"use client";

/**
 * 全站统一的下拉选择（替代原生 <select>）。来源：Tianshu-MVP `components/tasks/TaskEditForm.tsx` 的 React Aria Select + ListBox
 * 与 `components/tasks/create-task.module.css` 的浮层样式（细边框、圆角 16、柔和投影）；触发器外观照全站输入框（--field-*）。
 * 电脑：触发器下方浮层，宽度不小于触发器。手持与触屏（≤959 或粗指针）：底部 sheet，每行 ≥48 高。
 * 空串也是合法值（「请选择」「不指定」），内部换成占位键，对外照旧是 ""。
 */
import { Check, ChevronDown } from "lucide-react";
import type { Key } from "react-aria-components";
import { Button, Label, ListBox, ListBoxItem, Modal, ModalOverlay, Popover, Select as AriaSelect, SelectValue, Text } from "react-aria-components";
import { TianshuPortalTheme } from "ts-design";
import { useHandheld } from "./useHandheld";
import p from "./picker.module.css";

export type SelectOption = { value: string; label: string; description?: string; disabled?: boolean };

const EMPTY = "__select-empty__";
const toKey = (value: string) => (value === "" ? EMPTY : value);
const fromKey = (key: Key | null) => (key === null || key === EMPTY ? "" : String(key));

export type SelectProps = {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  /** 看得见的标签；不给时必须给 aria-label。 */
  label?: string;
  "aria-label"?: string;
  placeholder?: string;
  disabled?: boolean;
  /** compact：表格行里、工具条里用的矮一号（电脑 32，触屏仍 44）。 */
  size?: "md" | "compact";
  className?: string;
  /** 手持 sheet 顶部的标题，默认用 label / aria-label。 */
  sheetTitle?: string;
  name?: string;
  /** 表单必填：交给 React Aria 的隐藏原生下拉参与浏览器校验。 */
  required?: boolean;
};

export function Select({ options, value, onChange, label, placeholder = "请选择", disabled, size = "md", className, sheetTitle, name, required, ...rest }: SelectProps) {
  const handheld = useHandheld();
  const ariaLabel = rest["aria-label"] ?? label;
  const visibleLabel = label && !rest["aria-label"] ? label : "";
  const items = options.map((option) => ({ ...option, id: toKey(option.value) }));
  const known = items.some((item) => item.id === toKey(value));
  const list = <ListBox className={p.list} items={items} aria-label={ariaLabel}>
    {(item) => <ListBoxItem id={item.id} textValue={item.label} isDisabled={item.disabled} className={p.item}>
      {({ isSelected }) => <>
        <span className={p.itemText}><span className={p.itemLabel}>{item.label}</span>{item.description ? <Text slot="description" className={p.itemHint}>{item.description}</Text> : null}</span>
        {isSelected ? <Check size={15} strokeWidth={2.2} aria-hidden className={p.check} /> : <span className={p.checkSpace} aria-hidden />}
      </>}
    </ListBoxItem>}
  </ListBox>;
  return <AriaSelect className={[p.root, className].filter(Boolean).join(" ")} data-size={size} name={name}
    selectedKey={known ? toKey(value) : null} onSelectionChange={(key) => onChange(fromKey(key))}
    isDisabled={disabled} isRequired={required} placeholder={placeholder} aria-label={visibleLabel ? undefined : ariaLabel}>
    {visibleLabel ? <Label className={p.label}>{visibleLabel}</Label> : null}
    <Button className={p.trigger} data-slot="field-trigger">
      <SelectValue className={p.value} />
      <ChevronDown size={15} strokeWidth={2} aria-hidden className={p.chevron} />
    </Button>
    {handheld
      ? <ModalOverlay className={p.overlay} isDismissable>
        <Modal className={p.sheet}>
          <TianshuPortalTheme className={p.sheetBody}>
            <span className={p.handle} aria-hidden />
            {sheetTitle ?? ariaLabel ? <p className={p.sheetTitle}>{sheetTitle ?? ariaLabel}</p> : null}
            {list}
          </TianshuPortalTheme>
        </Modal>
      </ModalOverlay>
      : <Popover className={p.popover} placement="bottom start" offset={6}>
        <TianshuPortalTheme>{list}</TianshuPortalTheme>
      </Popover>}
  </AriaSelect>;
}
