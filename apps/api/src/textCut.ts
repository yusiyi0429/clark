/** 上屏文字按长度截断（UTF-16 单元计）：结尾落单的半个代理对（半个 emoji）一并去掉，网页上不出 �，写进 jsonb 也不会被拒。 */
export const cutText = (text: string, max: number): string => text.slice(0, max).replace(/[\uD800-\uDBFF]$/, "");
