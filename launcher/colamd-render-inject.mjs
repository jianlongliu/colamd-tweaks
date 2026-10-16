// ColaMD renderer-side patches, injected over the app's CDP port (the wrapper
// starts the app with --remote-debugging-port=9222).
//
// One script owns this connection on purpose: the DevTools protocol hands a page
// target to a single debugger client, so two scripts would race for it.
//
// 1. Tab inside a code block inserts a real tab instead of moving focus.
// 2. Temporary workaround for an upstream bug in buildDecorations() — it sorts
//    its decorations by (from, to) only, while CodeMirror's RangeSetBuilder also
//    requires equal-`from` ranges to come in startSide order (line decorations
//    -2e8, inline marks -1, widgets 0). When two decorations of different kinds
//    share a `from`, EditorState throws "Ranges must be added sorted by `from`
//    position and `startSide`", that transaction is dropped, and the file never
//    renders (the editor keeps showing the "Welcome to ColaMD" placeholder).
//    See README for the reproduction and how to drop this patch.
// 3. An "open file" button next to the tab bar's "+". The app only offers
//    File ▸ Open / Cmd-O, and this is the spot you reach for. React owns
//    #titlebar, so a MutationObserver re-inserts the button if a re-render
//    drops it.
// 4. Reveal the app's hamburger menu button (#app-menu-btn): upstream hides it
//    everywhere except Windows because other platforms get the native menu bar,
//    and we hide that bar in the main process.
const PORT = 9222;

const INJECT = `
(() => {
  const patchDecorationSort = () => {
    if (window.__cmSortPatched) return "already";
    const nativeSort = Array.prototype.sort;
    Array.prototype.sort = function (cmp) {
      const res = nativeSort.call(this, cmp);
      try {
        const first = this[0];
        if (this.length > 1 && first && first.deco && typeof first.deco.startSide === "number" && typeof first.from === "number") {
          nativeSort.call(this, (a, b) => a.from - b.from || a.deco.startSide - b.deco.startSide || a.to - b.to);
        }
      } catch {}
      return res;
    };
    window.__cmSortPatched = true;
    return "patched";
  };
  const decorSort = patchDecorationSort();

  if (window.__tabIndentHandler) document.removeEventListener("keydown", window.__tabIndentHandler, true);
  const handler = (e) => {
    if (e.key !== "Tab" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const node = sel.anchorNode;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el) return;
    if (el.closest("li, td, th")) return;
    const scope = el.closest("#editor, #source-editor");
    if (!scope) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (scope.id === "editor") document.execCommand("insertText", false, "\\t");
  };
  window.__tabIndentHandler = handler;
  window.__tabIndentInstalled = true;
  document.addEventListener("keydown", handler, true);

  const installOpenButton = () => {
    if (document.getElementById("colamd-open-btn")) return "present";
    const plus = document.querySelector("#titlebar > .tab-new-btn");
    if (!plus) return "no-anchor";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "colamd-open-btn";
    btn.className = plus.className;
    btn.title = "Open file";
    btn.setAttribute("aria-label", "Open file");
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>';
    btn.addEventListener("click", () => window.electronAPI.openFile());
    plus.after(btn);
    return "installed";
  };
  const openBtn = installOpenButton();
  if (!window.__colamdOpenBtnObserver) {
    const bar = document.getElementById("titlebar");
    if (bar) {
      const obs = new MutationObserver(() => installOpenButton());
      obs.observe(bar, { childList: true });
      window.__colamdOpenBtnObserver = obs;
    }
  }

  // 4. The shell hides the native menu bar (colamd-main-inject.mjs), so reveal
  //    the app's own hamburger button. Upstream only unhides it on Windows,
  //    where there is no native menu bar to fall back on; elsewhere it stays
  //    hidden. Its click handler (popupAppMenu -> Menu.popup) ships with the app.
  const menuBtn = document.getElementById("app-menu-btn");
  const menuBtnState = !menuBtn ? "missing" : menuBtn.hasAttribute("hidden") ? (menuBtn.removeAttribute("hidden"), "revealed") : "already";

  return "installed (decor-sort: " + decorSort + ", open-btn: " + openBtn + ", menu-btn: " + menuBtnState + ")";
})();
`;

const list = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  } catch {
    return [];
  }
};

let page = null;
for (let i = 0; i < 60 && !page; i++) {
  page = (await list()).find(t => t.type === "page" && /renderer\/index/.test(t.url));
  if (!page) await new Promise(r => setTimeout(r, 500));
}
if (!page) {
  console.error("render-inject: no page target found");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise(res => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); }
};
ws.onerror = () => process.exit(1);
await new Promise(r => ws.onopen = r);
const res = await send("Runtime.evaluate", { expression: INJECT, returnByValue: true });
console.log("render-inject:", JSON.stringify(res?.result?.value ?? res));
ws.close();
