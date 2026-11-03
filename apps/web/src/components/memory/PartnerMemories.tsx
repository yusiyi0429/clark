import { PARTNER_CATEGORY_LABEL, shortDate, type PartnerMemoryList } from "./memoryModel";
import s from "./memory.module.css";

/** 「我的记忆」页顶上：首页伙伴（独立 Chat）记住的，只读，沿用下面列表的行样式。没接 Chat、没读到、还没有时整块不出现。 */
export function PartnerMemories({ memory }: { memory: PartnerMemoryList | null }) {
  if (!memory?.available || !memory.items.length) return null;
  return (
    <section className={`${s.group} ${s.partner}`} aria-labelledby="memory-partner">
      <h2 id="memory-partner" className={s.groupHead}>伙伴记住的<span className={s.count}>{memory.items.length}</span></h2>
      <ul className={s.list}>
        {memory.items.map((item) => (
          <li key={item.id} className={s.row}>
            <div className={s.body}><p className={s.text}>{item.text}</p></div>
            <div className={s.meta}>
              <time dateTime={item.updatedAt}>{shortDate(item.updatedAt)}</time>
              <span>{PARTNER_CATEGORY_LABEL[item.category]}</span>
              {item.project ? <span className={s.anchor}>{item.project}</span> : null}
              {item.tentative ? <span className={s.stateTag}>推测</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
