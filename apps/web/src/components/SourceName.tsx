import { shortSourceName, uniqueSources } from "@/lib/displayText";

/** 出处只显示文档短名；完整出处（ID、链接、revision）放在 hover 里。 */
export function SourceName({ value }: { value: string | null | undefined }) {
  const name = shortSourceName(value);
  if (!name) return null;
  return <span title={value && value !== name ? value : undefined}>{name}</span>;
}

/** 一组出处合并成一行：同一份资料只写一次，每个短名的 hover 里是原文。 */
export function SourceNames({ values, separator = "、" }: { values: (string | null | undefined)[]; separator?: string }) {
  const list = uniqueSources(values);
  return (
    <>
      {list.map((item, index) => (
        <span key={item.name} title={item.full && item.full !== item.name ? item.full : undefined}>
          {index ? separator : ""}{item.name}
        </span>
      ))}
    </>
  );
}
