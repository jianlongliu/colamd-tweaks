// 在主进程里跑任意 JS 表达式（对应渲染层那个 colamd-cdp.mjs）。
// 走 wrapper 里的 --inspect=9229，即 Node inspector，不是 CDP 的页面 target。
// 例：查窗口状态 / 点原生菜单项 / 显隐菜单栏，用法见 colamd-notes.md §3.7、§五。
const PORT = 9229;

const list = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  } catch {
    return [];
  }
};

const target = (await list()).find(t => t.type === "node") ?? (await list())[0];
if (!target) {
  console.error("main: no inspector target on port " + PORT);
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
const res = await send("Runtime.evaluate", {
  expression: process.argv[2] ?? "1",
  returnByValue: true,
  awaitPromise: true
});
if (res?.exceptionDetails) {
  console.error("exception:", JSON.stringify(res.exceptionDetails).slice(0, 500));
  process.exit(1);
}
console.log(typeof res?.result?.value === "string" ? res.result.value : JSON.stringify(res?.result?.value ?? res));
ws.close();
