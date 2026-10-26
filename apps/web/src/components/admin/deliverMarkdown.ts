/** 周报 Markdown 交给管理员：先放进剪贴板；剪贴板用不了（没授权、不在安全上下文）就直接下载 .md。 */
export type Delivered = "copied" | "downloaded";

export async function deliverMarkdown(text: string, fileName: string, deps: {
  clipboard?: { writeText(text: string): Promise<void> };
  download: (text: string, fileName: string) => void;
}): Promise<Delivered> {
  try {
    if (!deps.clipboard) throw new Error("no clipboard");
    await deps.clipboard.writeText(text);
    return "copied";
  } catch {
    deps.download(text, fileName);
    return "downloaded";
  }
}

export function downloadText(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = fileName;
  document.body.append(link); link.click(); link.remove();
  URL.revokeObjectURL(url);
}
