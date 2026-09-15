"use client";

/*
 * 面板底部这条 dock：闲置时是一颗「对话」胶囊、点一下变成球（语音）、点键盘键
 * 换成输入框（打字）。三态各自长什么样全在 `panel.module.css` 里，这个文件只管
 * 状态机、事件绑定和无障碍——不管 caption 的内容、transcript、也不碰模型调用，
 * 那些是 G 组接线时的事（见跨组接口契约「D 组产出」）。
 *
 * 还原依据是原型 `tianshu-dynamic-panel.html` 的 `setDock`/`startVoice`/`endVoice`/
 * `caption`（588-627 行）。哪些照搬、哪些改了，写在下面对应的位置，这里先说三条
 * 全局性的：
 *
 * 0. 那颗胶囊（`.bar`）**永远是同一个 `<div>`**，三态只换它内部谁可见，绝不能按
 *    模式换掉它的标签。这条不是洁癖，是这个组件返工过一次的原因：上一版为了让
 *    打字态能装下真 `<input>` 和真「发送」按钮，写成「打字态渲染 `<div>`、闲置/
 *    语音两态渲染 `<button>`」，于是每次进出打字态，React 都会卸载一个元素再挂载
 *    另一个——CSS 过渡跨不过卸载，新挂上来的节点直接从它的终态计算样式开始画，
 *    胶囊因此是「啪」地变成输入框，没有原型那 0.45s 的展开。语音态那时候还是好的，
 *    只因为闲置和语音走的是同一个分支、标签一样，元素没被换掉——同一个机制，
 *    两态一个能动一个不能，这就是当时最容易看漏的地方。
 *    现在的写法是：外层固定一个 `<div>` 承载所有会动的属性（宽/高/圆角/内边距/
 *    背景），闲置态那颗可点的胶囊改成它里面一个绝对定位铺满的 `<button>`，
 *    输入框和发送键是它的兄弟节点。可交互元素依然没有嵌套，过渡也不再被打断。
 * 1. 模式挂在 `data-dock` 属性上，不挂 class。原型真出过这个事故：如果把模式名
 *    当成 class 加到 dock 上，而这个名字又跟主按钮自己的 class `bar` 撞了，dock
 *    就会继承 `.bar` 的宽高和圆角样式，整条 dock 缩成一颗胶囊跳到面板顶部——
 *    不是假设的坑，是原型翻车过的地方。这里的三个模式名是 `idle`/`typing`/
 *    `voice`，`bar` 只用来指那颗按钮本身，两者在这一版里从命名上就不会再撞见。
 * 2. `.side.ghost`（隐形占位）在闲置态时和键盘键一样占 46px，「对话」胶囊才会被
 *    两侧对称夹在正中间；没有它，键盘键会把胶囊往左挤偏——这不是猜的，原型上
 *    去掉那个占位试一次就能看出偏了多少。它在语音/打字态被 CSS 藏起来，因为
 *    那两态各自只剩一侧的配对按钮，不再需要对称。
 * 3. 这台机器的 `.env.local` 没有配 `DASHSCOPE_API_KEY`，没有语音识别在跑。所以
 *    点「对话」进入的语音态只是把球和「听/想/说」三态动画的样子跑起来，绝不会
 *    自己编一段对话——原型的 `SCRIPTS` 就是那么干的（按固定毫秒数播一段编好的
 *    问答），这里特意没有搬：一个自己演戏的球比没有语音更糟，因为它看起来在
 *    工作，实际在撒谎。
 */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import styles from "./panel.module.css";

type Mode = "idle" | "typing" | "voice";
type VoiceState = "idle" | "listening" | "thinking" | "speaking";
type Caption = { text: string; from: "user" | "agent" } | null;

/*
 * 「听/想/说」三态的文案。`listening` 这一句是全组件最容易写错的地方：原型写的是
 * 「在听 · 点球结束」，照搬过来就是一句谎——球在转，但没有任何东西在监听麦克风。
 * 这里如实说明白，用户看一眼就知道这颗球此刻只是个开关，不是一只耳朵。
 */
const VOICE_LABEL: Record<VoiceState, string> = {
  idle: "",
  listening: "未接入语音识别 · 点球结束",
  thinking: "在想",
  speaking: "在说",
};

// 原型里一轮播报占 1900ms；这一版还没接 TTS，只借这段时长让「回复刚到」有起有落，
// 不能让一条已经到达的回复把球永远锁在「在说」。
const SPEAKING_MS = 1900;

export function PanelDock({
  caption,
  busy,
  onSubmit,
  onOpenTranscript,
}: {
  /** 球上方那一句。`null` = 不显示。 */
  caption: Caption;
  /** 它在想／在说。球用这个进 thinking 态，输入框此时不禁用。 */
  busy: boolean;
  /** 文字提交。G 组接 /api/chat。 */
  onSubmit: (text: string) => void;
  onOpenTranscript: () => void;
}) {
  const [mode, setMode] = useState<Mode>("idle");
  const [inputValue, setInputValue] = useState("");
  // 播报（朗读回复）开关。这台机器同样没有接语音合成，所以它此刻只记一个偏好、
  // 不产生任何声音——先把开关和它的无障碍状态做对，等接上朗读引擎那天，这个
  // 布尔值就是它的开关，不用回头再补一次 UI。
  const [playbackOn, setPlaybackOn] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  /*
   * 球已经处理到哪一句——进入语音态时先记下旧话，新回复到达并展示 1900ms 后再把
   * 记录推进到它。判断「正在说」不能直接看
   * `caption?.from === "agent"`。原来就是这么写的，后果是：打字态问一句、拿到回复、
   * 收起输入框、再点「对话」进语音态，`caption` 还停在上一轮的回复上，一进来就被判成
   * 「正在说」，而没有任何东西在说话——`caption` 没有人会在事后把它清空，这一态因此
   * 永远出不去。只在进场时记一次仍然不够：回复真在球开着时到达，也会和那份旧记录
   * 永久不同。记录必须在这一轮展示完之后往前走，下一帧才能回到 listening。
   *
   * 用 state 而不是 ref：这份记录要参与算 `voiceState`，也就是**渲染期间要读它**，
   * 而新版 react-hooks 的 `refs` 规则不许在渲染里读 `ref.current`（并发渲染下渲染
   * 函数可能被跑不止一遍）。
   */
  const [handledCaption, setHandledCaption] = useState<Caption>(null);

  // 进入打字态时把焦点带过去。原型用 `setTimeout(…, 50)`，这里换成
  // `requestAnimationFrame`：输入框刚从不可见切到可见，紧接着 `focus()` 在部分
  // 浏览器里不生效，让一帧布局先跑完就够，不需要猜一个具体的毫秒数。
  useEffect(() => {
    if (mode !== "typing") return;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  /*
   * 新回复只让球说一轮，然后把它记成已经展示过。即使关了播报也照样推进这份记录：
   * 否则关着开关收到的旧回复，会在以后重新打开播报时突然被当成一条新回复再说一次。
   */
  useEffect(() => {
    if (mode !== "voice" || busy || !caption || caption === handledCaption || caption.from !== "agent") return;
    const timer = setTimeout(() => setHandledCaption(caption), SPEAKING_MS);
    return () => clearTimeout(timer);
  }, [busy, caption, handledCaption, mode]);

  /*
   * 「听/想/说」不是自己维护的计时器，而是从外部两个信号直接算出来的：
   * `busy`（G 组在等 /api/chat 的回复）→ thinking；语音态开始之后新到的一句回复
   * （`caption` 与已经展示完的那一份不再是同一个引用，且 `from==="agent"`）→ speaking；
   * 两者都不成立 → listening（球在，等他开口，但没有真的在听）。原型的 `SCRIPTS`
   * 是反过来——先编好一段对话，再按固定的毫秒数把这三态播一遍。播的是假对话；这里
   * 推的是真信号，没有信号就停在 listening，不会比真实进度快，也不会比它慢。
   *
   * 只比「是不是 agent 说的」不够——`caption` 是打字态、语音态共用的同一个状态，
   * 上一轮打字问答留下的 agent 回复会一直挂在那里，不会有人事后把它清空。所以这里
   * 还要求这句话是**这次进语音态之后**才出现、且尚未展示完的（`caption !== handledCaption`），
   * 不然每次重新进入语音态都会先被上一轮的旧话判成「正在说」，而没有任何东西在说话，
   * 且这一态再也出不去。`playbackOn` 为 false 时不画 speaking，但上面的 effect 仍会
   * 把这句记成处理过，避免重新开播报后补演一轮旧回复。
   */
  const voiceState: VoiceState =
    mode !== "voice"
      ? "idle"
      : busy
        ? "thinking"
        : playbackOn && caption && caption !== handledCaption && caption.from === "agent"
          ? "speaking"
          : "listening";

  function collapseToIdle() {
    setMode("idle");
    setInputValue("");
  }

  function submit(raw: string) {
    const text = raw.trim();
    if (!text) return;
    onSubmit(text);
    collapseToIdle();
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      submit(inputValue);
    } else if (event.key === "Escape") {
      collapseToIdle();
    }
  }

  function handleInputBlur() {
    // 照原型：给「发送」按钮的点击留一点时间——它自己的 `onMouseDown` 已经
    // `preventDefault`，这里的延时是双保险，避免 blur 抢在 click 前面把输入框
    // 收走，导致点「发送」点了个寂寞。
    window.setTimeout(() => {
      setMode((current) => (current === "typing" && inputValue.trim() === "" ? "idle" : current));
    }, 150);
  }

  function handleDockKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Esc 在打字态收起输入框、在语音态挂断——两种情况这里都是把 mode 收回
    // idle，所以合在一处判断。输入框自己的 Esc 已经在 `handleInputKeyDown` 里
    // 处理过一次，冒泡到这儿再判一次不会出错（两处做的是同一件事）。
    // 键盘态下 Enter/Space 激活按钮是真 `<button>` 自带的行为，不需要像原型
    // 那样给 `div[role="button"]` 手写一段 keydown 去补——这也是这里没有照搬
    // 原型那段 `bar.addEventListener('keydown', …)` 的原因。
    if (event.key === "Escape" && mode !== "idle") {
      collapseToIdle();
    }
  }

  return (
    <div
      className={styles.dock}
      data-dock={mode}
      data-v={voiceState}
      // 请求还在飞、但 dock 已经不在语音态时给「对话」胶囊补一点呼吸感（`panel.module.css`
      // 里的对应规则），否则闲置/打字两态提交之后完全静止——见本文件改动的说明。
      data-busy={busy}
      onKeyDown={handleDockKeyDown}
    >
      {/*
       * 气泡常驻在 DOM 里，靠 `show` 类切进出场，不是靠有没有 caption 来整个
       * 挂载/卸载——`panel.module.css` 里 `.caption` 到 `.caption.show` 是一段
       * opacity/位移的过渡，换成条件渲染的话气泡每次出现都会直接跳出来，没有
       * 淡入。隐藏时它仍然是可 Tab 到的空按钮：这比照搬原型再叠一层
       * `aria-hidden` 去手动摘掉焦点更简单，而且没有真的坏处——没有 caption 时
       * 点它是个空操作，不会把用户带去一个「什么都没有」的地方。
       */}
      <button
        type="button"
        className={[styles.caption, caption ? styles.show : "", caption?.from === "user" ? styles.user : ""]
          .filter(Boolean)
          .join(" ")}
        aria-label="展开完整对话记录"
        onClick={() => {
          if (caption) onOpenTranscript();
        }}
      >
        {caption?.text ?? ""}
      </button>

      <div className={styles.barRow}>
        {/* 隐形占位——见文件头注释第 2 条。它不是控件，纯装饰用的空间，所以是
            `<span>` 不是 `<button>`，且对读屏用户 `aria-hidden`。 */}
        <span className={`${styles.side} ${styles.ghost}`} aria-hidden="true" />

        {/* 播报开关只在语音态可见（由 `panel.module.css` 按 `data-dock` 控制
            display），这里始终渲染它，不在 JS 里再判一次要不要出现。 */}
        <button
          type="button"
          className={`${styles.side} ${styles.spk} ${playbackOn ? "" : styles.off}`}
          title="播报开/关"
          aria-label={playbackOn ? "关闭朗读回复" : "开启朗读回复"}
          aria-pressed={playbackOn}
          onClick={() => setPlaybackOn((value) => !value)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 5L6 9H3v6h3l5 4z" fill="#fff" />
            <path d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13" />
          </svg>
        </button>

        {/*
         * 这一格从头到尾都是这一个 `<div>`，三态只换它里面谁可见——**不要再按模式
         * 把它换成 `<button>`**，那正是「展开动画没了」这个 bug 的成因（文件头注释
         * 第 0 条把来龙去脉写全了）。它自己不接点击、也不是可聚焦元素，真正可点的
         * 是下面那颗铺满它的 `.barMain`，所以可交互元素依然没有嵌套：输入框、
         * 发送键和 `.barMain` 是平级的三兄弟，靠 CSS 的 `display` 决定这一态露谁。
         */}
        <div className={styles.bar}>
          {/*
           * 闲置/语音两态那颗可点的胶囊。它在 CSS 里绝对定位铺满外层，所以外层
           * 的宽高怎么变它都跟着变，而它自己进出 DOM 不影响外层那段过渡。
           */}
          <button
            type="button"
            className={styles.barMain}
            aria-pressed={mode === "voice"}
            aria-label="语音对话"
            onClick={() => {
              const next = mode === "voice" ? "idle" : "voice";
              // 每次真正进入语音态，先把这一刻的 caption 记成已经处理过的旧话——
              // 见上面 voiceState 那段注释，没有这一步，旧的 agent 回复会被立刻
              // 误判成「正在说」。两次 setState 在同一个事件里会被合批，不会多渲一轮。
              if (next === "voice") setHandledCaption(caption);
              setMode(next);
            }}
          >
            <span className={styles.barVoice} aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round">
                <path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4" />
              </svg>
            </span>
            <span className={styles.barText}>对话</span>
          </button>

          {/*
           * 输入框和发送键一直挂在 DOM 里，闲置/语音两态由 CSS 收成 `display:none`
           * （`display:none` 的元素不在 Tab 序列里，不用再手动 `tabIndex={-1}`）。
           * 不按模式条件渲染它们，是因为那样每次进打字态都会新挂一个 `<input>`：
           * 除了白搭一次挂载，聚焦也得等新节点上屏，而现在它一直在，
           * `requestAnimationFrame` 里那次 `focus()` 拿到的就是同一个稳定的节点。
           */}
          <input
            ref={inputRef}
            className={styles.barInput}
            placeholder="输入后回车 · Esc 取消"
            aria-label="输入文字，回车发送"
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            onKeyDown={handleInputKeyDown}
            onBlur={handleInputBlur}
          />
          <button
            type="button"
            className={styles.barSend}
            title="发送"
            aria-label="发送"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => submit(inputValue)}
          >
            ↑
          </button>

          {mode === "voice" ? (
            // TODO(ASR): 接上真实语音识别引擎后，识别到一整句时应该在这里调用
            // `onSubmit(text)`——和上面打字态里 Enter 提交走的是同一条路。
            // 在那之前，这颗球只跑「听/想/说」三态的动画，绝不会自己造一句话
            // 出来冒充用户或它自己说过什么（文件头注释第 3 条）。
            //
            // 只在语音态挂它，是因为它的 `::before` 是一圈 5 秒无限旋转的锥形渐变
            // 加 12px 模糊：常驻 DOM 的话，这一整帧的合成开销在没人看球的时候
            // 也一直在付。它是 `.bar` 的最后一个子节点，绝对定位铺满，因此盖在
            // 上面那颗 `.barMain` 之上——CSS 里它是 `pointer-events:none`，
            // 点击照样穿过去落在按钮上，球才点得动。
            <div className={styles.orbCore} aria-hidden="true" />
          ) : null}
        </div>

        {/*
         * 键盘键上叠了两个 svg（键盘图标、× 图标），两个都要一直渲染，靠
         * `panel.module.css` 按 `data-dock` 切 display 来决定哪个可见——这是
         * `panel.module.css` 里 `.side.kbd .icX` 那段注释点名要求的写法：两个
         * 图标形状差得远，在组件里按状态整个换掉反而更绕。
         */}
        <button
          type="button"
          className={`${styles.side} ${styles.kbd}`}
          title={mode === "typing" ? "收起输入框" : "改用文字"}
          aria-label={mode === "typing" ? "收起输入框" : "改用文字输入"}
          onClick={() => setMode((current) => (current === "typing" ? "idle" : "typing"))}
        >
          <svg
            className={styles.icKbd}
            viewBox="0 0 24 24"
            fill="none"
            stroke="#fff"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x={2.5} y={6} width={19} height={12} rx={2.5} />
            <path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 14h.01M9 14h6M16.5 14h.01" />
          </svg>
          <svg className={styles.icX} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      {/*
       * 「听/想/说」的变化只有球在转，没有声音提示——这个区域是唯一让读屏用户
       * 知道「它此刻处于哪一态」的地方。`aria-live="polite"` 保证文字一变就播报，
       * 且不会打断他正在做的别的事；`aria-atomic` 保证每次都播报完整的一句，
       * 不是只念变化的那几个字。
       *
       * 闲置/打字两态提交之后没有语音那一套三态可念，但请求同样在飞——`opacity:0`
       * 只是视觉上藏起来（`panel.module.css` 只在语音态给它透明度），`aria-live`
       * 照样会播报，所以这里补一句「正在处理」，不然读屏用户和看得见球的人一样,
       * 提交之后什么反馈都收不到。
       */}
      <div className={styles.vLabel} aria-live="polite" aria-atomic="true">
        {mode !== "voice" && busy ? "正在处理" : VOICE_LABEL[voiceState]}
      </div>
    </div>
  );
}
