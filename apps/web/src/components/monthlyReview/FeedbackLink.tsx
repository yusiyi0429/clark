import { FEEDBACK_URL } from "./reviewApi";
import r from "./monthly-review.module.css";

/** 问题反馈：打开一份飞书记录，大家在复盘、拆解时遇到的问题都记在那里；不混进业务正文。 */
export function FeedbackLink() {
  return <p className={r.feedback}>用的时候觉得哪里别扭、卡住或多余？<a href={FEEDBACK_URL} target="_blank" rel="noreferrer">反馈给产品</a></p>;
}
