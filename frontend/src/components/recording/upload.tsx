"use client";

import { useState } from "react";

/**
 * 上传一份录音。
 *
 * ## 为什么是 XMLHttpRequest，不是 fetch
 *
 * 这一路传的是**几十上百兆的音频**，在一号位的网上是几十秒到几分钟。`fetch` 到今天
 * 也给不出上传方向的进度（`ReadableStream` 请求体那条路要 HTTP/2 加 duplex，浏览器
 * 支持面对不上，而且拿到的是「我塞了多少进去」不是「对面收了多少」）。剩下的选择
 * 只有两种：写一条假的进度条，或者用 `XMLHttpRequest.upload.onprogress`。
 *
 * 假进度条在这里是真的有害：传到一半没动了，屏幕上那条假条还在匀速爬 —— 他会一直等，
 * 而实际上早就该重来了。所以这一处用旧接口，换一个**真的百分比**。
 *
 * ## 传完之后那一段
 *
 * 字节传完（100%）不等于这一份建好了：服务端还要落盘、探时长、建记录。那一段没有
 * 进度可言，所以百分比到 100 就换成一句话，而不是让条子停在 100% 装作还在走。
 */

/** 成功返回新录音的 id；失败一律抛出，`message` 是后端 `error` 的原话。 */
function postRecording(
  file: File,
  title: string,
  participants: string,
  onProgress: (ratio: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    // 空的可选字段不发：后端要区分「没给标题」和「给了一个空标题」，发空串会把
    // 默认标题（会议 YYYY-MM-DD HH:mm）覆盖成一行空白。
    if (title.trim()) form.append("title", title.trim());
    if (participants.trim()) form.append("participants", participants.trim());

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/recordings/upload");
    xhr.upload.onprogress = (e) => {
      // `lengthComputable` 为假时不去猜比例：宁可停在上一个真数，也不编一个。
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new Error("连不上服务，这一份没有传出去。"));
    xhr.onabort = () => reject(new Error("这一次上传被中断了。"));
    xhr.onload = () => {
      let payload: { id?: string; error?: string };
      try {
        payload = JSON.parse(xhr.responseText) as { id?: string; error?: string };
      } catch {
        reject(new Error(`服务返回的不是 JSON（HTTP ${xhr.status}）。`));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300 && payload.id) {
        resolve(payload.id);
        return;
      }
      // 后端那句原话优先。改写成「上传失败」会把「这个格式不认」和「凭据过期」
      // 抹成同一句，而那两条的下一步完全不同。
      reject(new Error(payload.error ?? `这一份没有传成（HTTP ${xhr.status}）。`));
    };
    xhr.send(form);
  });
}

export function RecordingUpload({
  defaultOpen = false,
  onUploaded,
}: {
  /** 一条录音都没有时默认展开：那一页此刻唯一能做的事就是这件。 */
  defaultOpen?: boolean;
  onUploaded: (id: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [participants, setParticipants] = useState("");
  /** null = 没在传。0–1 = 字节进度。1 = 传完了，服务端还在建。 */
  const [ratio, setRatio] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const busy = ratio !== null;

  const send = async () => {
    if (!file || busy) return;
    setFailed(null);
    setRatio(0);
    try {
      const id = await postRecording(file, title, participants, setRatio);
      onUploaded(id);
    } catch (e) {
      setFailed(e instanceof Error ? e.message : "这一份没有传成。");
      setRatio(null);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="meta rounded-[3px] text-ink-faint underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink-muted"
      >
        上传录音
      </button>
    );
  }

  return (
    <div className="rounded-lg border border-hairline px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-ink">上传录音</h2>
        {!busy ? (
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="meta rounded-[3px] px-1 text-ink-faint transition-colors duration-fast hover:text-ink-muted"
          >
            收起
          </button>
        ) : null}
      </div>

      <div className="mt-2.5 space-y-2">
        <input
          type="file"
          accept="audio/*,video/*"
          disabled={busy}
          aria-label="音频或视频文件"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-ink-muted file:mr-3 file:h-7 file:cursor-pointer file:rounded-md file:border file:border-hairline file:bg-transparent file:px-2.5 file:text-sm file:text-ink disabled:opacity-50"
        />
        <input
          value={title}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="标题（可留空，默认按日期）"
          className="w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none disabled:opacity-50"
        />
        <input
          value={participants}
          disabled={busy}
          onChange={(e) => setParticipants(e.target.value)}
          placeholder="参会人，逗号隔开（可留空）"
          className="w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-ink focus:outline-none disabled:opacity-50"
        />
      </div>

      {busy ? (
        <div className="mt-3" aria-live="polite">
          <p className="meta tabular-nums text-ink-muted">
            {ratio < 1 ? `正在上传 ${Math.floor(ratio * 100)}%` : "传完了，正在建这一条。"}
          </p>
          {/* 一条两像素的线，没有圆角没有底色渐变 —— 它报的是一个数，不是一个进度动画。 */}
          <div className="mt-1.5 h-0.5 w-full bg-hairline">
            <div
              className="h-full bg-ink transition-[width] duration-fast"
              style={{ width: `${Math.floor(ratio * 100)}%` }}
            />
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            disabled={!file}
            onClick={() => void send()}
            className="meta inline-flex h-8 items-center rounded-md bg-solid px-3 font-medium text-solid-fg transition-opacity duration-fast hover:opacity-90 disabled:opacity-40"
          >
            上传
          </button>
          {/* 文件名摆出来：选完之后那个原生控件在有些浏览器上只写「未选择文件」的反面，
              而他要确认的是「是不是刚才那一份」。 */}
          {file ? (
            <span className="meta min-w-0 flex-1 truncate text-ink-faint">{file.name}</span>
          ) : null}
        </div>
      )}

      {failed ? (
        <p className="meta mt-2 text-counter" role="alert">
          {failed}
        </p>
      ) : null}
    </div>
  );
}
