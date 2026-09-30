const SELECTION_SCRIPT = `<script>
(() => {
  const plain = (range) => {
    const fragment = range.cloneContents();
    fragment.querySelectorAll('script,style').forEach((node) => node.remove());
    return fragment.textContent || '';
  };
  const clear = () => parent.postMessage({ type: 'tianshu-material-selection', text: '' }, '*');
  document.addEventListener('mouseup', () => {
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount || !selection.toString().trim()) { clear(); return; }
    const range = selection.getRangeAt(0);
    const before = document.createRange(), after = document.createRange();
    before.selectNodeContents(document.body);
    before.setEnd(range.startContainer, range.startOffset);
    after.selectNodeContents(document.body);
    after.setStart(range.endContainer, range.endOffset);
    const rect = range.getBoundingClientRect();
    parent.postMessage({ type: 'tianshu-material-selection', text: selection.toString(),
      prefix: plain(before).slice(-200), suffix: plain(after).slice(0, 200),
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height } }, '*');
  });
  document.addEventListener('selectionchange', () => {
    if (!window.getSelection()?.toString().trim()) clear();
  });
})();
</script>`;

export function injectMaterialSelection(body: string): string {
  return /<\/body\s*>/i.test(body) ? body.replace(/<\/body\s*>/i, (closing) => SELECTION_SCRIPT + closing) : body + SELECTION_SCRIPT;
}
