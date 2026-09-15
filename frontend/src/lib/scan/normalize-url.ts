/**
 * 对齐自 tkos-lab/src/tkos_lab/sources/__init__.py 的 `normalize_url`。
 *
 * **这是跨仓库契约里最容易静默漂掉的一处。** 幂等键 = 归一化后的 URL
 * （`inbox.ts` 收的 `dedupe_key`），实验台那边由 `deliver.build_payload` 算；
 * 而「主动开始扫描」这条路是正式版自己驱动实验台的 run，产出到手之后**没有人替
 * 它算这个键**，只能在这边算一次。两份规则算出两个键，同一篇文章就会在一号位的
 * 待挑列表上堆两条 —— 而从任何一侧的产出上都看不出来。
 *
 * 所以规则照抄，一条一条：去 fragment、去追踪参数、scheme 与 host 小写、去末尾
 * 斜杠，其余 query 原样保留（顺序也不动），空串进空串出。query 的重新编码也照抄
 * Python 的 `urlencode`（`quote_plus`），否则 `?q=中 文` 这类参数两边编码不同、
 * 键就不一样。
 *
 * 单测里那几条案例是拿 Python 那一份跑出来对过的（含中文路径、显式默认端口、
 * `quote_plus` 的空格与 `*`、坏的百分号转义），一条不差。所以这里刻意**不用
 * `new URL`**：它会顺手改掉 path（中文被百分号编码）和 netloc（默认端口被删），
 * 每一处单看都对，合起来就是两个键。
 */

/** 追踪参数。前缀匹配而不是精确匹配：utm_* 有一整族，阿里系的 spm 也有变体。 */
const TRACKING_PREFIX = ["utm_", "spm"];
const TRACKING_EXACT = new Set(["gclid", "fbclid", "msclkid", "yclid", "ref_src"]);

const isTracking = (name: string): boolean => {
  const n = name.toLowerCase();
  return TRACKING_EXACT.has(n) || TRACKING_PREFIX.some((p) => n.startsWith(p));
};

/** 坏字节 → U+FFFD，同 Python `unquote` 的 `errors="replace"`。fatal 不能开。 */
const utf8 = new TextDecoder("utf-8");

/**
 * Python `urllib.parse.unquote_plus`。
 *
 * 不用 `decodeURIComponent`：**坏的百分号转义它会抛**，而 Python 是替换成 U+FFFD
 * 接着走。抛出去等于让一条畸形参数掀掉整轮扫描的产出；吞掉不解码则是另一个键。
 * 所以按 Python 的做法逐段收字节：连续的 `%XX` 攒成一串一起解码（一个汉字是三个
 * 字节，分三次解就是三个 U+FFFD），认不出来的 `%` 原样留着。
 */
const unquotePlus = (s: string): string => {
  const plus = s.replace(/\+/g, " ");
  if (!plus.includes("%")) return plus;

  let out = "";
  let bytes: number[] = [];
  const flush = () => {
    if (bytes.length) {
      out += utf8.decode(new Uint8Array(bytes));
      bytes = [];
    }
  };
  for (let i = 0; i < plus.length; ) {
    if (plus[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(plus.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(plus.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      flush();
      out += plus[i];
      i += 1;
    }
  }
  flush();
  return out;
};

/**
 * Python `urllib.parse.quote_plus`。
 *
 * `encodeURIComponent` 不是它：`!'()*` 这五个字符它留着不编码，Python 会编码；
 * 空格它编成 `%20`，Python 编成 `+`。这里把两处补上。
 */
const quotePlus = (s: string): string =>
  encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");

/**
 * `scheme://netloc/path?query#fragment` 五段，对齐 `urllib.parse.urlsplit`。
 *
 * `scheme://netloc` 整段可选：没有 scheme 的 `a.com/x?utm_source=w`，Python 解析成
 * 一条纯 path（键是 `a.com/x`），这里也要走同一条路 —— 这种 URL 过不了 `inbox.ts`
 * 的 http(s) 校验、到不了库里，但键算歪了意味着这个函数的规则本身漂了。
 */
const SPLIT = /^(?:([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#.*)?$/;

export function normalizeUrl(url: string): string {
  const raw = (url ?? "").trim();
  if (!raw) return "";

  const m = SPLIT.exec(raw);
  if (!m) return raw;

  const [, scheme, netloc, rawPath, rawQuery] = m;

  const pairs: string[] = [];
  for (const part of (rawQuery ?? "").split("&")) {
    if (!part) continue; // Python 的 parse_qsl 丢掉空片段（`a=1&&b=2`）
    const i = part.indexOf("=");
    // keep_blank_values=True：`a=` 与裸 `a` 都留着，值是空串。
    const k = unquotePlus(i < 0 ? part : part.slice(0, i));
    const v = i < 0 ? "" : unquotePlus(part.slice(i + 1));
    if (isTracking(k)) continue;
    pairs.push(`${quotePlus(k)}=${quotePlus(v)}`);
  }
  const query = pairs.join("&");

  const path = rawPath.replace(/\/+$/, "");
  const head = scheme ? `${scheme.toLowerCase()}://${(netloc ?? "").toLowerCase()}` : "";
  return `${head}${path}${query ? `?${query}` : ""}`;
}
