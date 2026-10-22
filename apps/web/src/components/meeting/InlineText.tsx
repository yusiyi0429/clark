"use client";

import c from "./meeting-card.module.css";

/** 浏览器支持 field-sizing（文本框随内容长高）时只靠 CSS；不支持时按内容量高度。 */
const fieldSizing = typeof CSS !== "undefined" && CSS.supports("field-sizing", "content");
const fit = (node: HTMLTextAreaElement | null | undefined) => {
  if (!node || fieldSizing) return;
  node.style.height = "auto";
  node.style.height = `${node.scrollHeight}px`;
};

type InlineTextProps = {
  value: string;
  editable: boolean;
  /** 文本框的无障碍名（不显示）。 */
  label: string;
  as?: "p" | "h2" | "h4";
  className?: string;
  /** 单行：回车不换行（离开编辑），粘贴进来的换行变空格。 */
  single?: boolean;
  placeholder?: string;
  invalid?: boolean;
  /** 确认、放弃修改进行中：文字照常显示，暂时不能改。 */
  readOnly?: boolean;
  autoFocus?: boolean;
  onChange?: (value: string) => void;
  onBlur?: () => void;
};

/**
 * 就地编辑（Notion / Linear 的写法）：能编辑的人看到的就是正文本身，点进去直接改，文本框随内容长高、长文完整展开；
 * 不能编辑的人看到纯文字。
 */
export function InlineText({ value, editable, label, as: Tag = "p", className, single, placeholder, invalid, readOnly, autoFocus, onChange, onBlur }: InlineTextProps) {
  const classes = [c.text, className].filter(Boolean).join(" ");
  if (!editable) return <Tag className={classes}>{value}</Tag>;
  return (
    <textarea
      className={`${classes} ${c.field}`}
      aria-label={label}
      aria-invalid={invalid || undefined}
      value={value}
      rows={1}
      placeholder={placeholder}
      readOnly={readOnly}
      autoFocus={autoFocus}
      ref={fit}
      onChange={(event) => {
        onChange?.(single ? event.target.value.replace(/\s*\n\s*/g, " ") : event.target.value);
        fit(event.currentTarget);
      }}
      onKeyDown={single ? (event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      } : undefined}
      onBlur={onBlur}
    />
  );
}
