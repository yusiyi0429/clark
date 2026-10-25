/**
 * 语音快捷键：微信输入法的两种语音键各录一次「天枢收到了哪几颗键」，记在这台电脑的浏览器里（快捷键跟着电脑走，不进后端）。
 * 录的是天枢实际收到的键：微信会在系统层吞掉一部分——按住 Ctrl+Win 时吞 Ctrl、只剩 Win；左 Ctrl+U 吞 U、只剩一下单按左 Ctrl——照收到的认。
 * - 按住说话（hold）：录到的那几颗一起按住 HOLD_MS 不松、中间没按别的键 → 唤醒（还按着，微信在录）。
 *   中间多按 Ctrl / Shift / Alt 照样算：微信按住时再按 Shift 是免提，有的电脑上 Ctrl 也没被吞。
 *   没录过时 Windows 上按微信默认的 Ctrl+Win（收到的是 Win）。
 * - 启动语音输入（tap）：录到的那几颗按下又全部松开、不超过 TAP_MS、中间没按别的键也没点鼠标 → 唤醒。
 */
export const VOICE_KEYS_STORAGE = "tianshu-voice-keys-v1";

/** 按住多久算「按住说话」（微信语音是按住说话，远比这长）。 */
export const HOLD_MS = 300;
/** 「启动语音输入」那一下从按下到全部松开的上限（实测左 Ctrl+U 约 0.1 秒）。 */
export const TAP_MS = 500;

export type VoiceMode = "hold" | "tap";
/** 存下来的：两种键各是 KeyboardEvent.code 列表；intro：第一次点「对话天枢」弹过引导了。 */
export type VoiceKeys = { hold?: string[]; tap?: string[]; intro?: boolean };
export type VoiceBindings = Record<VoiceMode, string[] | null>;

/** 微信默认的「按住说话」Ctrl+Win：Ctrl 被微信吞掉，浏览器收到的是 Win。 */
export const DEFAULT_HOLD = ["MetaLeft"];

export function readVoiceKeys(): VoiceKeys {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(VOICE_KEYS_STORAGE) ?? "{}");
    return value && typeof value === "object" ? value as VoiceKeys : {};
  } catch {
    return {};
  }
}

export function saveVoiceKeys(patch: VoiceKeys): VoiceKeys {
  const next = { ...readVoiceKeys(), ...patch };
  try {
    localStorage.setItem(VOICE_KEYS_STORAGE, JSON.stringify(next));
  } catch {
    // 存不下（无痕窗口）：这一次照样生效，下次再录。
  }
  return next;
}

/** 实际拿来比对的两组键：没录过的「按住说话」在 Windows 上用微信默认。 */
export function voiceBindings(keys: VoiceKeys, windows: boolean): VoiceBindings {
  return { hold: keys.hold ?? (windows ? DEFAULT_HOLD : null), tap: keys.tap ?? null };
}

/** 参与录入和比对的键：微信补发的说不出名字的键（Unidentified，keyCode 252）、输入法组词中的键不算。 */
export function gestureCode(event: Pick<KeyboardEvent, "key" | "code" | "keyCode">): string | null {
  if (!event.code || event.key === "Unidentified" || event.key === "Process" || event.keyCode === 229) return null;
  return event.code;
}

/** 按住说话时多按了也不算「别的键」的修饰键。 */
const SPARE = /^(Control|Shift|Alt)(Left|Right)$/;

const sameKeys = (keys: Set<string>, binding: string[] | null) =>
  Boolean(binding?.length) && keys.size === binding!.length && binding!.every((code) => keys.has(code));

/** 一次按键手势：从第一颗键按下到全部松开。点鼠标、焦点在别的输入框里等「不该唤醒」的情况由调用方 spoil()。 */
export function createGesture() {
  const down = new Set<string>();
  const seen = new Set<string>();
  let since = 0;
  let spoiled = false;
  let fired = false;
  const holding = (binds: VoiceBindings) => !spoiled && !fired && Boolean(binds.hold?.length)
    && binds.hold!.every((code) => down.has(code)) && [...seen].every((code) => binds.hold!.includes(code) || SPARE.test(code));
  return {
    idle: () => down.size === 0,
    /** 按下一颗；返回此刻是不是正好按住了「按住说话」那几颗（调用方开始 HOLD_MS 计时）。 */
    down(code: string, at: number, binds: VoiceBindings): boolean {
      if (down.size === 0) {
        seen.clear();
        since = at;
        spoiled = false;
        fired = false;
      }
      down.add(code);
      seen.add(code);
      return holding(binds);
    },
    /** 松开一颗；全部松开、而且正好是「启动语音输入」那一下时返回 true。 */
    up(code: string, at: number, binds: VoiceBindings): boolean {
      if (!down.delete(code) || down.size > 0) return false;
      return !spoiled && !fired && sameKeys(seen, binds.tap) && at - since <= TAP_MS;
    },
    holding,
    spoil() { spoiled = true; },
    fire() { fired = true; },
    reset() {
      down.clear();
      seen.clear();
    },
  };
}

const MODIFIERS = ["Control", "Shift", "Alt", "Meta"];
const rank = (code: string) => {
  const at = MODIFIERS.findIndex((name) => code.startsWith(name));
  return at < 0 ? MODIFIERS.length : at;
};

/** 键帽上的字：修饰键在前；左右 Ctrl / Shift / Alt 分开写（微信设置页就写「左Ctrl」）。 */
export function keyLabels(codes: string[], windows: boolean): string[] {
  return [...codes].sort((a, b) => rank(a) - rank(b)).map((code) => {
    const side = code.endsWith("Left") ? "左 " : code.endsWith("Right") ? "右 " : "";
    const base = code.replace(/(Left|Right)$/, "");
    if (base === "Meta") return `${side === "右 " ? side : ""}${windows ? "Win" : "⌘"}`;
    if (base === "Control") return `${side}Ctrl`;
    if (base === "Shift" || base === "Alt") return `${side}${base}`;
    if (base === "Space") return "空格";
    return base.replace(/^(Key|Digit)/, "");
  });
}
