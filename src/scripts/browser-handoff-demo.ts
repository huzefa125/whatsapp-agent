/**
 * Safe local demonstration of the remote sign-in handoff. Nothing leaves your machine:
 *   - the "website" is a local test site (demo login: demo@example.com / correct-horse)
 *   - the link is printed here instead of being sent on WhatsApp
 *   - the account is a throwaway user that is deleted when the demo ends
 *
 *   npm run browser:handoff-demo
 *
 * Needs the dev database (npm run db:migrate) and BROWSER_ENCRYPTION_KEY (npm run browser:genkey).
 * It deliberately allows localhost targets; that is never enabled in production.
 */
import crypto from 'crypto';
import http from 'http';
import { eq } from 'drizzle-orm';
import { createApp } from '../app';
import { getConfig } from '../config/env';
import { closeDatabaseConnection, getDb } from '../db/client';
import { browserConnections, users } from '../db/schema';
import { BrowserService, type BrowserSettings } from '../services/browser/browser-service';
import { BrowserConnectionService } from '../services/browser/connection-service';
import { HandoffService, setHandoffServiceForTesting, type HandoffNotifier, type TaskResumer } from '../services/browser/handoff';
import { BrowserRunRepository } from '../services/browser/run-repository';
import { startTestSite } from './browser-test-site';

const say = (msg = '') => console.log(msg);

async function main(): Promise<void> {
  const config = getConfig();
  if (!config.BROWSER_ENCRYPTION_KEY) {
    console.error('BROWSER_ENCRYPTION_KEY is not set. Generate one with: npm run browser:genkey');
    process.exit(2);
  }

  const [user] = await getDb()
    .insert(users)
    .values({
      phoneNumber: `+1555${crypto.randomInt(1_000_000, 9_999_999)}9`,
      email: `handoff-demo-${crypto.randomUUID().slice(0, 8)}@example.com`,
      phoneVerifiedAt: new Date(),
      emailVerifiedAt: new Date(),
    })
    .returning();
  const userId = user!.id;

  const site = await startTestSite();
  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const browserSettings: BrowserSettings = {
    maxSteps: 40,
    maxNavigations: 15,
    maxRunMs: 900_000,
    idleMs: 900_000,
    session: { navTimeoutMs: 15000, actionTimeoutMs: 8000, maxText: 4000, maxElements: 60, blockUnconfirmedMutations: true, maxRequests: 1500 },
    manager: { headless: true, maxSessions: 2, maxSessionsPerUser: 1 },
    policy: { allowedDomains: [], blockedDomains: [], allowPrivateNetwork: true }, // demo only: the "site" is on localhost
  };
  const browser = new BrowserService(browserSettings, new BrowserRunRepository(), new BrowserConnectionService(() => config.BROWSER_ENCRYPTION_KEY));

  let printedLink = '';
  const notifier: HandoffNotifier = {
    async send(_user, text) {
      const link = /http:\/\/\S+/.exec(text)?.[0];
      if (link) printedLink = link;
      say('\n[WhatsApp message that the user would receive]\n' + text.replace(/^/gm, '  | '));
    },
  };
  const resumer: TaskResumer = {
    async resume(handoff, host) {
      say(`\n[Agent task that would resume] sign-in to ${host} verified; run ${handoff.runId} continues.`);
      return crypto.randomUUID();
    },
  };

  const service = new HandoffService({
    settings: {
      baseUrl: `http://localhost:${port}`,
      linkTtlMs: 600_000,
      sessionMs: 600_000,
      idleMs: 300_000,
      maxPerHour: 20,
      extraHosts: [],
      allowHttp: true,
    },
    browser,
    notifier,
    resumer,
  });
  setHandoffServiceForTesting(service);
  service.startSweeper(5000);

  let finished = false;
  const cleanup = async () => {
    if (finished) return;
    finished = true;
    service.stopSweeper();
    await browser.shutdown();
    server.close();
    await site.close();
    await getDb().delete(users).where(eq(users.id, userId)); // cascades to handoffs, runs and connections
    await closeDatabaseConnection();
  };
  process.on('SIGINT', () => void cleanup().then(() => process.exit(130)));
  process.on('SIGTERM', () => void cleanup().then(() => process.exit(143)));

  try {
    say('Starting a browser task that hits a login page...');
    const { run } = await browser.startRun(userId, { url: `${site.url}/account`, idempotencyKey: `demo-${Date.now()}` });
    say(`Run is ${(await browser.getRun(userId, run.id))?.status} (the agent is paused on a login page).`);

    const { handoff } = await service.createAndSend(userId, { runId: run.id, reason: 'login', idempotencyKey: `demo-link-${Date.now()}` });
    say('\nOpen the link above in YOUR browser (Chrome/Edge/Firefox), press "Continue", then in the remote view:');
    say('  1. click the Email field and send:  demo@example.com');
    say('  2. click the Password field, tick "Hide what I type", and send:  correct-horse');
    say('  3. press Enter, wait for "My account", then tap "I\'m done".');
    say('\nWaiting (Ctrl+C to abort)...');
    void printedLink;

    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      const row = await service.repo.getById(handoff.id);
      if (!row) break;
      if (['completed', 'expired', 'cancelled', 'failed'].includes(row.status)) {
        say(`\nHandoff finished: ${service.statusOf(row).label} (${row.status}${row.failureCode ? `, ${row.failureCode}` : ''})`);
        if (row.status === 'completed') {
          const step = await browser.step(userId, run.id, { kind: 'snapshot' }, (s) => s.snapshot());
          if (!step.replayed) say(`Agent resumed on: "${step.value.title}" (signed in: ${!step.value.state.loginRequired})`);
          const [conn] = await getDb().select().from(browserConnections).where(eq(browserConnections.userId, userId));
          say(`Stored session: ${conn?.status}, encrypted: ${conn?.encryptedState?.slice(0, 12)}... (${conn?.encryptedState?.length} chars, no plaintext)`);
        }
        break;
      }
    }
  } finally {
    await cleanup();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
