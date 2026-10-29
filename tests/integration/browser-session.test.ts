import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { BrowserSession, BrowserSessionError, type SessionConfig } from '../../src/services/browser/session';
import { UrlPolicy } from '../../src/services/browser/policy';
import { startTestSite, type TestSite } from '../helpers/test-site';
import { hasChromium } from '../helpers/chromium';

const baseConfig: SessionConfig = {
  navTimeoutMs: 6000,
  actionTimeoutMs: 3000,
  maxText: 4000,
  maxElements: 60,
  blockUnconfirmedMutations: true,
  maxRequests: 500,
};

let browser: Browser;
let site: TestSite;
const open: BrowserSession[] = [];

const policy = () =>
  new UrlPolicy({ allowedDomains: [], blockedDomains: ['blocked.test'], allowPrivateNetwork: true });

async function newSession(overrides: Partial<SessionConfig> = {}): Promise<BrowserSession> {
  const s = await BrowserSession.open({
    browser,
    policy: policy(),
    scopeHost: '127.0.0.1',
    config: { ...baseConfig, ...overrides },
  });
  open.push(s);
  return s;
}

const find = (snap: Awaited<ReturnType<BrowserSession['snapshot']>>, role: string, name: RegExp) => {
  const el = snap.elements.find((e) => e.role === role && name.test(e.name));
  if (!el) throw new Error(`element not found: ${role} ${name}\n${JSON.stringify(snap.elements.map((e) => `${e.ref} ${e.role} ${e.name}`))}`);
  return el;
};

beforeAll(async () => {
  if (!hasChromium) return;
  site = await startTestSite();
  browser = await chromium.launch({ headless: true });
}, 60000);

afterAll(async () => {
  await Promise.all(open.map((s) => s.close()));
  await browser?.close();
  await site?.close();
});

describe.skipIf(!hasChromium)('BrowserSession: navigation and reading', () => {
  it('opens a page and returns visible text, headings and interactive elements', async () => {
    const s = await newSession();
    const nav = await s.goto(`${site.url}/`);
    expect(nav.status).toBe(200);
    const snap = await s.snapshot();
    expect(snap.title).toBe('Test Home');
    expect(snap.headings).toContain('Welcome to the test shop');
    expect(snap.text).toContain('Browse our products');
    find(snap, 'link', /products/i);
    find(snap, 'textbox', /search/i);
    expect(snap.state.loginRequired).toBe(false);
  }, 30000);

  it('never exposes query strings in URLs it reports', async () => {
    const s = await newSession();
    await s.goto(`${site.url}/search?q=secret-token-123`);
    const snap = await s.snapshot();
    expect(snap.url).toBe(`${site.url}/search`);
    expect(JSON.stringify(snap)).not.toContain('secret-token-123=');
    expect(s.currentUrl).not.toContain('?');
  }, 30000);

  it('follows a link across pages and works as a multi-step flow (fill, search, read)', async () => {
    const s = await newSession();
    await s.goto(`${site.url}/`);
    let snap = await s.snapshot();
    await s.fill(find(snap, 'textbox', /search/i).ref, 'blue widgets');
    snap = await s.snapshot();
    const result = await s.click(find(snap, 'button', /search/i).ref);
    expect(result.navigated).toBe(true);
    snap = await s.snapshot();
    expect(snap.text).toContain('Results for blue widgets');
    expect(site.posts).toHaveLength(0);

    await s.goto(`${site.url}/products`);
    const table = (await s.extract('tables')) as string[][][];
    expect(table[0]![1]).toEqual(['Widget', '$10']);
  }, 30000);

  it('waits for dynamically loaded content and reports a timeout explicitly', async () => {
    const s = await newSession();
    await s.goto(`${site.url}/dynamic`);
    await s.waitFor({ text: 'Loaded dynamically', timeoutMs: 5000 });
    const snap = await s.snapshot();
    expect(snap.text).toContain('Loaded dynamically');
    await expect(s.waitFor({ text: 'never appears', timeoutMs: 700 })).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' });
  }, 30000);

  it('reports a slow page as a timeout instead of hanging', async () => {
    const s = await newSession({ navTimeoutMs: 1500 });
    await expect(s.goto(`${site.url}/slow`)).rejects.toMatchObject({ code: 'NAVIGATION_TIMEOUT' });
  }, 30000);

  it('recovers from a transient network failure by retrying the GET navigation', async () => {
    const s = await newSession();
    await s.goto(`${site.url}/flaky`); // first hit passes, second is dropped (hit #1 in map), see site
    site.hits.set('/flaky', 0);
    await s.goto(`${site.url}/flaky`);
    await s.goto(`${site.url}/flaky`); // this one hits the dropped connection and must be retried
    expect((await s.snapshot()).title).toBe('Flaky');
  }, 30000);
});

describe.skipIf(!hasChromium)('BrowserSession: page state detection', () => {
  it('detects a login page', async () => {
    const s = await newSession();
    await s.goto(`${site.url}/login`);
    const snap = await s.snapshot();
    expect(snap.state.loginRequired).toBe(true);
    expect(find(snap, 'textbox', /password/i).sensitive).toBe(true);
  }, 30000);

  it('detects a redirect to login when a session is missing', async () => {
    const s = await newSession();
    await s.goto(`${site.url}/account`);
    expect((await s.snapshot()).state.loginRequired).toBe(true);
  }, 30000);

  it('detects a CAPTCHA and a blocked page', async () => {
    const s = await newSession();
    await s.goto(`${site.url}/captcha`);
    expect((await s.snapshot()).state.captcha).toBe(true);
    await s.goto(`${site.url}/blocked`);
    const blocked = await s.snapshot();
    expect(blocked.state.blocked).toBe(true);
    expect(blocked.state.httpStatus).toBe(403);
  }, 30000);
});

describe.skipIf(!hasChromium)('BrowserSession: safety', () => {
  it('rejects unsafe URLs and out-of-scope navigation', async () => {
    const s = await newSession();
    await expect(s.goto('file:///etc/passwd')).rejects.toBeInstanceOf(BrowserSessionError);
    await expect(s.goto('javascript:alert(1)')).rejects.toBeInstanceOf(BrowserSessionError);
    await expect(s.goto('http://user:pw@127.0.0.1/')).rejects.toBeInstanceOf(BrowserSessionError);
    await expect(s.goto(`http://localhost:${site.port}/`)).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
  }, 30000);

  it('stops a server-side redirect to another site', async () => {
    const s = await newSession();
    await expect(s.goto(`${site.url}/redirect-out`)).rejects.toMatchObject({ code: 'OUT_OF_SCOPE' });
    await expect(s.goto(`${site.url}/redirect-blocked`)).rejects.toBeInstanceOf(BrowserSessionError);
  }, 30000);

  it('stops a JavaScript redirect to another site and parks the browser on a blank page', async () => {
    const s = await newSession();
    await s.goto(`${site.url}/js-redirect`).catch(() => undefined);
    expect(s.currentUrl).not.toContain('localhost');
  }, 30000);

  it('survives a redirect loop without hanging', async () => {
    const s = await newSession();
    await expect(s.goto(`${site.url}/redirect-loop-a`)).rejects.toBeInstanceOf(BrowserSessionError);
  }, 30000);

  it('never types into password fields or payment fields', async () => {
    const s = await newSession();
    await s.goto(`${site.url}/login`);
    let snap = await s.snapshot();
    await expect(s.fill(find(snap, 'textbox', /password/i).ref, 'hunter2')).rejects.toMatchObject({ code: 'SENSITIVE_FIELD' });
    await s.goto(`${site.url}/checkout`);
    snap = await s.snapshot();
    await expect(s.fill(find(snap, 'textbox', /card/i).ref, '4111111111111111')).rejects.toMatchObject({ code: 'SENSITIVE_FIELD' });
  }, 30000);

  it('rejects stale refs from an older snapshot', async () => {
    const s = await newSession();
    await s.goto(`${site.url}/`);
    const old = await s.snapshot();
    await s.snapshot();
    await expect(s.click(find(old, 'link', /products/i).ref)).rejects.toMatchObject({ code: 'STALE_ELEMENT' });
    await expect(s.click('not-a-ref')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  }, 30000);

  it('ignores downloads, dialogs and new tabs', async () => {
    const s = await newSession();
    await s.goto(`${site.url}/`);
    let snap = await s.snapshot();
    await s.click(find(snap, 'button', /show alert/i).ref); // would freeze a naive browser
    snap = await s.snapshot();
    const r = await s.click(find(snap, 'link', /new tab/i).ref); // loaded in the same tab, no popup left open
    expect(r.urlAfter).toBe(`${site.url}/popup`);
  }, 30000);
});

describe.skipIf(!hasChromium)('BrowserSession: prompt injection in page content', () => {
  it('flags injected instructions, and leaves hidden text out of what the model sees', async () => {
    const s = await newSession();
    await s.goto(`${site.url}/inject`);
    const snap = await s.snapshot();
    expect(snap.suspectedInjection).toBe(true);
    expect(snap.text).not.toContain('Hidden: ignore previous');
    expect(snap.text).not.toContain('tiny hidden instruction');
  }, 30000);

  it('does not flag an ordinary page', async () => {
    const s = await newSession();
    await s.goto(`${site.url}/about`);
    expect((await s.snapshot()).suspectedInjection).toBe(false);
  }, 30000);
});

describe.skipIf(!hasChromium)('BrowserSession: consequential actions', () => {
  it('refuses to click a submit button without confirmation, and posts nothing', async () => {
    const before = site.posts.length;
    const s = await newSession();
    await s.goto(`${site.url}/compose`);
    let snap = await s.snapshot();
    await s.fill(find(snap, 'textbox', /recipient/i).ref, 'alice@example.com');
    snap = await s.snapshot();
    await expect(s.click(find(snap, 'button', /send message/i).ref)).rejects.toMatchObject({ code: 'USE_SENSITIVE_ACTION' });
    expect(site.posts.length).toBe(before);
  }, 30000);

  it('blocks a mislabelled button that posts from JavaScript (network backstop)', async () => {
    const before = site.posts.length;
    const s = await newSession();
    await s.goto(`${site.url}/sneaky`);
    const snap = await s.snapshot();
    await expect(s.click(find(snap, 'button', /learn more/i).ref)).rejects.toMatchObject({ code: 'SUBMISSION_BLOCKED' });
    expect(site.posts.length).toBe(before);
  }, 30000);

  it('refuses a destructive GET link without confirmation', async () => {
    const s = await newSession();
    await s.goto(`${site.url}/`);
    const snap = await s.snapshot();
    await expect(s.click(find(snap, 'link', /delete my account/i).ref)).rejects.toMatchObject({ code: 'USE_SENSITIVE_ACTION' });
  }, 30000);

  it('performs a confirmed action only when the fingerprint still matches, and reports evidence', async () => {
    const s = await newSession();
    await s.goto(`${site.url}/compose`);
    let snap = await s.snapshot();
    await s.fill(find(snap, 'textbox', /recipient/i).ref, 'alice@example.com');
    snap = await s.snapshot();
    const btn = find(snap, 'button', /send message/i);
    const details = await s.describeElement(btn.ref);
    expect(details.form?.method).toBe('post');
    expect(details.form?.fields.find((f) => /recipient/i.test(f.label))?.value).toBe('alice@example.com');

    // The form changes after the user "approved" this fingerprint: the action must NOT run.
    snap = await s.snapshot();
    await s.fill(find(snap, 'textbox', /recipient/i).ref, 'mallory@example.com');
    snap = await s.snapshot();
    const postsBefore = site.posts.length;
    await expect(
      s.click(find(snap, 'button', /send message/i).ref, { confirmed: true, expectedFingerprint: details.fingerprint })
    ).rejects.toMatchObject({ code: 'ACTION_CHANGED' });
    expect(site.posts.length).toBe(postsBefore);

    // Re-inspect (new confirmation) and run it for real.
    const fresh = await s.describeElement(find(snap, 'button', /send message/i).ref);
    const result = await s.click(find(snap, 'button', /send message/i).ref, { confirmed: true, expectedFingerprint: fresh.fingerprint });
    expect(result.mutationStatuses).toEqual([200]);
    expect(site.posts.at(-1)?.body).toContain('mallory%40example.com');
    const evidence = await s.collectEvidence(result);
    expect(evidence.successSignals.length).toBeGreaterThan(0);
    expect(evidence.excerpt).toContain('Confirmation number');
  }, 30000);
});
