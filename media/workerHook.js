// @ts-nocheck
(function () {
  const Orig = window.Worker;
  if (!Orig) return;
  const buf = (window.__vtpWorkerErrors = window.__vtpWorkerErrors || []);
  function Patched(url, opts) {
    let w;
    try {
      w = new Orig(url, opts);
    } catch (e) {
      buf.push('Worker ctor threw: ' + (e && e.message ? e.message : String(e)));
      throw e;
    }
    try {
      w.addEventListener('error', function (ev) {
        const where = (ev.filename ? String(ev.filename).split('/').pop() : '') + ':' + (ev.lineno || 0);
        buf.push('worker error: ' + (ev.message || '(no message — often CSP/WASM)') + ' @ ' + where);
      });
      w.addEventListener('messageerror', function () { buf.push('worker messageerror (clone failed)'); });
    } catch (e) {}
    return w;
  }
  Patched.prototype = Orig.prototype;
  window.Worker = Patched;
})();
