// ColaMD：把 Linux 上那条原生菜单栏默认收起（它由主进程绘制，CSS 主题够不着）。
// 连的是**主进程**的 Node inspector（启动器里的 --inspect=9229），不是渲染层的 CDP 端口。
// 菜单项没被删，按 Alt 仍会浮出来。
const PORT = 9229;
const started = Date.now();

const PATCH = `
(() => {
  const req = process.mainModule && process.mainModule.require
    ? process.mainModule.require.bind(process.mainModule)
    : require;
  const electron = req("electron");

  const apply = () => {
    for (const win of electron.BrowserWindow.getAllWindows()) {
      win.setAutoHideMenuBar(true);
      win.setMenuBarVisibility(false);
    }
  };

  if (!globalThis.__colamdMenuBarPatched) {
    globalThis.__colamdMenuBarPatched = true;
    // 之后新建的窗口（本 App 只有主窗口，但别赌）
    electron.app.on("browser-window-created", apply);
    // 切主题会重建菜单（Menu.setApplicationMenu），菜单栏可能跟着重新露出来
    const original = electron.Menu.setApplicationMenu.bind(electron.Menu);
    electron.Menu.setApplicationMenu = (menu) => {
      original(menu);
      apply();
    };
  }
  apply();
  return JSON.stringify({
    windows: electron.BrowserWindow.getAllWindows().length,
    menuBarVisible: electron.BrowserWindow.getAllWindows()[0]?.isMenuBarVisible() ?? null
  });
})();
`;

const list = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  } catch {
    return [];
  }
};

let target = null;
for (let i = 0; i < 300 && !target; i++) {
  const targets = await list();
  target = targets.find(t => t.type === "node") ?? targets[0];
  if (!target) await new Promise(r => setTimeout(r, 100));
}
if (!target) {
  console.error("main-inject: no inspector target found");
  process.exit(1);
}

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
ws.onerror = () => process.exit(1);
await new Promise(r => ws.onopen = r);
await send("Runtime.enable");
// 连上不等于能用：主进程刚起来时默认执行上下文还是 Electron 自己的 bootstrap
// （process.mainModule 尚未存在、require 也不可见），此时求值必然 ReferenceError。
// 重试到 App 的 bundle 加载完为止——早一点落地，菜单栏就少露一帧。
let res = null;
for (let i = 0; i < 200; i++) {
  res = await send("Runtime.evaluate", { expression: PATCH, returnByValue: true, awaitPromise: true });
  if (res && !res.exceptionDetails) break;
  await new Promise(r => setTimeout(r, 30));
}
const value = res?.result?.value;
console.log("main-inject:", JSON.stringify({
  ...(typeof value === "string" ? JSON.parse(value) : value ?? res),
  tookMs: Date.now() - started
}));
ws.close();
