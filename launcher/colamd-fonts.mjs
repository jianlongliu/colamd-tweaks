const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res) => {
  const myId = ++id;
  pending.set(myId, res);
  ws.send(JSON.stringify({ id: myId, method, params }));
});
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error); pending.delete(m.id); }
};
await new Promise(r => ws.onopen = r);
await send('DOM.enable');
await send('CSS.enable');
const doc = await send('DOM.getDocument', { depth: 1 });
const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: process.argv[2] || '#editor .ProseMirror p' });
if (!q.nodeId) { console.log('editor node not found'); process.exit(1); }
const fonts = await send('CSS.getPlatformFontsForNode', { nodeId: q.nodeId });
console.log(JSON.stringify(fonts, null, 1));
process.exit(0);
