/**
 * The three pages of the remote sign-in. Server-rendered, no external assets, no third-party scripts. Every dynamic
 * value is HTML-escaped, and the pages are served with a per-response nonce CSP (see the controller).
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

const STYLE = `
  :root{color-scheme:light dark;--bg:#f5f6f8;--fg:#14171a;--card:#fff;--line:#d9dde3;--accent:#0b6bcb;--ok:#1a7f37;--bad:#b42318}
  @media (prefers-color-scheme:dark){:root{--bg:#101214;--fg:#eceff3;--card:#1a1d21;--line:#2b3036;--accent:#5aa9ff;--ok:#3fb950;--bad:#ff7b72}}
  *{box-sizing:border-box}body{margin:0;font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
  main{max-width:560px;margin:0 auto;padding:20px 16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px}
  h1{font-size:1.25rem;margin:0 0 8px}p{margin:8px 0}
  .muted{opacity:.75;font-size:.9rem}
  button{font:inherit;border-radius:8px;border:1px solid var(--line);padding:10px 14px;background:var(--card);color:var(--fg);cursor:pointer}
  button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  button.danger{color:var(--bad)}
  .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
  .ok{color:var(--ok)}.bad{color:var(--bad)}
`;

function shell(title: string, nonce: string, body: string, extraHead = ''): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
${extraHead}
<style nonce="${nonce}">${STYLE}</style>
</head><body>${body}</body></html>`;
}

/** Shown for invalid, used or expired links (all look identical) and for finished sessions. */
export function messagePage(opts: { nonce: string; heading: string; text: string; tone?: 'ok' | 'bad' | 'neutral' }): string {
  const cls = opts.tone === 'ok' ? 'ok' : opts.tone === 'bad' ? 'bad' : '';
  return shell(
    opts.heading,
    opts.nonce,
    `<main><div class="card"><h1 class="${cls}">${escapeHtml(opts.heading)}</h1><p>${escapeHtml(opts.text)}</p></div></main>`
  );
}

/**
 * Landing page for the link. Viewing it changes nothing (chat apps pre-fetch links); the single use is spent only
 * when the user presses the button, which POSTs.
 */
export function interstitialPage(opts: { nonce: string; host: string; token: string; reason: string; minutes: number }): string {
  const what = opts.reason === 'captcha' ? 'complete a security check' : opts.reason === 'mfa' ? 'finish verification' : 'sign in';
  return shell(
    'Secure sign-in',
    opts.nonce,
    `<main><div class="card">
  <h1>Secure sign-in to ${escapeHtml(opts.host)}</h1>
  <p>You are about to ${escapeHtml(what)} on <strong>${escapeHtml(opts.host)}</strong> in a private browser session run by your assistant.</p>
  <ul>
    <li>Only <strong>${escapeHtml(opts.host)}</strong> can be opened here.</li>
    <li>What you type is sent to that website. It is not stored and the AI never sees it.</li>
    <li>This link works once. The session lasts up to ${opts.minutes} minutes.</li>
  </ul>
  <p class="muted">If you didn't ask your assistant to do this, close this page.</p>
  <form method="post" action="/handoff/${escapeHtml(opts.token)}/start"><div class="row"><button class="primary" type="submit">Continue to ${escapeHtml(opts.host)}</button></div></form>
</div></main>`
  );
}

/** The remote browser viewer. Talks only to /handoff/session/* with its cookie and an anti-CSRF header. */
export function viewerPage(opts: { nonce: string; host: string; csrf: string; reason: string }): string {
  const hint =
    opts.reason === 'captcha'
      ? 'Complete the security check, then tap “I’m done”.'
      : opts.reason === 'mfa'
        ? 'Enter your verification code, then tap “I’m done”.'
        : 'Sign in below. When you can see you are signed in, tap “I’m done”.';
  const script = String.raw`
(function () {
  var csrf = document.querySelector('meta[name="csrf"]').content;
  var screen = document.getElementById('screen');
  var wrap = document.getElementById('wrap');
  var banner = document.getElementById('banner');
  var msg = document.getElementById('msg');
  var ended = document.getElementById('ended');
  var controls = document.getElementById('controls');
  var running = true, fast = 0;

  function post(path, body) {
    return fetch('/handoff/session/' + path, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: JSON.stringify(body || {})
    });
  }
  function say(text, bad) { msg.textContent = text || ''; msg.className = bad ? 'bad' : 'muted'; }
  function end(state, label, text) {
    running = false; controls.hidden = true; wrap.hidden = true; ended.hidden = false;
    document.getElementById('endedTitle').textContent = label;
    document.getElementById('endedTitle').className = state === 'connected' ? 'ok' : 'bad';
    document.getElementById('endedText').textContent = text;
    banner.textContent = label;
  }
  var texts = {
    connected: 'You are connected. You can close this page and go back to WhatsApp. Your assistant is continuing.',
    expired: 'This sign-in expired. Ask your assistant on WhatsApp for a new link.',
    cancelled: 'This sign-in was cancelled.',
    failed: 'Something went wrong. Ask your assistant on WhatsApp for a new link.'
  };

  async function status() {
    try {
      var r = await fetch('/handoff/session/status', { credentials: 'same-origin', cache: 'no-store' });
      if (r.status !== 200) { end('expired', 'Expired', texts.expired); return; }
      var s = await r.json();
      if (s.state === 'waiting_for_login') {
        var m = Math.floor(s.secondsLeft / 60), sec = String(s.secondsLeft % 60).padStart(2, '0');
        banner.textContent = 'Waiting for sign-in · ' + m + ':' + sec + ' left';
      } else { end(s.state, s.label, texts[s.state] || texts.failed); }
    } catch (e) {}
  }

  async function frame() {
    if (!running) return;
    try {
      var r = await fetch('/handoff/session/frame?_=' + Date.now(), { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 200) {
        var url = URL.createObjectURL(await r.blob());
        var old = screen.src; screen.src = url;
        if (old && old.indexOf('blob:') === 0) URL.revokeObjectURL(old);
      } else if (r.status !== 429) { await status(); }
    } catch (e) {}
    setTimeout(frame, fast > 0 ? (fast--, 350) : 900);
  }

  screen.addEventListener('click', function (e) {
    var b = screen.getBoundingClientRect();
    post('input', { type: 'click', x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height });
    fast = 6; wrap.focus();
  });
  screen.addEventListener('wheel', function (e) { e.preventDefault(); post('input', { type: 'scroll', dy: Math.max(-1000, Math.min(1000, e.deltaY)) }); fast = 4; }, { passive: false });

  var SPECIAL = { Enter: 1, Tab: 1, Backspace: 1, Delete: 1, Escape: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1, Home: 1, End: 1, PageUp: 1, PageDown: 1 };
  wrap.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (SPECIAL[e.key]) { e.preventDefault(); post('input', { type: 'key', key: e.key }); fast = 5; }
    else if (e.key.length === 1) { e.preventDefault(); post('input', { type: 'type', text: e.key }); fast = 5; }
  });

  document.getElementById('textForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var box = document.getElementById('text'); var v = box.value; if (!v) return;
    box.value = '';
    var r = await post('input', { type: 'type', text: v.slice(0, 200) });
    say(r.status === 200 ? '' : 'That could not be typed.', r.status !== 200); fast = 6;
  });
  document.getElementById('hide').addEventListener('change', function (e) { document.getElementById('text').type = e.target.checked ? 'password' : 'text'; });
  Array.prototype.forEach.call(document.querySelectorAll('[data-key]'), function (b) {
    b.addEventListener('click', function () { post('input', { type: 'key', key: b.getAttribute('data-key') }); fast = 5; });
  });

  document.getElementById('done').addEventListener('click', async function () {
    say('Checking…');
    var r = await post('complete'); var j = {};
    try { j = await r.json(); } catch (e) {}
    if (r.status === 200 && j.ok) { end('connected', 'Connected', texts.connected); }
    else if (r.status === 403 || r.status === 401) { end('expired', 'Expired', texts.expired); }
    else { say(j.message || 'Not finished yet.', true); }
  });
  document.getElementById('cancel').addEventListener('click', async function () {
    if (!confirm('Cancel this sign-in?')) return;
    await post('cancel'); end('cancelled', 'Cancelled', texts.cancelled);
  });

  status(); setInterval(status, 2500); frame();
})();
`;
  return shell(
    `Sign in to ${opts.host}`,
    opts.nonce,
    `<main>
  <div class="card">
    <h1>Sign in to ${escapeHtml(opts.host)}</h1>
    <p id="banner" class="muted">Starting…</p>
    <p class="muted">${escapeHtml(hint)}</p>
    <div id="wrap" tabindex="0" style="outline:none">
      <img id="screen" alt="Remote browser" style="width:100%;border:1px solid var(--line);border-radius:8px;background:#fff;cursor:pointer;touch-action:manipulation">
    </div>
    <div id="controls">
      <form id="textForm" class="row" autocomplete="off">
        <input id="text" type="text" maxlength="200" placeholder="Type here, then Send" autocomplete="off" autocapitalize="off" spellcheck="false" style="flex:1;min-width:0;font:inherit;padding:10px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)">
        <button type="submit">Send</button>
      </form>
      <label class="muted"><input id="hide" type="checkbox"> Hide what I type (passwords, codes)</label>
      <div class="row">
        <button type="button" data-key="Enter">Enter</button><button type="button" data-key="Tab">Tab</button><button type="button" data-key="Backspace">Backspace</button>
      </div>
      <p id="msg" class="muted"></p>
      <div class="row"><button id="done" class="primary" type="button">I’m done</button><button id="cancel" class="danger" type="button">Cancel</button></div>
    </div>
    <div id="ended" hidden><h1 id="endedTitle"></h1><p id="endedText"></p></div>
  </div>
</main>
<script nonce="${opts.nonce}">${script}</script>`,
    `<meta name="csrf" content="${escapeHtml(opts.csrf)}">`
  );
}
