import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough/parseOnly";

/**
 * 全站渲染 Markdown 共用的 remark 插件，所有 <Markdown> / <ReactMarkdown> 都从这里取，不各自拼。
 * CommonMark 的定界规则对中日韩不友好：`是**《标准验收清单》**，因为` 这类加粗旁边是全角标点、外侧是汉字时，
 * `**` 不被当成加粗，原样显示。remark-cjk-friendly（及其 GFM 删除线版本）按 markdown-cjk-friendly 规范放宽这条规则；
 * 必须排在 remark-gfm 之后。只做解析，不用序列化，所以取 parseOnly 入口。
 */
export const REMARK_PLUGINS: PluggableList = [remarkGfm, remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough];
