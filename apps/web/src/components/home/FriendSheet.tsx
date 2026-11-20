"use client";

/**
 * 好友（同事伙伴设计第 3 节）：好友是加码，不是门；问伙伴、读放出来的资料人人开，勾选单里只有「他的伙伴替他来问」能勾。
 * - GrantRows：勾选单。锁定两行淡一档、没有勾选框、点不动；还没做出来的行（派活、先验、约时间）不画。
 * - FriendRequestView（/me/work/chats/requests/<id>）：有人加我，勾完「开放」或「暂不」，办完回和他伙伴的对话。
 * - FriendPanel：对话页头点对方名字出来的面板，按关系画。
 * - FriendSettingsSections：头像和资料页末尾的「加我好友」「新好友默认开放」，改了就存。
 */
import { useEffect, useState } from "react";
import type { TFriendGrant, TFriendSettings, TFriendView } from "@warmap/contracts";
import { PersonAvatar } from "@/components/avatar/PersonAvatar";
import { HeroButton } from "@/components/HeroButton";
import { FailedLine } from "@/components/work/DecisionBox";
import {
  COLLEAGUE_CHATS_CHANGED, acceptFriend, chatHref, readFriend, readFriendSettings, removeFriend, requestFriend, saveFriendSettings, setFriendGrant,
} from "@/lib/home/colleagueChats";
import { Loading, Section } from "./pages/parts";
import { useViewChrome } from "./view";
import c from "./chats.module.css";
import h from "@/styles/home.module.css";

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : "");
/** 好友关系变了：左栏的「想加你好友」跟着重读。 */
const changed = () => window.dispatchEvent(new Event(COLLEAGUE_CHATS_CHANGED));

export function GrantRows({ value, onChange }: { value: TFriendGrant; onChange?: (next: TFriendGrant) => void }) {
  return (
    <ul className={c.grants}>
      <li className={c.grant} data-locked="">问我的伙伴</li>
      <li className={c.grant} data-locked="">读我放出来的资料</li>
      <li>
        <label className={c.grant}>
          <input type="checkbox" checked={value.agentAsk} disabled={!onChange} readOnly={!onChange} data-testid="grant-agent-ask"
            onChange={onChange ? (event) => onChange({ ...value, agentAsk: event.target.checked }) : undefined} />
          他的伙伴替他来问
        </label>
      </li>
    </ul>
  );
}

/** 有人加我：头像、「{名字} 想加你好友」、「开放给{名字}」的勾选单（初值是我的默认）、「开放」「暂不」。 */
export function FriendRequestView({ personId, go }: { personId: string; go: (href: string) => void }) {
  const chrome = useViewChrome();
  const [friend, setFriend] = useState<TFriendView | null>(null);
  const [grant, setGrant] = useState<TFriendGrant | null>(null);
  const [failed, setFailed] = useState<{ reason: string; retry: () => void } | null>(null);
  const [busy, setBusy] = useState(false);
  const back = () => go(chatHref("with", personId));

  const load = () => {
    setFailed(null);
    Promise.all([readFriend(personId), readFriendSettings()]).then(([view, settings]) => {
      if (view.relation !== "pending_in") { back(); return; }
      setFriend(view); setGrant(settings.defaults);
    }, (cause) => setFailed({ reason: reason(cause), retry: load }));
  };
  useEffect(load, [personId]);

  const act = (work: () => Promise<unknown>) => {
    setBusy(true); setFailed(null);
    work().then(() => { changed(); back(); }, (cause) => setFailed({ reason: reason(cause), retry: () => act(work) })).finally(() => setBusy(false));
  };

  const name = friend?.person.displayName ?? "";
  return (
    <div className={h.page} data-testid="friend-request">
      <header className={h.viewHead}>
        {chrome.lead}
        {friend ? <span className={c.mark}><PersonAvatar personId={personId} className={c.avatar}>{[...name][0] ?? ""}</PersonAvatar></span> : null}
        <h1 className={h.viewTitle} tabIndex={-1}>{name}</h1>
        {chrome.trail}
      </header>
      <div className={h.pageScroll}>
        <div className={h.pageInner}>
          {friend && grant ? (
            <div className={c.request}>
              <p className={c.requestLine}>{`${name} 想加你好友`}</p>
              <p className={c.grantTitle}>{`开放给${name}`}</p>
              <GrantRows value={grant} onChange={busy ? undefined : setGrant} />
              <div className={c.requestActs}>
                <HeroButton variant="primary" size="sm" isDisabled={busy} data-testid="friend-open" onPress={() => act(() => acceptFriend(personId, grant))}>开放</HeroButton>
                <HeroButton variant="ghost" size="sm" isDisabled={busy} data-testid="friend-later" onPress={() => act(() => removeFriend(personId))}>暂不</HeroButton>
              </div>
            </div>
          ) : failed ? null : <Loading />}
          {failed ? <FailedLine reason={failed.reason} onRetry={failed.retry} /> : null}
        </div>
      </div>
    </div>
  );
}

/** 对话页头点对方名字：好友两列（他开给我的只看、我开给他的能改）和「删除好友」；没加「加好友」；我加他「等他同意」「撤回」；他加我「开放」「暂不」。 */
export function FriendPanel({ personId, onClose }: { personId: string; onClose: () => void }) {
  const [friend, setFriend] = useState<TFriendView | null>(null);
  const [failed, setFailed] = useState<{ reason: string; retry: () => void } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setFailed(null);
    readFriend(personId).then(setFriend, (cause) => setFailed({ reason: reason(cause), retry: load }));
  };
  useEffect(load, [personId]);

  const act = (work: () => Promise<TFriendView>, close = false) => {
    setBusy(true); setFailed(null);
    work().then((view) => { setFriend(view); changed(); if (close) onClose(); }, (cause) => setFailed({ reason: reason(cause), retry: () => act(work, close) }))
      .finally(() => setBusy(false));
  };

  const button = (label: string, testId: string, work: () => Promise<TFriendView>, close = false) => (
    <HeroButton key={testId} variant="ghost" size="sm" isDisabled={busy} data-testid={testId} onPress={() => act(work, close)}>{label}</HeroButton>
  );
  let body = null;
  if (friend?.relation === "friends") {
    body = (
      <>
        <div className={c.grantColumns}>
          <div><p className={c.grantTitle}>他开给我的</p><GrantRows value={friend.theirs ?? { agentAsk: false }} /></div>
          <div>
            <p className={c.grantTitle}>我开给他的</p>
            <GrantRows value={friend.mine ?? { agentAsk: false }} onChange={busy ? undefined : (next) => act(() => setFriendGrant(personId, next))} />
          </div>
        </div>
        <div className={c.requestActs}>{button("删除好友", "friend-remove", () => removeFriend(personId), true)}</div>
      </>
    );
  } else if (friend?.relation === "pending_out") {
    body = <div className={c.requestActs}><span className={c.grantTitle}>等他同意</span>{button("撤回", "friend-withdraw", () => removeFriend(personId))}</div>;
  } else if (friend?.relation === "pending_in") {
    body = (
      <div className={c.requestActs}>
        {button("开放", "friend-open", async () => acceptFriend(personId, (await readFriendSettings()).defaults))}
        {button("暂不", "friend-later", () => removeFriend(personId))}
      </div>
    );
  } else if (friend) {
    body = <div className={c.requestActs}>{button("加好友", "friend-add", () => requestFriend(personId))}</div>;
  }
  return (
    <div className={c.friendPanel} data-testid="friend-panel">
      {body ?? (failed ? null : <Loading />)}
      {failed ? <FailedLine reason={failed.reason} onRetry={failed.retry} /> : null}
    </div>
  );
}

/** 头像和资料页末尾两块：「加我好友」两档单选（缺省直接通过），「新好友默认开放」勾选单；改了就存，没存上原处「失败 · 重试」。 */
export function FriendSettingsSections() {
  const [settings, setSettings] = useState<TFriendSettings | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState<{ part: "admission" | "defaults"; reason: string; next: TFriendSettings } | null>(null);

  const load = () => {
    setFailed(null);
    readFriendSettings().then(setSettings, (cause) => setFailed(reason(cause)));
  };
  useEffect(load, []);

  const save = (part: "admission" | "defaults", next: TFriendSettings) => {
    setSettings(next); setSaveFailed(null);
    saveFriendSettings(next).then(setSettings, (cause) => setSaveFailed({ part, reason: reason(cause), next }));
  };
  const failedAt = (part: "admission" | "defaults") => (saveFailed?.part === part
    ? <FailedLine reason={saveFailed.reason} onRetry={() => save(part, saveFailed.next)} /> : null);

  if (failed !== null || !settings) {
    return <Section title="加我好友">{failed !== null ? <FailedLine reason={failed} onRetry={load} /> : <Loading />}</Section>;
  }
  const admission = (value: TFriendSettings["admission"], label: string) => (
    <li>
      <label className={c.grant}>
        <input type="radio" name="friend-admission" value={value} checked={settings.admission === value} data-testid={`admission-${value}`}
          onChange={() => save("admission", { ...settings, admission: value })} />
        {label}
      </label>
    </li>
  );
  return (
    <>
      <Section title="加我好友" testId="friend-admission">
        <ul className={c.grants} role="radiogroup" aria-label="加我好友">{admission("auto", "直接通过")}{admission("approve", "要我同意")}</ul>
        {failedAt("admission")}
      </Section>
      <Section title="新好友默认开放" testId="friend-defaults">
        <GrantRows value={settings.defaults} onChange={(defaults) => save("defaults", { ...settings, defaults })} />
        {failedAt("defaults")}
      </Section>
    </>
  );
}
