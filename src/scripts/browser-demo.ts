/**
 * Manual test for the browser engine. Needs no database, no model and no account.
 *
 *   npm run browser:demo                      -> reads https://example.com (harmless public page)
 *   npm run browser:demo -- https://example.org
 *   npm run browser:demo -- --local           -> runs against a local test shop (forms, checkout, redirects)
 *
 * It prints what the model would see, then shows the safety guards refusing things.
 */
import { chromium } from 'playwright';
import { formatSnapshot } from '../services/browser/browser-tools';
import { UrlPolicy } from '../services/browser/policy';
import { BrowserSession, type SessionConfig } from '../services/browser/session';
import { startTestSite } from './browser-test-site';

const config: SessionConfig = {
  navTimeoutMs: 20000,
  actionTimeoutMs: 8000,
  maxText: 1500,
  maxElements: 30,
  blockUnconfirmedMutations: true,
  maxRequests: 1500,
};

function show(title: string, value: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function attempt(title: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    show(title, 'ALLOWED');
  } catch (err) {
    show(title, `REFUSED -> ${err instanceof Error ? err.message : 'error'}`);
  }
}

async function main(): Promise<void> {
  const local = process.argv.includes('--local');
  const target = process.argv.slice(2).find((a) => a.startsWith('http'));
  const site = local ? await startTestSite() : null;
  const startUrl = site ? `${site.url}/` : (target ?? 'https://example.com');
  const host = new URL(startUrl).hostname.replace(/^www\./, '');

  const policy = new UrlPolicy({ allowedDomains: [], blockedDomains: [], allowPrivateNetwork: local });
  const browser = await chromium.launch({ headless: true });
  const session = await BrowserSession.open({ browser, policy, scopeHost: host, config });

  try {
    await session.goto(startUrl);
    let snap = await session.snapshot();
    show(`Page the model sees (${snap.url})`, formatSnapshot(snap));

    // Safety guards (these never need a real site)
    await attempt('Visit the cloud metadata address', () => new UrlPolicy({ allowedDomains: [], blockedDomains: [], allowPrivateNetwork: false }).validate('http://169.254.169.254/latest/meta-data/'));
    await attempt('Visit localhost with the production policy', () => new UrlPolicy({ allowedDomains: [], blockedDomains: [], allowPrivateNetwork: false }).validate('http://localhost:8080/'));
    await attempt('Open a file:// URL', () => session.goto('file:///C:/Windows/win.ini'));
    await attempt('Leave the website for another one', () => session.goto('https://www.iana.org/'));

    if (site) {
      await session.goto(`${site.url}/compose`);
      snap = await session.snapshot();
      const to = snap.elements.find((e) => /recipient/i.test(e.name))!;
      await session.fill(to.ref, 'demo@example.com');
      snap = await session.snapshot();
      const send = snap.elements.find((e) => /send message/i.test(e.name))!;
      show('Inspecting the "Send message" button', { ...(await session.describeElement(send.ref)), classification: session.classify(await session.describeElement(send.ref)) });
      await attempt('Click "Send message" without the user confirming', () => session.click(send.ref));
      show('Requests that reached the test server (should be none)', site.posts);
    }
  } finally {
    await session.close();
    await browser.close();
    await site?.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
