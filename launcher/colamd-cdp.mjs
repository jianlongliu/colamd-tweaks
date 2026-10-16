// Query ColaMD's renderer over its CDP port.
//   node ~/.local/bin/colamd-cdp.mjs '<js expression>'
// Requires the app to be running through the custom wrapper (--remote-debugging-port=9222).
const expr = process.argv[2] ?? 'document.title';
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page' && /renderer\/index/.test(t.url));
if (!page) {
  console.error('no ColaMD page target — app not running with the CDP port?');
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
const timer = setTimeout(() => { console.error('timeout'); process.exit(1); }, 8000);
ws.onopen = () => ws.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: { expression: expr, returnByValue: true, awaitPromise: true }
}));
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id !== 1) return;
  clearTimeout(timer);
  if (m.result?.exceptionDetails) console.error('ERR:', m.result.exceptionDetails.exception?.description ?? 'exception');
  else console.log(JSON.stringify(m.result?.result?.value));
  process.exit(0);
};
ws.onerror = () => { console.error('websocket error'); process.exit(1); };
