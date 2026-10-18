/**
 * 复盘段落里的出处是 Markdown 链接 `[名称](cite:<ref>)`（apps/api/src/personalReviewGeneration.ts）。
 * 本人改段落时，编辑框里只显示〔名称〕，保存时按原文里同名的出处还原成链接；删掉〔名称〕就是去掉这条出处。
 */
const LINK = /\[([^\]\n]+)\]\(([^()\s]+)\)/g;
const TOKEN = /〔([^〔〕\n]+)〕/g;

export const toEditable = (text: string) => text.replace(LINK, "〔$1〕");

export function fromEditable(edited: string, original: string): string {
  const hrefs = new Map<string, string>();
  for (const [, label, href] of original.matchAll(LINK)) if (!hrefs.has(label)) hrefs.set(label, href);
  return edited.replace(TOKEN, (token, label: string) => {
    const href = hrefs.get(label);
    return href ? `[${label}](${href})` : token;
  });
}

/** 正文里已经显示成出处标记的依据：「依据」一行不再重复列出。 */
export function inlineSources(text: string): Set<string> {
  return new Set([...text.matchAll(LINK)].flatMap(([, , href]) => [href, href.replace(/^cite:/, "")]));
}
