// Word / Excel 转文字的上限和「转不了」的原因。上限只在这一处改。

export const DOC_TEXT_LIMITS = {
  /** 文件本身（压缩后）最大多少字节。 */
  maxFileBytes: 50 * 1024 * 1024,
  /** 压缩包里最多多少个条目。 */
  maxZipEntries: 10_000,
  /** 读到的几个 XML 部件，解压出来一共最多多少字节（防压缩炸弹）。图片这些不解压，不算。 */
  maxUnzippedBytes: 50 * 1024 * 1024,
  /** Excel 所有表加起来，最多多少个有内容的格子。 */
  maxCells: 200_000,
  /** 转出来的 Markdown 最多多少字节（UTF-8），和改动视图的文本上限一致。 */
  maxOutputBytes: 1024 * 1024,
};

export type DocTextFailReason =
  | "unsupported_format" // 老格式（.doc .xls .wps .et）或别的扩展名
  | "too_large" // 文件太大，或解压出来太大
  | "too_many_cells" // Excel 格子太多
  | "output_too_large" // 转出的文字超过上限
  | "encrypted" // 带密码（Office 加密后外壳是 OLE 容器，不是 zip）
  | "corrupt" // 坏了，或其实不是这个格式
  | "unreadable"; // 给的路径读不到

export class DocTextError extends Error {
  constructor(readonly reason: DocTextFailReason, message: string) {
    super(message);
  }
}
