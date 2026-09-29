// tests/js/test_perfetto_open.js — run with: node tests/js/test_perfetto_open.js
//
// "⏱ Trace" (static/perfetto-open.js): hand a remote run's trace to Perfetto via
// its postMessage protocol. Drives the SHIPPED module with stub windows, a stub
// fetch and a manual clock — no browser.
const assert = require('assert');
const path = require('path');

const P = require(path.join(__dirname, '..', '..', 'vivarium_workbench', 'static', 'perfetto-open.js'));

// A listener registry standing in for the opener window's `message` events.
function bus() {
  const ls = [];
  return {
    addEventListener: (t, f) => { if (t === 'message') ls.push(f); },
    removeEventListener: (t, f) => { const i = ls.indexOf(f); if (i >= 0) ls.splice(i, 1); },
    emit: (ev) => ls.slice().forEach((f) => f(ev)),
    count: () => ls.length,
  };
}

// A manual setInterval: tick() runs every registered callback once.
function clock() {
  const cbs = new Map(); let id = 0; let t = 0;
  return {
    setInterval: (f) => { cbs.set(++id, f); return id; },
    clearInterval: (i) => cbs.delete(i),
    now: () => t,
    advance: (ms) => { t += ms; },
    tick: () => Array.from(cbs.values()).forEach((f) => f()),
    active: () => cbs.size,
  };
}

// A fake Perfetto window: answers PONG to PING only once `loaded`.
function perfettoWindow(b, origin) {
  const w = { closed: false, posted: [], loaded: false };
  w.postMessage = (msg, target) => {
    w.posted.push({ msg, target });
    if (msg === 'PING' && w.loaded) b.emit({ source: w, origin, data: 'PONG' });
  };
  w.close = () => { w.closed = true; };
  return w;
}

async function testViewerUrl() {
  const loc = { origin: 'https://wb.example' };
  assert.strictEqual(P.viewerUrl({ mode: 'bundled', url: '/perfetto/' }, loc), 'https://wb.example/perfetto/');
  assert.strictEqual(P.viewerUrl({ mode: 'external', url: 'https://ui.perfetto.dev/' }, loc), 'https://ui.perfetto.dev/');
  assert.strictEqual(P.viewerUrl({ mode: 'off', url: null }, loc), null);
  assert.strictEqual(P.viewerUrl(undefined, loc), null);
  globalThis.__BASE_PATH__ = '/workbench';
  assert.strictEqual(P.viewerUrl({ mode: 'bundled', url: '/perfetto/' }, loc), 'https://wb.example/workbench/perfetto/');
  delete globalThis.__BASE_PATH__;
}

async function testPingUntilPongThenPost() {
  const b = bus(); const c = clock();
  const origin = 'https://ui.perfetto.dev';
  const w = perfettoWindow(b, origin);
  const buf = new ArrayBuffer(8);
  const p = P.postTrace(w, origin + '/', buf, { title: 'T', fileName: 'f.json', url: 'u' },
    { listenOn: b, setInterval: c.setInterval, clearInterval: c.clearInterval, now: c.now });
  c.tick(); c.tick();                        // not loaded yet: PINGs go unanswered
  assert.deepStrictEqual(w.posted.map((m) => m.msg), ['PING', 'PING']);
  assert.ok(w.posted.every((m) => m.target === origin), 'PING targets the viewer origin, not *');
  w.loaded = true;
  c.tick();                                  // PING -> PONG -> trace posted
  assert.strictEqual(await p, true);
  const last = w.posted[w.posted.length - 1];
  assert.ok(last.msg.perfetto, 'posted the {perfetto: ...} envelope');
  assert.strictEqual(last.msg.perfetto.buffer, buf, 'the ArrayBuffer itself');
  assert.strictEqual(last.msg.perfetto.title, 'T');
  assert.strictEqual(last.msg.perfetto.fileName, 'f.json');
  assert.strictEqual(last.target, origin);
  assert.strictEqual(c.active(), 0, 'stops pinging');
  assert.strictEqual(b.count(), 0, 'removes its listener');
}

async function testIgnoresPongFromElsewhere() {
  const b = bus(); const c = clock();
  const w = perfettoWindow(b, 'https://ui.perfetto.dev');
  const p = P.postTrace(w, 'https://ui.perfetto.dev/', new ArrayBuffer(1), { title: 'T' },
    { listenOn: b, setInterval: c.setInterval, clearInterval: c.clearInterval, now: c.now });
  b.emit({ source: {}, origin: 'https://ui.perfetto.dev', data: 'PONG' });      // another window
  b.emit({ source: w, origin: 'https://evil.example', data: 'PONG' });          // wrong origin
  assert.ok(!w.posted.some((m) => m.msg && m.msg.perfetto), 'no trace sent to a stranger');
  c.advance(61000); c.tick();
  assert.strictEqual(await p, false, 'times out');
}

async function testUnparseableViewerUrlPostsNothing() {
  // Eran's #1214 review: never fall back to '*' -- an unknown origin posts nothing.
  const b = bus(); const c = clock();
  const w = perfettoWindow(b, 'https://ui.perfetto.dev'); w.loaded = true;
  const p = P.postTrace(w, '/perfetto/', new ArrayBuffer(1), { title: 'T' },
    { listenOn: b, setInterval: c.setInterval, clearInterval: c.clearInterval, now: c.now });
  c.tick();
  assert.strictEqual(await p, false, 'gives up at once');
  assert.strictEqual(w.posted.length, 0, 'not even a PING to an unknown origin');
  assert.strictEqual(b.count(), 0, 'no listener left behind');
}

async function testClosedWindowGivesUp() {
  const b = bus(); const c = clock();
  const w = perfettoWindow(b, 'https://ui.perfetto.dev');
  const p = P.postTrace(w, 'https://ui.perfetto.dev/', new ArrayBuffer(1), { title: 'T' },
    { listenOn: b, setInterval: c.setInterval, clearInterval: c.clearInterval, now: c.now });
  w.closed = true; c.tick();
  assert.strictEqual(await p, false);
}

function fetchStub(routes) {
  const seen = [];
  const f = (url) => {
    seen.push(url);
    const r = routes[url.split('?')[0]];
    if (!r) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'nope' }) });
    return Promise.resolve(r(url));
  };
  f.seen = seen;
  return f;
}

async function testOpenTraceBundledEndToEnd() {
  P._reset();
  const b = bus(); const c = clock();
  const loc = { origin: 'https://wb.example' };
  const trace = new TextEncoder().encode('{"traceEvents":[]}').buffer;
  const f = fetchStub({
    '/api/remote-run-trace-support': () => ({ ok: true, json: () => Promise.resolve({
      supported: true, viewer: { mode: 'bundled', url: '/perfetto/', version: 'v58' } }) }),
    '/api/remote-run-trace': () => ({ ok: true, status: 200,
      headers: { get: (h) => (h === 'Content-Disposition' ? 'inline; filename="simulation-42-trace.json"' : null) },
      arrayBuffer: () => Promise.resolve(trace) }),
  });
  let opened = null;
  const w = perfettoWindow(b, loc.origin); w.loaded = true;
  const done = P.openTrace({ simulation_id: 42 }, {
    fetch: f, location: loc,
    open: (url, name) => { opened = { url, name }; return w; },
    env: { listenOn: b, setInterval: c.setInterval, clearInterval: c.clearInterval, now: c.now },
  });
  // let the fetches resolve, then tick the PING loop
  for (let i = 0; i < 20 && c.active() === 0; i++) await new Promise((r) => setImmediate(r));
  c.tick();
  assert.strictEqual(await done, 'opened');
  assert.deepStrictEqual(opened, { url: 'https://wb.example/perfetto/', name: '_blank' });
  assert.ok(f.seen.includes('/api/remote-run-trace?simulation_id=42'));
  const post = w.posted.find((m) => m.msg && m.msg.perfetto);
  assert.strictEqual(post.msg.perfetto.buffer, trace);
  assert.strictEqual(post.msg.perfetto.fileName, 'simulation-42-trace.json');
  assert.strictEqual(post.msg.perfetto.url, 'https://wb.example/api/remote-run-trace?simulation_id=42');
  assert.strictEqual(post.target, 'https://wb.example');
}

async function testOpenTraceErrorClosesWindow() {
  P._reset();
  const toasts = [];
  globalThis._showToast = (m) => toasts.push(m);
  const f = fetchStub({
    '/api/remote-run-trace-support': () => ({ ok: true, json: () => Promise.resolve({
      supported: true, viewer: { mode: 'external', url: 'https://ui.perfetto.dev/' } }) }),
    '/api/remote-run-trace': () => ({ ok: false, status: 409,
      json: () => Promise.resolve({ error: 'does not support: viva-v1-trace' }) }),
  });
  const w = { closed: false, close() { this.closed = true; }, postMessage() {} };
  const res = await P.openTrace({ simulation_id: 5 }, { fetch: f, location: { origin: 'x' }, open: () => w });
  assert.strictEqual(res, 'error');
  assert.ok(w.closed, 'the empty Perfetto window is closed again');
  assert.ok(/viva-v1-trace/.test(toasts[0]), 'the server error is shown');
  delete globalThis._showToast;
}

async function testSnapshotNeverAsks() {
  P._reset();
  globalThis.__DASH_CONFIG__ = { mode: 'snapshot' };
  const f = fetchStub({});
  const s = await P.support(f);
  assert.strictEqual(s.supported, false);
  assert.strictEqual(f.seen.length, 0, 'no request in the static snapshot');
  delete globalThis.__DASH_CONFIG__;
  P._reset();
}

(async () => {
  for (const t of [testViewerUrl, testPingUntilPongThenPost, testIgnoresPongFromElsewhere,
    testClosedWindowGivesUp, testUnparseableViewerUrlPostsNothing, testOpenTraceBundledEndToEnd, testOpenTraceErrorClosesWindow,
    testSnapshotNeverAsks]) {
    await t();
    console.log('ok -', t.name);
  }
})().catch((e) => { console.error(e); process.exit(1); });
