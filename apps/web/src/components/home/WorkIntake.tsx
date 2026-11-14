"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TCreateWorkIntake, TWorkIntakeChange, TWorkIntakeEntry } from "@warmap/contracts";
import { sha256Hex } from "@/components/memory/memoryModel";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { uploadToConversation } from "@/lib/home/attachments";
import { showWorkspaceToast } from "@/lib/toast";
import { HeroButton } from "@/components/HeroButton";
import h from "@/styles/home.module.css";

const CHANGED = "tianshu:work-intake";
const URL = "/api/me/work-intake";

async function request<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, { method, cache: "no-store", ...(body === undefined ? {} :
    {headers: {"content-type":"application/json"},body: JSON.stringify(body)}) });
  if (!response.ok) {
    const error = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(error.message ?? "待发需求暂时无法读取");
  }
  return response.json() as Promise<T>;
}

type DraftReceipt = Pick<TCreateWorkIntake, "id" | "attachments">;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function draftKey(viewerId: string, scope: string, pagePath: string | undefined, text: string, files: File[]) {
  const fingerprints = [];
  // 同名同大小也可能选了另一份文件。逐个读取，避免同时把所有附件载入内存。
  for (const file of files) {
    fingerprints.push([file.name, file.type, await sha256Hex(await file.arrayBuffer())]);
  }
  const signature = JSON.stringify([viewerId, scope, pagePath, text, fingerprints]);
  return "tianshu:work-intake-draft:v1:" + await sha256Hex(new TextEncoder().encode(signature));
}

function storedReceipt(key: string, fileCount: number): DraftReceipt | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    const saved: unknown = JSON.parse(raw);
    if (!saved || typeof saved !== "object" || !("id" in saved) || typeof saved.id !== "string" || !UUID.test(saved.id)
      || !("attachments" in saved) || !Array.isArray(saved.attachments) || saved.attachments.length !== fileCount) return null;
    const attachments = [];
    for (const ref of saved.attachments) {
      if (!ref || typeof ref.id !== "string" || !ref.id) return null;
      attachments.push({ id: ref.id });
    }
    return { id: saved.id, attachments };
  } catch { return null; }
}

async function prepareReceipt(key: string, scope: string, files: File[]): Promise<DraftReceipt> {
  const existing = storedReceipt(key, files.length);
  if (existing) return existing;
  const uploaded = files.length ? await uploadToConversation(scope, files) : [];
  if (uploaded.length !== files.length || uploaded.some(a => !a?.id)) throw new Error("附件上传回执不完整，请重试");
  const receipt = { id: crypto.randomUUID(), attachments: uploaded.map(a => ({ id: a.id })) };
  // 在登记工作之前保存，以便刷新后查询同一次提交。只保存标识和已上传附件的回执。
  try { window.sessionStorage.setItem(key, JSON.stringify(receipt)); } catch { /* 存储不可用时仍可在本页重试。 */ }
  return receipt;
}

export function useViewerQueueWorkInput(viewerId: string | null) {
  const attempts = useRef(new Map<string, Promise<DraftReceipt>>());
  const activeViewer = useRef(viewerId);
  useLayoutEffect(() => {
    activeViewer.current = viewerId;
    return () => { activeViewer.current = null; };
  }, [viewerId]);
  return useCallback(async (scope: string, text: string, files: File[]) => {
    if (!text.trim()) throw new Error("请写下要接着做什么");
    if (!viewerId || activeViewer.current !== viewerId) throw new Error("请重新登录后发送");
    const pagePath = scope === "global" ? window.location.pathname.slice(0, 200) : undefined;
    const key = await draftKey(viewerId, scope, pagePath, text, files);
    if (activeViewer.current !== viewerId) throw new Error("登录成员已变更，请重新发送");
    let prepared = attempts.current.get(key);
    if (!prepared) {
      prepared = prepareReceipt(key, scope, files);
      attempts.current.set(key, prepared);
    }
    let receipt: DraftReceipt;
    try { receipt = await prepared; }
    catch (error) {
      if (attempts.current.get(key) === prepared) attempts.current.delete(key);
      throw error;
    }
    if (activeViewer.current !== viewerId) throw new Error("登录成员已变更，请重新发送");
    const body: TCreateWorkIntake = { ...receipt, scope, message: text, pagePath };
    const item = await request<TWorkIntakeEntry>(URL, "POST", body);
    if (attempts.current.get(key) === prepared) attempts.current.delete(key);
    if (storedReceipt(key, files.length)?.id === receipt.id) {
      try { window.sessionStorage.removeItem(key); } catch { /* 存储不可用。 */ }
    }
    if (activeViewer.current === viewerId) window.dispatchEvent(new CustomEvent(CHANGED, { detail: { scope } }));
    return item;
  }, [viewerId]);
}

export function useQueueWorkInput() {
  return useViewerQueueWorkInput(useWorkspace().viewerId);
}

export function WorkIntakeQueue({ scope, refreshHistory }: { scope: string; refreshHistory: () => void }) {
  const [items, setItems] = useState<TWorkIntakeEntry[]>([]);
  const [error, setError] = useState("");
  const refresh = useRef(refreshHistory);
  refresh.current = refreshHistory;
  const load = useRef<() => void>(() => {});
  useEffect(() => {
    let active = true;
    let sequence = 0;
    let last: string | null = null;
    setItems([]);
    setError("");
    const read = async () => {
      const seq = ++sequence;
      try {
        const answer = await request<{items:TWorkIntakeEntry[]}>(URL + "?scope=" + encodeURIComponent(scope));
        if (!active || seq !== sequence) return;
        const revision = answer.items.map((item) => item.id + ":" + item.state + ":" + item.updatedAt).join(",");
        const sending = answer.items.some(item => item.state === "sending");
        if (sending || (last !== revision && answer.items.some(item => item.state === "delivered"))) refresh.current();
        last = revision;
        setItems(answer.items.filter(item => ["queued","sending","failed"].includes(item.state)));
        setError("");
      } catch (cause) { if (active && seq === sequence) setError(cause instanceof Error ? cause.message : "待发需求未能读取"); }
    };
    load.current = () => { void read(); };
    const changed = (event: Event) => { if (event.type !== CHANGED || (event as CustomEvent).detail?.scope === scope) void read(); };
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void read(); },5000);
    window.addEventListener(CHANGED,changed);
    window.addEventListener("focus",changed);
    void read();
    return () => { active = false; window.clearInterval(timer); window.removeEventListener(CHANGED,changed); window.removeEventListener("focus",changed); };
  },[scope]);
  const change = useCallback(async (item: TWorkIntakeEntry,action: TWorkIntakeChange["action"]) => {
    try { await request(URL + "/" + encodeURIComponent(item.id), "PATCH", {action}); }
    catch (cause) { showWorkspaceToast({text: cause instanceof Error ? cause.message : "没有改成"}); }
    load.current();
  },[]);
  if (!items.length && !error) return null;
  return <section aria-label="待发需求">
    {error ? <p role="status">{error} <HeroButton variant="ghost" size="sm" onPress={() => load.current()}>重试</HeroButton></p> : null}
    {items.map(item => <div key={item.id} className={h.line}>
      <span>{item.state === "failed" ? "发送失败" : item.state === "sending" ? "递送中" : item.priority ? "优先待发" : "排队中"} · {item.message}{item.error ? " · " + item.error : ""}</span>
      {item.state === "failed" ? <HeroButton size="sm" variant="ghost" onPress={() => void change(item,"retry")}>重试</HeroButton> : null}
      {item.state === "queued" && !item.priority ? <HeroButton size="sm" variant="ghost" onPress={() => void change(item,"first")}>优先发送</HeroButton> : null}
      {item.state !== "sending" ? <HeroButton size="sm" variant="ghost" onPress={() => void change(item,"cancel")}>撤回</HeroButton> : null}
    </div>)}
  </section>;
}
