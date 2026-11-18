import { Section } from "@/components/home/pages/parts";
import { PARTNER_CATEGORY_LABEL, shortDate, type PartnerMemoryList } from "./memoryModel";
import s from "./memory.module.css";
import { FadeText } from "@/lib/home/overflowFade";

/** 「我的记忆」页顶上：首页伙伴（独立 Chat）记住的，只读，沿用下面列表的行样式。没接 Chat、没读到、还没有时整块不出现。 */
export function PartnerMemories({ memory }: { memory: PartnerMemoryList | null }) {
  if (!memory?.available || !memory.items.length) return null;
  return (
    <div className={s.partner}>
      <Section title={`伙伴记住的 ${memory.items.length}`} testId="memory-partner">
        <ul className={s.list}>
          {memory.items.map((item) => (
            <li key={item.id} className={s.row}>
              <div className={s.body}><FadeText as="p" className={s.text}>{item.text}</FadeText></div>
              <div className={s.meta}>
                <time dateTime={item.updatedAt}>{shortDate(item.updatedAt)}</time>
                <span>{PARTNER_CATEGORY_LABEL[item.category]}</span>
                {item.project ? <span className={s.anchor}>{item.project}</span> : null}
                {item.tentative ? <span className={s.tag}>推测</span> : null}
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
