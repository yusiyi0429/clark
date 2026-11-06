"use client";

/**
 * 专题的评审会（V2 设计第 19.1 第 16 条、19.6 节）：本人选 2–3 个挑刺的岗位（默认前三个），本机会话并行请它们挑刺，
 * 合成一份「分歧和建议」存成专题的一版（种类「评审」）。对本机是「说一句」的 kind=review；挑刺岗位开专题时已经带上，
 * 这里点的那几个写进这次的补充要求。
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import Markdown from "react-markdown";
import type { TTopicVersionSummary } from "@warmap/contracts";
import { MenuDialog } from "@/components/AccountMenu";
import { HeroButton } from "@/components/HeroButton";
import { REMARK_PLUGINS } from "@/lib/markdown";
import { listRoles, type RoleView } from "@/lib/team/roles";
import local from "@/styles/v2-local.module.css";
import s from "@/styles/v2-session.module.css";

export const isReview = (version: Pick<TTopicVersionSummary, "kind">) => version.kind === "review";

/** 评审会的补充要求：这次请哪几个挑刺的岗位。 */
export const reviewText = (critics: string[]) => `这次请${critics.map((name) => `「${name}」`).join("、")}挑刺。`;

/** 「分歧和建议」：按二级标题分成几块，各成一张卡；没有二级标题时整篇一块。 */
export function splitSections(body: string): { title: string | null; text: string }[] {
  const sections: { title: string | null; text: string }[] = [];
  let current: { title: string | null; lines: string[] } = { title: null, lines: [] };
  for (const line of body.split("\n")) {
    const heading = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      if (current.title !== null || current.lines.some((entry) => entry.trim())) sections.push({ title: current.title, text: current.lines.join("\n").trim() });
      current = { title: heading[1]!, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.title !== null || current.lines.some((entry) => entry.trim())) sections.push({ title: current.title, text: current.lines.join("\n").trim() });
  return sections;
}

export function ReviewDoc({ body }: { body: string }) {
  return (
    <div className={s.review} data-testid="review-doc">
      <p className={s.reviewHead}>分歧和建议</p>
      {splitSections(body).map((section, index) => (
        <section key={index} className={s.reviewBlock} data-kind={section.title && /分歧/.test(section.title) ? "split" : section.title && /建议/.test(section.title) ? "advice" : undefined}>
          {section.title ? <h3>{section.title}</h3> : null}
          <div className={s.doc}><Markdown remarkPlugins={REMARK_PLUGINS}>{section.text}</Markdown></div>
        </section>
      ))}
    </div>
  );
}

export function ReviewDialog({ onClose, onStart }: { onClose: () => void; onStart: (critics: string[]) => Promise<void> }) {
  const [critics, setCritics] = useState<RoleView[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    void listRoles().then((data) => {
      if (!alive) return;
      const list = data.roles.filter((role) => role.kind === "critic");
      setCritics(list);
      setPicked(list.slice(0, 3).map((role) => role.id));
    }).catch(() => { if (alive) setCritics([]); });
    return () => { alive = false; };
  }, []);
  const toggle = (id: string) => setPicked((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : current.length >= 3 ? current : [...current, id]));
  const names = (critics ?? []).filter((role) => picked.includes(role.id)).map((role) => role.name);
  return (
    <MenuDialog title="评审会" onClose={onClose}>
      <div className={local.start}>
        {critics && !critics.length ? (
          <div className={local.field}>
            <span className={local.faint}>还没有挑刺的岗位</span>
            <Link href="/me/team" className={s.link}>去岗位页添加</Link>
          </div>
        ) : (
          <div className={local.field} role="group" aria-label="挑刺的岗位">
            <span className={local.label}>挑刺的岗位 · 最多 3 个</span>
            <div className={local.chipRow}>
              {(critics ?? []).map((role) => (
                <button key={role.id} type="button" role="checkbox" aria-checked={picked.includes(role.id)} className={local.choice} onClick={() => toggle(role.id)}>{role.name}</button>
              ))}
            </div>
          </div>
        )}
        <div className={local.actions}>
          <HeroButton variant="ghost" size="sm" onPress={onClose}>取消</HeroButton>
          <HeroButton variant="primary" size="sm" isDisabled={busy || !names.length} onPress={() => { setBusy(true); void onStart(names).finally(() => setBusy(false)); }}>开始</HeroButton>
        </div>
      </div>
    </MenuDialog>
  );
}
