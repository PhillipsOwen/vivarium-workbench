// perfetto-open.js — "⏱ Trace": open a remote run's trace in Perfetto.
//
// The workbench backend proxies the trace from viva-api (GET
// /api/remote-run-trace?simulation_id=N — Chrome Trace Event JSON, gated on the
// deployment advertising `viva-v1-trace`); this file hands those bytes to the
// Perfetto UI in a new window using Perfetto's documented postMessage protocol:
// open the UI, send "PING" until it answers "PONG" (it only answers once loaded),
// then post {perfetto: {buffer: ArrayBuffer, title, fileName, url}}. The trace is
// parsed by Perfetto's in-page WebAssembly and never leaves the browser.
//
// Which Perfetto (GET /api/remote-run-trace-support → viewer):
//   bundled  — the pinned copy this server serves at <base>/perfetto/ (same
//              origin: no outside network, no "Open trace?" prompt)
//   external — an absolute URL, normally https://ui.perfetto.dev (asks once
//              per origin whether to trust the workbench)
//   off      — no viewer: the action downloads the trace JSON instead.
//
// The action is hidden until the support check says `supported` — a deployment
// without the capability, an unreachable viva-api, and the static snapshot
// (no backend) all leave it hidden. Exposed as window.VivaPerfetto; also
// module.exports for tests/js/test_perfetto_open.js.
(function (global) {
  'use strict';

  var PING_INTERVAL_MS = 250;
  var PING_TIMEOUT_MS = 60000;   // Perfetto's first load pulls ~30 MB of wasm/js
  var HIDE_STYLE_ID = 'viva-trace-hide';
  var _support = null;           // cached Promise of the support body
  var _supportValue = null;      // ...and its value once resolved (sync access)

  function _bp() { return (global.__BASE_PATH__ || ''); }

  // Hide every trace action until support is confirmed. A <style> rather than
  // per-element toggling: rows are re-rendered all the time (polling, filters),
  // and each re-render must come out already in the right state.
  function _installHideStyle(doc) {
    if (!doc || !doc.head || doc.getElementById(HIDE_STYLE_ID)) return;
    var st = doc.createElement('style');
    st.id = HIDE_STYLE_ID;
    st.textContent = '.viva-trace-action{display:none !important}';
    doc.head.appendChild(st);
  }

  function _revealActions(doc) {
    var st = doc && doc.getElementById(HIDE_STYLE_ID);
    if (st && st.parentNode) st.parentNode.removeChild(st);
  }

  function support(fetchImpl) {
    if (_support) return _support;
    var f = fetchImpl || global.fetch;
    var snapshot = ((global.__DASH_CONFIG__ || {}).mode === 'snapshot');
    if (snapshot || typeof f !== 'function') {
      _support = Promise.resolve({ supported: false, reason: 'no-backend' });
      return _support;
    }
    _support = f(_bp() + '/api/remote-run-trace-support')
      .then(function (r) { return r.ok ? r.json() : { supported: false, reason: 'http-' + r.status }; })
      .catch(function (err) { return { supported: false, reason: String(err) }; })
      .then(function (body) { _supportValue = body; return body; });
    return _support;
  }

  // The absolute Perfetto URL to open for a support body's `viewer`, or null.
  function viewerUrl(viewer, loc) {
    if (!viewer || !viewer.url || viewer.mode === 'off') return null;
    if (viewer.mode === 'bundled') {
      var origin = (loc && loc.origin) || '';
      return origin + _bp() + viewer.url;          // viewer.url = "/perfetto/"
    }
    return viewer.url;
  }

  // The origin trace bytes may be posted to, or null. Never '*': an unparseable viewer URL
  // must stop the post, not broadcast the trace to whatever origin that window holds.
  function _originOf(url) {
    try {
      var o = new URL(url).origin;
      return (o && o !== 'null') ? o : null;
    } catch (e) { return null; }
  }

  // PING `win` until it answers PONG, then post the trace. Resolves true once
  // posted, false on timeout / a closed window. `win` must be the window WE
  // opened: Perfetto only honours messages from its opener.
  function postTrace(win, targetUrl, buffer, meta, env) {
    env = env || {};
    var listenOn = env.listenOn || global;
    var setI = env.setInterval || global.setInterval;
    var clearI = env.clearInterval || global.clearInterval;
    var now = env.now || function () { return Date.now(); };
    var target = _originOf(targetUrl);
    if (!target) return Promise.resolve(false);   // no known origin -> post nothing
    return new Promise(function (resolve) {
      var started = now();
      var timer = null;
      function done(ok) {
        if (timer !== null) clearI(timer);
        timer = null;
        listenOn.removeEventListener('message', onMsg);
        resolve(ok);
      }
      function onMsg(ev) {
        if (ev.source !== win || ev.data !== 'PONG') return;
        if (ev.origin !== target) return;
        win.postMessage({ perfetto: {
          buffer: buffer,
          title: meta.title,
          fileName: meta.fileName,
          url: meta.url,
        } }, target);
        done(true);
      }
      listenOn.addEventListener('message', onMsg);
      timer = setI(function () {
        if (!win || win.closed || now() - started > PING_TIMEOUT_MS) { done(false); return; }
        try { win.postMessage('PING', target); } catch (e) { /* not loaded yet */ }
      }, PING_INTERVAL_MS);
    });
  }

  function _download(buffer, fileName, doc) {
    var blob = new Blob([buffer], { type: 'application/json' });
    var a = doc.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    doc.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
  }

  function _toast(msg) {
    if (typeof global._showToast === 'function') global._showToast(msg);
    else if (typeof global.alert === 'function') global.alert(msg);
  }

  // Open the trace of a remote run. `ref` is {simulation_id} | {composite_run_id}
  // | {compose_id}. MUST be called from the click handler itself: the Perfetto
  // window is opened synchronously so it is not popup-blocked, before the trace
  // and support fetches resolve.
  function openTrace(ref, opts) {
    opts = opts || {};
    var doc = opts.document || global.document;
    var loc = opts.location || global.location;
    var fetchImpl = opts.fetch || global.fetch;
    var btn = opts.button || null;
    var key = ref.simulation_id != null ? 'simulation_id'
      : (ref.composite_run_id != null ? 'composite_run_id' : 'compose_id');
    var id = ref[key];
    var label = (key === 'simulation_id' ? 'simulation ' : 'run ') + id;
    var traceUrl = _bp() + '/api/remote-run-trace?' + key + '=' + encodeURIComponent(id);

    // The button is only visible once support resolved, so the value is normally
    // here already and the window opens synchronously inside the click (popup
    // blockers allow that); otherwise wait for it and hope activation lasts.
    if (_supportValue) return Promise.resolve(_go(_supportValue));
    return support(fetchImpl).then(_go);

    function _go(s) {
      var url = viewerUrl(s && s.viewer, loc);
      var win = url ? (opts.open || global.open)(url, '_blank') : null;
      var orig = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = '… trace'; }
      function restore() { if (btn) { btn.disabled = false; btn.textContent = orig; } }
      return fetchImpl(traceUrl).then(function (r) {
        if (!r.ok) {
          return r.json().catch(function () { return {}; }).then(function (b) {
            throw new Error((b && b.error) || ('HTTP ' + r.status));
          });
        }
        var fileName = 'trace-' + String(id) + '.json';
        var cd = r.headers && r.headers.get && r.headers.get('Content-Disposition');
        var m = cd && /filename="([^"]+)"/.exec(cd);
        if (m) fileName = m[1];
        return r.arrayBuffer().then(function (buf) { return { buf: buf, fileName: fileName }; });
      }).then(function (t) {
        restore();
        if (!win) {
          if (url) _toast('Popup blocked — downloading the trace instead.');
          _download(t.buf, t.fileName, doc);
          return 'downloaded';
        }
        var abs = ((loc && loc.origin) || '') + traceUrl;
        return postTrace(win, url, t.buf, {
          title: 'Workbench — ' + label, fileName: t.fileName, url: abs,
        }, opts.env).then(function (ok) {
          if (!ok) _toast('Perfetto did not respond — is ' + url + ' reachable from this browser?');
          return ok ? 'opened' : 'timeout';
        });
      }).catch(function (err) {
        restore();
        if (win && !win.closed) win.close();
        _toast('Could not load the trace for ' + label + ': ' + (err && err.message || err));
        return 'error';
      });
    }
  }

  // Delegated click: any `.trace-remote-btn` inside a row carrying the remote
  // simulation id (sim-table.js renders the button, rows carry the id).
  function _onClick(e) {
    var btn = e.target && e.target.closest && e.target.closest('.trace-remote-btn');
    if (!btn) return;
    e.stopPropagation();
    e.preventDefault();
    var ref = {};
    var host = btn.closest('[data-remote-sim-id],[data-composite-run-id]');
    var sim = btn.getAttribute('data-remote-sim-id') || (host && host.getAttribute('data-remote-sim-id'));
    var comp = btn.getAttribute('data-composite-run-id') || (host && host.getAttribute('data-composite-run-id'));
    if (sim) ref.simulation_id = sim; else if (comp) ref.composite_run_id = comp; else return;
    openTrace(ref, { button: btn });
  }

  var api = {
    support: support, viewerUrl: viewerUrl, postTrace: postTrace, openTrace: openTrace,
    _reset: function () { _support = null; _supportValue = null; },
  };
  global.VivaPerfetto = api;

  if (typeof document !== 'undefined' && document.addEventListener && !document._vivaTraceWired) {
    document._vivaTraceWired = true;
    _installHideStyle(document);
    document.addEventListener('click', _onClick, true);
    support().then(function (s) { if (s && s.supported) _revealActions(document); });
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : globalThis);
