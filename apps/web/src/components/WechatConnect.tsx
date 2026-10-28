"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Button } from "ts-design/primitives";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import m from "@/styles/account-menu.module.css";

export type WechatConnection = components["schemas"]["WechatConnection"];

const POLL_MS = 1_500;

/** 本人的微信 ClawBot 连接状态；这套天枢没接微信（接口不存在）时为 null，菜单里不出现。 */
export async function readWechatConnection(): Promise<WechatConnection | null> {
  try {
    const { data } = await browserApi.GET("/api/me/wechat");
    return data ?? null;
  } catch {
    return null;
  }
}

/**
 * 连接微信：打开就要一张二维码，等扫码、等手机上确认时每 1.5 秒看一眼状态；连上后显示已连接（自我介绍没发出去、推送暂停时各一行）。
 * 二维码过期、连接失效时给一个按钮重来；已连接时可以断开。
 */
export function WechatConnectPanel({ onChange }: { onChange?: (connection: WechatConnection) => void }) {
  const [connection, setConnection] = useState<WechatConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const update = (next: WechatConnection) => {
    setConnection(next);
    onChange?.(next);
  };

  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      const { data, error: failed } = await browserApi.POST("/api/me/wechat/connect");
      if (data) update(data);
      else setError(failed?.message ?? "暂时连不上微信，请稍后再试");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await browserApi.DELETE("/api/me/wechat");
      update({ state: "none" });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    let alive = true;
    void readWechatConnection().then((current) => {
      if (!alive || !current) return;
      if (current.state === "none") void connect();
      else update(current);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开时读一次
  }, []);

  const waiting = connection?.state === "waiting" || connection?.state === "scanned";
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void readWechatConnection().then((current) => { if (current) update(current); }), POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 等扫码期间轮询
  }, [waiting]);

  if (!connection) return <div className={m.form}>{error ? <p className={m.error} role="alert">{error}</p> : <p className={m.wechatStatus}>正在准备二维码…</p>}</div>;

  if (connection.state === "connected") {
    return (
      <div className={m.form}>
        <p className={m.done}>微信已连接</p>
        {!connection.welcomed ? <p className={m.wechatStatus}>在微信里跟它说声你好</p> : null}
        {connection.paused ? <p className={m.wechatStatus}>推送暂停中，在微信里说一句就恢复</p> : null}
        <div className={m.formActions}>
          <Button variant="ghost" className={m.quietButton} isDisabled={busy} onPress={() => void disconnect()}>断开</Button>
        </div>
      </div>
    );
  }

  if (connection.state === "stale" || connection.state === "none") {
    return (
      <div className={m.form}>
        <p className={m.wechatStatus}>{connection.state === "stale" ? "连接已失效" : "微信未连接"}</p>
        {error ? <p className={m.error} role="alert">{error}</p> : null}
        <div className={m.formActions}>
          <Button variant="ghost" className={m.primary} isDisabled={busy} onPress={() => void connect()}>{connection.state === "stale" ? "重新扫码" : "扫码连接"}</Button>
        </div>
      </div>
    );
  }

  const expired = connection.state === "expired";
  return (
    <div className={m.wechatQr}>
      <div className={m.qrFrame} data-expired={expired || undefined}>
        {connection.qrcodeUrl ? <QRCodeSVG value={connection.qrcodeUrl} size={200} marginSize={0} title="微信扫码连接天枢" /> : null}
      </div>
      <p className={m.wechatStatus} role="status">
        {connection.state === "scanned" ? "在手机上确认" : expired ? "二维码已过期" : "用微信扫码"}
      </p>
      {error ? <p className={m.error} role="alert">{error}</p> : null}
      {expired ? <Button variant="ghost" className={m.primary} isDisabled={busy} onPress={() => void connect()}>换一张</Button> : null}
    </div>
  );
}
