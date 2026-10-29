/**
 * Connects a website to a user's account, the supported way: the USER signs in themselves in a real browser window
 * (including any CAPTCHA or two-factor step). The resulting session is stored encrypted and bound to that user.
 * The assistant never sees the password, the cookies or the page, and nothing here tries to bypass a login.
 *
 *   npm run browser:connect -- --user <user-uuid> --url https://app.example.com [--label "Work CRM"]
 *
 * Requires BROWSER_ENCRYPTION_KEY (generate one with: npm run browser:genkey).
 */
import readline from 'readline';
import { chromium } from 'playwright';
import { eq } from 'drizzle-orm';
import { getConfig } from '../config/env';
import { closeDatabaseConnection, getDb } from '../db/client';
import { users } from '../db/schema';
import { BrowserConnectionService } from '../services/browser/connection-service';
import { parseCsv, UrlPolicy } from '../services/browser/policy';
import { redactUrl } from '../services/browser/redact';
import type { StorageState } from '../services/browser/session';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const userId = arg('user');
  const rawUrl = arg('url');
  const label = arg('label');
  if (!userId || !rawUrl) {
    console.error('Usage: npm run browser:connect -- --user <user-uuid> --url https://site [--label name]');
    process.exit(2);
  }

  const config = getConfig();
  if (!config.BROWSER_ENCRYPTION_KEY) {
    console.error('BROWSER_ENCRYPTION_KEY is not set. Generate one with: npm run browser:genkey');
    process.exit(2);
  }

  const [user] = await getDb().select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) {
    console.error('No such user.');
    process.exit(2);
  }

  const policy = new UrlPolicy({
    allowedDomains: parseCsv(config.BROWSER_ALLOWED_DOMAINS),
    blockedDomains: parseCsv(config.BROWSER_BLOCKED_DOMAINS),
    allowPrivateNetwork: config.BROWSER_ALLOW_PRIVATE_NETWORK,
  });
  const url = await policy.validate(rawUrl);
  const origin = BrowserConnectionService.normalizeOrigin(url.toString(), config.BROWSER_ALLOW_PRIVATE_NETWORK);

  console.log(`\nOpening ${redactUrl(url.toString())} in a browser window.`);
  console.log('Sign in yourself (complete any CAPTCHA or two-factor step), then come back here and press Enter.');
  console.log('Close nothing before pressing Enter. Your password is never read or stored by this tool.\n');

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ viewport: null });
    const page = await context.newPage();
    await page.goto(url.toString());

    await new Promise<void>((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('Press Enter once you are signed in... ', () => {
        rl.close();
        resolve();
      });
    });

    const state = (await context.storageState()) as unknown as StorageState;
    const connection = await new BrowserConnectionService().connect(
      userId,
      { origin, storageState: state, label },
      { allowHttp: config.BROWSER_ALLOW_PRIVATE_NETWORK }
    );
    console.log(`\nConnected: ${connection.origin} (${connection.status}). The session is stored encrypted for this user only.`);
    console.log(`To disconnect: DELETE /api/browser/connections/${connection.id}`);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

main()
  .catch((err) => {
    console.error('Could not connect the website:', err instanceof Error ? err.message : 'unknown error');
    process.exitCode = 1;
  })
  .finally(() => closeDatabaseConnection());
