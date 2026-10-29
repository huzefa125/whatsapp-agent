/**
 * Scripts that run INSIDE the page. They are plain strings (not TypeScript functions) on purpose: Playwright
 * serializes them into the browser, where transpiler helpers such as `__name` do not exist.
 *
 * Security notes:
 * - These scripts are fixed, trusted server code. Nothing from the model is ever interpolated into them; the only
 *   inputs are numbers and the sensitive-field patterns, passed as JSON arguments.
 * - The page can lie about itself (labels, hidden text). The server therefore re-derives everything at the moment
 *   of action and backs it with a network-level guard, instead of trusting a previous snapshot.
 */

export const REF_ATTRIBUTE = 'data-instinct-ref';
/** "e<snapshot generation>-<index>", so a ref from an older view of the page is detected as stale. */
export const REF_PATTERN = /^e\d{1,6}-\d{1,4}$/;

/** Sensitive-field patterns, shared with risk.ts so the page-side and server-side checks cannot drift apart. */
export const SENSITIVE_NAME_SOURCE =
  '(pass(word|wd)?|pwd|cvv|cvc|card[-_ ]?(num|number)|cc[-_ ]?(num|number|exp)|ccnum|iban|ssn|otp|one[-_ ]?time|2fa|pin\\b|secret|token)';
export const SENSITIVE_AUTOCOMPLETE_SOURCE = '^(current-password|new-password|one-time-code|cc-.*)$';

const HELPERS = String.raw`
  var SENS_NAME = new RegExp(args.sensitiveName, 'i');
  var SENS_AC = new RegExp(args.sensitiveAutocomplete, 'i');
  function textOf(el) { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
  function cut(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    var s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
    if (parseFloat(s.opacity) < 0.05) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.right <= 0 || r.bottom <= 0) return false;
    if (el.closest('[aria-hidden="true"],[inert],[hidden]')) return false;
    return true;
  }
  function labelFor(el) {
    var al = el.getAttribute('aria-label'); if (al) return al;
    var lb = el.getAttribute('aria-labelledby');
    if (lb) {
      var t = lb.split(/\s+/).map(function (id) { var n = document.getElementById(id); return n ? textOf(n) : ''; }).join(' ').trim();
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      var t2 = Array.prototype.map.call(el.labels, textOf).join(' ').trim();
      if (t2) return t2;
    }
    var tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) return el.value || type;
    if (tag === 'input' && type === 'image') return el.alt || 'image';
    if (tag === 'img') return el.alt || '';
    var txt = textOf(el);
    if (txt) return txt;
    return el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '';
  }
  function roleOf(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    var tag = el.tagName.toLowerCase(), type = (el.getAttribute('type') || 'text').toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return tag;
  }
  function inputTypeOf(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') return (el.getAttribute('type') || 'text').toLowerCase();
    if (tag === 'button') return (el.getAttribute('type') || 'submit').toLowerCase();
    return tag;
  }
  function isSensitive(el) {
    var type = inputTypeOf(el);
    if (type === 'password') return true;
    var ac = el.getAttribute('autocomplete');
    if (ac && SENS_AC.test(ac.trim())) return true;
    var tag = el.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea') return false;
    return SENS_NAME.test((el.getAttribute('name') || '') + ' ' + (el.id || ''));
  }
  function safeUrl(href) {
    try {
      var u = new URL(href, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.origin + u.pathname;
    } catch (e) { return null; }
  }
  function fieldValue(el) {
    if (isSensitive(el)) return el.value ? '••••' : '';
    var tag = el.tagName.toLowerCase(), type = inputTypeOf(el);
    if (type === 'checkbox' || type === 'radio') return el.checked ? 'checked' : 'unchecked';
    if (tag === 'select') {
      var o = el.options && el.options[el.selectedIndex];
      return o ? cut(o.text, 80) : '';
    }
    return cut(el.value, 80);
  }
`;

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'select',
  'textarea',
  'summary',
  '[role=button]',
  '[role=link]',
  '[role=checkbox]',
  '[role=radio]',
  '[role=tab]',
  '[role=menuitem]',
  '[role=switch]',
  '[role=combobox]',
  '[role=textbox]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(',');

/**
 * Collects visible text and interactive elements, tagging each element with a fresh server-issued ref.
 * Any `data-instinct-ref` already present (e.g. planted by the page) is removed first.
 * args: { generation, maxElements, maxText, sensitiveName, sensitiveAutocomplete }
 */
export const SNAPSHOT_EXPRESSION = (args: Record<string, unknown>): string => `(function (args) {
${HELPERS}
  var REF = '${REF_ATTRIBUTE}';
  var SELECTOR = ${JSON.stringify(INTERACTIVE_SELECTOR)};
  document.querySelectorAll('[' + REF + ']').forEach(function (e) { e.removeAttribute(REF); });

  var roots = [document], pending = [document], visited = 0;
  while (pending.length && visited < 4000) {
    var root = pending.pop();
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length && visited < 4000; i++) {
      visited++;
      if (all[i].shadowRoot) { roots.push(all[i].shadowRoot); pending.push(all[i].shadowRoot); }
    }
  }

  var elements = [], truncated = false, n = 0;
  outer: for (var r = 0; r < roots.length; r++) {
    var found = roots[r].querySelectorAll(SELECTOR);
    for (var k = 0; k < found.length; k++) {
      var el = found[k];
      if (!isVisible(el)) continue;
      if (elements.length >= args.maxElements) { truncated = true; break outer; }
      n++;
      var ref = 'e' + args.generation + '-' + n;
      el.setAttribute(REF, ref);
      var tag = el.tagName.toLowerCase();
      var info = {
        ref: ref, role: roleOf(el), name: cut(labelFor(el), 120), tag: tag,
        disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true'
      };
      if (tag === 'input' || tag === 'button' || tag === 'select' || tag === 'textarea') info.type = inputTypeOf(el);
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        info.value = fieldValue(el);
        info.required = !!el.required;
        if (isSensitive(el)) info.sensitive = true;
        if (info.type === 'checkbox' || info.type === 'radio') info.checked = !!el.checked;
      }
      if (tag === 'select') info.options = Array.prototype.slice.call(el.options, 0, 20).map(function (o) { return cut(o.text, 60); });
      if (tag === 'a') { var h = safeUrl(el.getAttribute('href')); if (h) info.href = h; else continue; }
      elements.push(info);
    }
  }

  // Visible text only: hidden, transparent, tiny or off-screen text (a common place to hide injected instructions) is skipped.
  var visCache = new WeakMap();
  function parentVisible(p) {
    if (visCache.has(p)) return visCache.get(p);
    var s = getComputedStyle(p), ok = isVisible(p) && parseFloat(s.fontSize) >= 5;
    visCache.set(p, ok);
    return ok;
  }
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1 };
  var out = '', total = 0, lastParent = null;
  var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  var node;
  while ((node = walker.nextNode())) {
    var p = node.parentElement;
    if (!p || SKIP[p.tagName.toUpperCase()]) continue;
    var t = node.nodeValue.replace(/\\s+/g, ' ').trim();
    if (!t) continue;
    if (!parentVisible(p)) continue;
    var sep = '';
    if (lastParent && lastParent !== p) sep = getComputedStyle(p).display.indexOf('inline') === 0 ? ' ' : '\\n';
    out += sep + t; lastParent = p; total = out.length;
    if (total > args.maxText) { truncated = true; break; }
  }

  var headings = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3'))
    .filter(isVisible).slice(0, 15).map(function (h) { return cut(textOf(h), 120); }).filter(Boolean);

  var pw = Array.prototype.some.call(document.querySelectorAll('input[type=password]'), isVisible);
  var txt = Array.prototype.some.call(
    document.querySelectorAll('input[type=email],input[type=text],input[type=tel],input:not([type])'), isVisible);
  var captchaFrame = !!document.querySelector(
    'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="turnstile"],iframe[src*="challenges.cloudflare.com"],' +
    'iframe[src*="arkoselabs"],iframe[src*="funcaptcha"],.g-recaptcha,.h-captcha,.cf-turnstile,[data-sitekey]');

  return {
    title: cut(document.title, 200),
    text: out.length > args.maxText ? out.slice(0, args.maxText - 1) + '…' : out,
    headings: headings, elements: elements, truncated: truncated,
    hints: { passwordVisible: pw, textInputVisible: txt, captchaFrame: captchaFrame }
  };
})(${JSON.stringify(args)})`;

/**
 * Describes ONE element (called through locator.evaluate): what it is, which form it belongs to and the form's
 * field values (masked). args: { sensitiveName, sensitiveAutocomplete }
 */
export const DESCRIBE_FUNCTION = `function (el, args) {
${HELPERS}
  var tag = el.tagName.toLowerCase();
  var form = el.form || el.closest('form');
  var summary = null;
  if (form) {
    var fields = [];
    Array.prototype.forEach.call(form.elements, function (f) {
      var ft = (f.getAttribute('type') || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'image'].indexOf(ft) !== -1) return;
      var ftag = f.tagName.toLowerCase();
      if (ftag !== 'input' && ftag !== 'select' && ftag !== 'textarea') return;
      if (!isVisible(f) || fields.length >= 30) return;
      fields.push({ label: cut(labelFor(f), 80), type: inputTypeOf(f), value: fieldValue(f), sensitive: isSensitive(f) });
    });
    var method = (form.getAttribute('method') || 'get').toLowerCase();
    summary = { method: method, action: safeUrl(form.getAttribute('action') || location.href) || '', fields: fields };
  }
  return {
    role: roleOf(el), name: cut(labelFor(el), 160), tag: tag, type: inputTypeOf(el),
    href: tag === 'a' ? safeUrl(el.getAttribute('href')) : null,
    disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
    visible: isVisible(el),
    sensitive: isSensitive(el),
    isRealForm: !!form,
    form: summary,
    origin: location.origin, path: location.pathname
  };
}`;

/** Visible text of one element (or the whole body when called on it), scrubbed of hidden content. */
export const ELEMENT_TEXT_FUNCTION = `function (el, args) {
  function cut(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  return cut((el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim(), args.maxText);
}`;

/** Compact structured extraction. args: { what: 'links'|'tables'|'forms', limit, maxText } */
export const EXTRACT_FUNCTION = `function (root, args) {
  function cut(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function txt(el) { return cut((el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim(), 200); }
  function safeUrl(h) { try { var u = new URL(h, location.href); return (u.protocol === 'http:' || u.protocol === 'https:') ? u.origin + u.pathname : null; } catch (e) { return null; } }
  if (args.what === 'links') {
    return Array.prototype.slice.call(root.querySelectorAll('a[href]'), 0, args.limit).map(function (a) {
      return { text: txt(a), href: safeUrl(a.getAttribute('href')) };
    }).filter(function (l) { return l.href; });
  }
  if (args.what === 'tables') {
    return Array.prototype.slice.call(root.querySelectorAll('table'), 0, 5).map(function (t) {
      return Array.prototype.slice.call(t.rows, 0, args.limit).map(function (r) {
        return Array.prototype.slice.call(r.cells, 0, 12).map(txt);
      });
    });
  }
  return [];
}`;

/**
 * Turns one of the FIXED script sources above into a real function object. Playwright serializes a function via
 * its source text and calls it with the element and argument; a plain string would only be evaluated, not called.
 * Only the constants in this file are ever passed in, never anything derived from a page or from the model.
 */
export function toPageFunction<TArg, TResult>(source: string): (el: unknown, arg: TArg) => TResult {
  // eslint-disable-next-line no-eval
  return (0, eval)(`(${source})`) as (el: unknown, arg: TArg) => TResult;
}

export const describePageFunction = toPageFunction<Record<string, string>, unknown>(DESCRIBE_FUNCTION);
export const elementTextPageFunction = toPageFunction<{ maxText: number }, string>(ELEMENT_TEXT_FUNCTION);
export const extractPageFunction = toPageFunction<{ what: string; limit: number }, unknown>(EXTRACT_FUNCTION);
export const retargetLinkPageFunction = toPageFunction<undefined, void>(
  `function (el) { if (el.target && el.target !== '_self') el.target = '_self'; }`
);
