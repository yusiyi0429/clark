"use client";

/**
 * 伙伴（伙伴台的「⋯」、个人菜单第二项，设计 9.2、9.4）：名字、形象、性格三块。存法和旧菜单「伙伴形象」同一套（useLiveBuddy）：
 * 点了就存、没有保存按钮；名字离开输入框或回车时存，不合法不存；没存成的那一块下面一行原因，选择退回原来那个。
 * 形象五格两列（左三颗胶囊、右 Miles 和 C妹），一律待机姿势，不写名字和介绍；性格四行，名字加它会说的一句话。选中用强调色淡底，不描边。
 */
import { BuddyNameInput, type BuddyField } from "@/components/buddy/BuddyPicker";
import { useLiveBuddy } from "@/components/buddy/BuddySettings";
import { BUDDY_PERSONALITIES } from "@/components/buddy/PersonalityPicker";
import { PresenceCapsule } from "@/components/coagent/PresenceCapsule";
import { COAGENT_SKINS } from "@/components/coagent/skin";
import type { SecondaryPageProps } from "./index";
import { Loading, Section } from "./parts";
import p from "@/styles/home-pages.module.css";

export function BuddyPage(_props: SecondaryPageProps) {
  const live = useLiveBuddy();
  if (live.loading) return <Loading />;
  const failed = (field: BuddyField) => (live.error?.field === field ? <p className={p.error} role="alert">{live.error.reason}</p> : null);
  return (
    <>
      <Section title="名字">
        <div className={p.field}>
          <BuddyNameInput className={p.input} label="伙伴的名字" value={live.name} onChange={live.setName} onEnter={live.commitName} onBlur={live.commitName} />
          {failed("name")}
        </div>
      </Section>
      <Section title="形象">
        <div className={p.forms} role="radiogroup" aria-label="伙伴形象">
          {COAGENT_SKINS.map((skin) => (
            <label key={skin.id} className={p.form} data-selected={live.value.form === skin.id ? "" : undefined}>
              <input type="radio" name="buddy-form" value={skin.id} checked={live.value.form === skin.id} aria-label={skin.label} onChange={() => live.pick({ form: skin.id })} />
              <span className={p.formStage}><PresenceCapsule skin={skin.id} pose="idle" level={0} name={live.name} /></span>
            </label>
          ))}
        </div>
        {failed("form")}
      </Section>
      <Section title="性格">
        <div className={p.personalities} role="radiogroup" aria-label="伙伴的性格">
          {BUDDY_PERSONALITIES.map((item) => (
            <label key={item.id} className={p.personality} data-selected={(live.value.personality ?? "steady") === item.id ? "" : undefined}>
              <input type="radio" name="buddy-personality" value={item.id} checked={(live.value.personality ?? "steady") === item.id} aria-label={item.label} onChange={() => live.pick({ personality: item.id })} />
              <b>{item.label}</b>
              <small>{item.sample}</small>
            </label>
          ))}
        </div>
        {failed("personality")}
      </Section>
    </>
  );
}
