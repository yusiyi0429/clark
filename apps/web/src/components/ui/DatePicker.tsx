"use client";

/**
 * 全站统一的日期 / 日期时间选择（替代原生 <input type="date"> / datetime-local）。
 * 月历来源：Tianshu-MVP `components/tasks/CreateTaskScreen.tsx` 的 DateChoice（React Aria Calendar + zh-CN）与
 * `components/tasks/create-task.module.css` 的月历样式（圆形日格、今天蓝字、选中实心蓝）；触发器外观照全站输入框（--field-*）。
 * 值的形状与原生控件一致，替换时调用方不用改：日期「2026-10-15」，日期时间「2026-10-15T10:00」（公司时区，不带偏移）。
 * 显示成「10 月 15 日 周四」「10 月 15 日 周四 10:00」。手持与触屏：月历在底部 sheet 里，日格 44。
 */
import { useState } from "react";
import { parseDate } from "@internationalized/date";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Button, Calendar, CalendarCell, CalendarGrid, CalendarGridBody, CalendarGridHeader, CalendarHeaderCell, Dialog, DialogTrigger, Heading, I18nProvider, Modal, ModalOverlay, Popover } from "react-aria-components";
import { TianshuPortalTheme } from "ts-design";
import { Select } from "./Select";
import { companyToday, dateLabel, splitDateTime, timeOptions } from "./pickerFormat";
import { useHandheld } from "./useHandheld";
import p from "./picker.module.css";

const safeDate = (iso?: string) => {
  if (!iso) return undefined;
  try { return parseDate(iso); } catch { return undefined; }
};

/** 月历本体：上方「2026年10月 ‹ ›」，下方七列日格。CreateTaskScreen 的快捷项 + 月历也可以直接用它。 */
export function CalendarPanel({ value, min, max, onChange, label }: { value: string; min?: string; max?: string; onChange: (iso: string) => void; label: string }) {
  return <I18nProvider locale="zh-CN">
    <Calendar className={p.calendar} aria-label={label} value={safeDate(value) ?? null} minValue={safeDate(min)} maxValue={safeDate(max)} onChange={(date) => onChange(date.toString())}>
      <header className={p.calHead}>
        <Heading className={p.calTitle} />
        <Button slot="previous" className={p.calNav} aria-label="上个月"><ChevronLeft size={16} aria-hidden /></Button>
        <Button slot="next" className={p.calNav} aria-label="下个月"><ChevronRight size={16} aria-hidden /></Button>
      </header>
      <CalendarGrid className={p.calGrid}>
        <CalendarGridHeader>{(day) => <CalendarHeaderCell className={p.calWeekday}>{day}</CalendarHeaderCell>}</CalendarGridHeader>
        <CalendarGridBody>{(date) => <CalendarCell date={date} className={p.calDay}>{date.day}</CalendarCell>}</CalendarGridBody>
      </CalendarGrid>
    </Calendar>
  </I18nProvider>;
}

export type DatePickerProps = {
  value: string;
  onChange: (value: string) => void;
  /** 读屏与 sheet 标题用的名字，如「截止」「开始」。 */
  label: string;
  placeholder?: string;
  min?: string;
  max?: string;
  /** 允许清空（显示「清除日期」）。 */
  clearable?: boolean;
  disabled?: boolean;
  size?: "md" | "compact";
  className?: string;
  /** 表单必填：放一个看不见的输入框参与浏览器校验（同原生 required）。 */
  required?: boolean;
};

/** 看不见、但参与表单校验的输入框：未填时浏览器在这里弹提示，聚焦时转给触发器。 */
function RequiredProxy({ value }: { value: string }) {
  return <input className={p.proxy} tabIndex={-1} aria-hidden required value={value} onChange={() => undefined}
    onFocus={(event) => (event.currentTarget.parentElement?.querySelector<HTMLElement>("[data-slot=field-trigger]"))?.focus()} />;
}

export function DatePicker({ value, onChange, label, placeholder = "选择日期", min, max, clearable, disabled, size = "md", className, required }: DatePickerProps) {
  const handheld = useHandheld();
  const [open, setOpen] = useState(false);
  const shown = dateLabel(value);
  const pickLabel = label.endsWith("日期") ? `选择${label}` : `选择${label}日期`;
  const pick = (iso: string) => { onChange(iso); setOpen(false); };
  const body = <>
    <CalendarPanel value={value} min={min} max={max} label={pickLabel} onChange={pick} />
    <div className={p.calFoot}>
      <Button className={p.calLink} onPress={() => pick(companyToday())} isDisabled={Boolean((min && companyToday() < min) || (max && companyToday() > max))}>今天</Button>
      {clearable && value ? <Button className={p.calLink} onPress={() => pick("")}>清除日期</Button> : null}
    </div>
  </>;
  return <div className={[p.root, className].filter(Boolean).join(" ")} data-size={size}>
    {required ? <RequiredProxy value={value} /> : null}
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button className={p.trigger} data-slot="field-trigger" isDisabled={disabled} aria-label={`${label}：${shown || "未选择"}`}>
        <CalendarDays size={15} aria-hidden className={p.leading} />
        <span className={p.value} data-placeholder={shown ? undefined : true}>{shown || placeholder}</span>
        <ChevronDown size={15} strokeWidth={2} aria-hidden className={p.chevron} />
      </Button>
      {handheld
        ? <ModalOverlay className={p.overlay} isDismissable>
          <Modal className={p.sheet}>
            <TianshuPortalTheme className={p.sheetBody}>
              <Dialog className={p.dialog} aria-label={pickLabel}>
                <span className={p.handle} aria-hidden />
                <p className={p.sheetTitle}>{label}</p>
                {body}
              </Dialog>
            </TianshuPortalTheme>
          </Modal>
        </ModalOverlay>
        : <Popover className={`${p.popover} ${p.calPopover}`} placement="bottom start" offset={6}>
          <TianshuPortalTheme><Dialog className={p.dialog} aria-label={pickLabel}>{body}</Dialog></TianshuPortalTheme>
        </Popover>}
    </DialogTrigger>
  </div>;
}

export type DateTimePickerProps = Omit<DatePickerProps, "clearable"> & {
  /** 时刻每档分钟数，默认 15。 */
  step?: number;
};

/** 日期 + 时刻两枚触发器排一行：「📅 10 月 15 日 周四 ⌄」「10:00 ⌄」。先选时刻没有日期时，日期取今天。 */
export function DateTimePicker({ value, onChange, label, placeholder, min, max, disabled, size = "md", className, step = 15, required }: DateTimePickerProps) {
  const { date, time } = splitDateTime(value);
  const minDay = min ? splitDateTime(min).date || min.slice(0, 10) : undefined;
  const maxDay = max ? splitDateTime(max).date || max.slice(0, 10) : undefined;
  return <div className={[p.dateTime, className].filter(Boolean).join(" ")} role="group" aria-label={label}>
    <DatePicker label={`${label}日期`} required={required} value={date} min={minDay} max={maxDay} placeholder={placeholder} disabled={disabled} size={size} className={p.dateTimeDate}
      onChange={(next) => onChange(next ? `${next}T${time || "10:00"}` : "")} />
    <Select aria-label={`${label}时间`} sheetTitle={`${label}时间`} placeholder="时间" value={time} disabled={disabled} size={size} className={p.dateTimeTime}
      options={timeOptions(time, step).map((slot) => ({ value: slot, label: slot }))}
      onChange={(next) => onChange(`${date || companyToday()}T${next}`)} />
  </div>;
}
