// ColaMD renderer-side patches, injected over the app's CDP port (the wrapper
// starts the app with --remote-debugging-port=9222).
//
// One script owns this connection on purpose: the DevTools protocol hands a page
// target to a single debugger client, so two scripts would race for it. It also
// stays resident: ColaMD opens one window per document plus a "Untitled" one, so
// patching only the first target leaves the window the user is actually reading
// unpatched. This script therefore attaches to every page target as it appears
// and re-attaches if a target goes away (reload, new window).
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

// Every window ColaMD opens is its own page target, and the app opens one per
// document (plus a blank one), so a single shot at the first target is not
// enough. Attach to all of them, keep polling for ones that show up later, and
// re-run INJECT on every tick: it is idempotent (each step reports "already" /
// "present"), which covers the two timing traps below.
//
//   - A target can exist before #titlebar does, in which case the open-file
//     button finds no anchor and would never be retried.
//   - A page reload hands us a fresh document whose window globals are gone.
//
// The decoration-sort patch only has to be in place before the first document
// transaction, which is the earliest tick after the target appears.
const attached = new Map(); // target id -> { ws, inject }

const connect = async (target) => {
  const key = target.id ?? target.webSocketDebuggerUrl;
  if (attached.has(key)) return;
  attached.set(key, null); // reserve before the await so the poll cannot double-attach

  const ws = new WebSocket(target.webSocketDebuggerUrl);
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

  // The handshake can fail outright (target vanished between list() and connect),
  // and a reserved-but-never-connected key would block every later attempt.
  const closed = new Promise((_, rej) => {
    ws.onerror = () => rej(new Error("websocket error"));
    ws.onclose = () => { attached.delete(key); rej(new Error("websocket closed")); };
  });
  try {
    await Promise.race([new Promise(r => ws.onopen = r), closed]);
  } catch (e) {
    attached.delete(key);
    ws.close();
    throw e;
  }
  // Connected: swap the handshake handlers for ones that just free the slot,
  // so a later close (window closed, or reload) lets the next tick re-attach.
  ws.onerror = () => {};
  ws.onclose = () => attached.delete(key);
  attached.set(key, { ws, send });
};

const injectInto = async (entry, target) => {
  const res = await entry.send("Runtime.evaluate", { expression: INJECT, returnByValue: true });
  return { value: res?.result?.value ?? res, title: target.title ?? target.id };
};

const isPage = t => t.type === "page" && /renderer\/index/.test(t.url);

const tick = async (report) => {
  const pages = (await list()).filter(isPage);
  for (const t of pages) {
    try {
      await connect(t);
      const entry = attached.get(t.id ?? t.webSocketDebuggerUrl);
      if (!entry) continue;
      const { value, title } = await injectInto(entry, t);
      if (report) console.log(`render-inject: ${title}:`, JSON.stringify(value));
    } catch {}
  }
  return pages.length;
};

// First target has to appear before anything can be injected; give it a while.
let ok = false;
for (let i = 0; i < 60 && !ok; i++) {
  ok = (await tick(true)) > 0;
  if (!ok) await new Promise(r => setTimeout(r, 500));
}
if (!ok) {
  console.error("render-inject: no page target found");
  process.exit(1);
}

// Keep watching: new documents open new windows (= new page targets) at any time,
// a reload swaps the target out from under the websocket, and a target can exist
// before #titlebar does. Re-running the (idempotent) patch on every tick covers
// all three.
//
// Lifetime: the wrapper passes the app's PID, and we exit with it. The port going
// quiet is only a fallback — if the app is already running when a second wrapper
// starts us, we would attach to *that* app's port and the quiet test would never
// fire, leaving this process behind forever.
const appPid = Number(process.argv[2]) || 0;
const appAlive = () => {
  if (!appPid) return true;
  try { process.kill(appPid, 0); return true; } catch { return false; }
};

let idle = 0;
setInterval(async () => {
  if (!appAlive()) process.exit(0);
  const count = await tick(false);
  if (count === 0 && ++idle >= 30) process.exit(0);
  if (count > 0) idle = 0;
}, 1000);
