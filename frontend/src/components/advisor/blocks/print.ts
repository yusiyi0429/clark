/**
 * 把一块 DOM 交给浏览器的打印 →「另存为 PDF」。
 *
 * ## 为什么不引 PDF 库
 *
 * 浏览器自己出的 PDF 是**文字**：能选、能搜、能复制。前端那几个 PDF 库（jsPDF +
 * html2canvas 那一路）是把屏幕截成位图再塞进去 —— 一份三十页的研报变成三十张图。
 * 为一颗按钮引一个把正文变成图片的依赖，是拿这份报告最重要的属性去换一个更短的实现。
 * 整段权衡写在 `globals.css` 的打印那一节上。
 *
 * ## 为什么要克隆
 *
 * 这份报告住在一层层滚动容器里。直接 `window.print()` 的话 `overflow` 祖先会把超出
 * 一屏的部分**裁掉**，打出来只有第一屏 —— 而且看不出少了东西。克隆到 `<body>` 底下
 * 就没有裁剪祖先了。原来那一块一个字没动。
 *
 * ## 文件名
 *
 * 浏览器拿 `document.title` 当默认文件名。不改的话存出来叫「TKOS」，一个文件夹里
 * 十份报告十个同名文件。打完再改回去 —— 改不回去的话，标签页标题就停在报告标题上了。
 */
export function printElement(node: HTMLElement, title: string): void {
  if (typeof document === "undefined") return;

  document.getElementById("print-root")?.remove();

  const host = document.createElement("div");
  host.id = "print-root";
  const clone = node.cloneNode(true) as HTMLElement;
  /*
   * 折起来的一律展开。纸上没有「点开」这个动作 —— 一份印出来的报告里，
   * 一行写着「有 3 行没读通」而底下什么都没有，比不印那一行更糟。
   */
  clone.querySelectorAll("details").forEach((d) => d.setAttribute("open", ""));
  host.appendChild(clone);
  document.body.appendChild(host);

  const restore = document.title;
  document.title = title;

  /*
   * 收尾挂在 `afterprint` 上，并且**只收一次**。
   *
   * 有的浏览器不发这个事件（发不发由它决定，不由我们）。那时 `#print-root` 会留在
   * DOM 里 —— 无害：它平时是 `display: none`，而下一次按这颗键第一件事就是把它删掉。
   * 标题在那种情况下也留着，所以下面还挂了一道超时兜底。
   */
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    host.remove();
    document.title = restore;
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  // 兜底：60 秒后无论如何把标题和那块克隆收掉。打印对话框开着不影响它 ——
  // 那时打印内容已经交给浏览器了，删掉源节点不会改变正在打的那一份。
  window.setTimeout(cleanup, 60_000);

  window.print();
}
