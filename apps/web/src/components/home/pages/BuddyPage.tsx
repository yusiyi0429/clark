"use client";

/**
 * 伙伴（伙伴台的「⋯」、个人菜单第二项，设计 9.2、9.4）：名字、形象、性格三块，改了就存（PUT /api/me/buddy，和老菜单「伙伴形象」同一个接口），
 * 存好发 buddy-changed，伙伴台上的伙伴马上换。名字离开输入框或回车时存（1–12 宽才存）；形象、性格点了就存。没存上原处「失败 · 重试」。
 * 形象：「在听 / 在说」分段看两种姿势，五格两列（左三颗胶囊、右 Miles 和 C妹），不写名字和介绍；性格四行，名字加它会说的一句话。
 * 选中用强调色淡底（选择控件的选中态），不描边。
 */
import { useState } from "react";
import { SegmentedSwitch } from "@/components/SegmentedSwitch";
import { BuddyNameInput } from "@/components/buddy/BuddyPicker";
import { BUDDY_PERSONALITIES } from "@/components/buddy/PersonalityPicker";
import { buddyNameValid, initialBuddyDraft, saveBuddy, useBuddy, type Buddy } from "@/components/buddy/useBuddy";
import { PresenceCapsule, type CapsulePose } from "@/components/coagent/PresenceCapsule";
import { useSimulatedLevel } from "@/components/coagent/SkinPicker";
import { COAGENT_SKINS } from "@/components/coagent/skin";
import { FailedLine } from "@/components/work/DecisionBox";
import type { SecondaryPageProps } from "./index";
import { Loading, Section } from "./parts";
import p from "@/styles/home-pages.module.css";

export function BuddyPage(_props: SecondaryPageProps) {
  const { buddy, loading } = useBuddy();
  if (loading) return <Loading />;
  return <BuddyForm stored={buddy} />;
}

function BuddyForm({ stored }: { stored: Buddy | null }) {
  const [value, setValue] = useState<Buddy>(() => initialBuddyDraft(stored));
  const [saved, setSaved] = useState<Buddy | null>(stored);
  const [failed, setFailed] = useState<{ reason: string; retry: () => void } | null>(null);
  const [pose, setPose] = useState<CapsulePose>("listening");
  const level = useSimulatedLevel(pose === "listening");
  /** 存一份；名字不合规时不存（名字框自己挡超宽，空名字留着等本人写完）。 */
  const commit = async (next: Buddy) => {
    setValue(next);
    if (!buddyNameValid(next.name)) return;
    if (saved && saved.name === next.name.trim() && saved.form === next.form && saved.personality === next.personality) return;
    setFailed(null);
    try { setSaved(await saveBuddy(next)); }
    catch (cause) { setFailed({ reason: cause instanceof Error ? cause.message : "", retry: () => void commit(next) }); }
  };
  return (
    <>
      <Section title="名字">
        <div className={p.field} onBlur={() => void commit(value)}>
          <BuddyNameInput className={p.input} label="伙伴的名字" value={value.name} onChange={(name) => setValue((current) => ({ ...current, name }))}
            onEnter={() => void commit(value)} />
        </div>
      </Section>
      <Section title="形象" aside={<SegmentedSwitch label="预览姿势" segments={[{ id: "listening", label: "在听" }, { id: "speaking", label: "在说" }]} selected={pose === "speaking" ? "speaking" : "listening"} onSelect={setPose} />}>
        <div className={p.forms} role="radiogroup" aria-label="伙伴形象">
          {COAGENT_SKINS.map((skin) => (
            <label key={skin.id} className={p.form} data-selected={value.form === skin.id ? "" : undefined}>
              <input type="radio" name="buddy-form" value={skin.id} checked={value.form === skin.id} aria-label={skin.label} onChange={() => void commit({ ...value, form: skin.id })} />
              <span className={p.formStage}><PresenceCapsule skin={skin.id} pose={pose} level={level} name={value.name} /></span>
            </label>
          ))}
        </div>
      </Section>
      <Section title="性格">
        <div className={p.personalities} role="radiogroup" aria-label="伙伴的性格">
          {BUDDY_PERSONALITIES.map((item) => (
            <label key={item.id} className={p.personality} data-selected={value.personality === item.id ? "" : undefined}>
              <input type="radio" name="buddy-personality" value={item.id} checked={value.personality === item.id} onChange={() => void commit({ ...value, personality: item.id })} />
              <b>{item.label}</b>
              <small>{item.sample}</small>
            </label>
          ))}
        </div>
      </Section>
      {failed ? <FailedLine reason={failed.reason} onRetry={failed.retry} /> : null}
    </>
  );
}
