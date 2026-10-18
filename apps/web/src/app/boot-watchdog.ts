/**
 * Inline script for the root layout: makes a page whose JavaScript never starts visible instead
 * of silently dead (a blocked chunk, a browser too old for Next.js, a dev server refusing the
 * phone's origin…). It is plain ES5 inside the HTML, so it runs even when the app's bundles
 * don't.
 *
 * - Records uncaught errors and unhandled rejections from the start (React 19 also reports
 *   hydration errors this way in production) and logs them with a "[jantrik]" prefix.
 * - If the app has not marked itself hydrated (`window.__jantrikHydrated`, set by Providers)
 *   within 20 s, shows a Bangla/English banner with a reload button and the last errors.
 *   `window.__jantrikBootTimeoutMs` overrides the wait (tests).
 */
export const BOOT_WATCHDOG = `(function () {
  var errors = [];
  window.__jantrikErrors = errors;
  function note(text) {
    errors.push(text);
    if (window.console && console.error) console.error('[jantrik] ' + text);
  }
  window.addEventListener('error', function (e) {
    note(String((e.error && e.error.message) || e.message || 'error') + (e.filename ? ' @ ' + e.filename : ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    note('unhandled rejection: ' + String((r && r.message) || r));
  });
  setTimeout(function () {
    if (window.__jantrikHydrated || !document.body) return;
    var en = document.documentElement.lang === 'en';
    var box = document.createElement('div');
    box.setAttribute('role', 'alert');
    box.setAttribute('data-testid', 'boot-failure');
    box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;background:#fff;color:#15231f;border:2px solid #b42318;border-radius:14px;padding:16px;font:16px/1.6 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.2)';
    var title = document.createElement('p');
    title.style.cssText = 'margin:0 0 4px;font-weight:600';
    title.textContent = en ? 'This page did not start properly.' : 'পাতাটি ঠিকমতো চালু হয়নি।';
    var text = document.createElement('p');
    text.style.cssText = 'margin:0 0 12px';
    text.textContent = en
      ? 'Check the internet connection and reload. If it keeps happening, update the browser.'
      : 'ইন্টারনেট সংযোগ দেখে আবার লোড করুন। বারবার হলে ব্রাউজারটি আপডেট করুন।';
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = en ? 'Reload' : 'আবার লোড করুন';
    button.style.cssText = 'min-height:44px;padding:0 18px;border:0;border-radius:10px;background:#0e5e50;color:#fff;font:inherit;font-weight:600';
    button.onclick = function () { location.reload(); };
    box.appendChild(title);
    box.appendChild(text);
    box.appendChild(button);
    if (errors.length) {
      var details = document.createElement('pre');
      details.style.cssText = 'margin:12px 0 0;white-space:pre-wrap;font:12px/1.4 monospace;color:#5a6b66;max-height:30vh;overflow:auto';
      details.textContent = errors.slice(-3).join('\\n');
      box.appendChild(details);
    }
    document.body.appendChild(box);
  }, window.__jantrikBootTimeoutMs || 20000);
})();`;
