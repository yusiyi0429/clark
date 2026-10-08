import { Fragment } from "react";
import r from "./monthly-review.module.css";

/** 四栏下的「依据」：链接（如导入的飞书原文）可以点开，其他原样列出。 */
export function Sources({ sources }: { sources: string[] }) {
  if (!sources.length) return null;
  return <p className={r.sources}>依据：{sources.map((source, index) => <Fragment key={index}>
    {index ? "；" : ""}
    {/^https?:\/\//.test(source) ? <a href={source} target="_blank" rel="noreferrer">{source}</a> : source}
  </Fragment>)}</p>;
}
