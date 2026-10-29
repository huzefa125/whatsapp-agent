import crypto from 'crypto';
import type { Browser, BrowserContext, Locator, Page, Request, Response, Route } from 'playwright';
import { logger } from '../../utils/logger';
import { scrubText } from '../agent/engine/sanitize';
import { describePageFunction, elementTextPageFunction, extractPageFunction, retargetLinkPageFunction, REF_ATTRIBUTE, REF_PATTERN, SENSITIVE_AUTOCOMPLETE_SOURCE, SENSITIVE_NAME_SOURCE, SNAPSHOT_EXPRESSION } from './page-scripts';
import { hostInScope, UrlPolicy, UrlPolicyError } from './policy';
import { describeError, redactText, redactUrl } from './redact';
import { classifyClick, computeFingerprint, detectPromptInjection, findSignals } from './risk';
import type {
  ActionClassification,
  ActionEvidence,
  ElementDetails,
  ElementInfo,
  PageSnapshot,
  PageState,
} from './types';

export type SessionErrorCode =
  | 'NAVIGATION_FAILED'
  | 'NAVIGATION_TIMEOUT'
  | 'UNSAFE_TARGET'
  | 'OUT_OF_SCOPE'
  | 'STALE_ELEMENT'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_NOT_ACTIONABLE'
  | 'SENSITIVE_FIELD'
  | 'USE_SENSITIVE_ACTION'
  | 'SUBMISSION_BLOCKED'
  | 'ACTION_CHANGED'
  | 'WAIT_TIMEOUT'
  | 'RESOURCE_LIMIT'
  | 'SESSION_CLOSED'
  | 'INVALID_INPUT';

/** Expected browser failure. The message is written for the model: no page content, no URLs with queries. */
export class BrowserSessionError extends Error {
  constructor(
    public readonly code: SessionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'BrowserSessionError';
  }
}

export interface SessionConfig {
  navTimeoutMs: number;
  actionTimeoutMs: number;
  maxText: number;
  maxElements: number;
  /** Abort POST/PUT/PATCH/DELETE from the page unless a confirmed action is running. */
  blockUnconfirmedMutations: boolean;
  /** Hard cap on requests per session (runaway pages, request loops). */
  maxRequests: number;
}

export interface StorageState {
  cookies: Array<Record<string, unknown>>;
  origins: Array<Record<string, unknown>>;
}

export interface SessionOptions {
  browser: Browser;
  policy: UrlPolicy;
  scopeHost: string;
  config: SessionConfig;
  storageState?: StorageState | undefined;
}

export interface NavigationResult {
  status: number | null;
  url: string;
}

export interface ActionResult {
  navigated: boolean;
  urlBefore: string;
  urlAfter: string;
  /** Data-changing requests the page tried to make that were blocked because no confirmed action was running. */
  blockedMutations: number;
  mutationStatuses: number[];
  /** Pages the site tried to open (popups) that were closed. */
  popupsClosed: number;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const TRANSIENT_NAV_ERRORS = /(is interrupted by another navigation|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE|ERR_NETWORK_CHANGED|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_HTTP2_PROTOCOL_ERROR)/;
const LOGIN_PATH = /(^|\/)(log-?in|sign-?in|signin|sso|auth|authenticate|account\/login)(\/|$|\.)/i;
const CAPTCHA_TEXT = /(verify (that )?you('re| are) (a )?human|are you a robot|complete the captcha|solve the captcha|security check to continue|checking your browser)/i;
const BLOCKED_TEXT = /(access denied|you (have been|are) blocked|request blocked|unusual traffic|too many requests|forbidden|not authorized to view)/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class BrowserSession {
  private context!: BrowserContext;
  private page!: Page;
  private generation = 0;
  private lastStatus: number | null = null;
  private mutationWindow = false;
  private mutationResponses: number[] = [];
  private blockedMutations: Array<{ method: string; url: string }> = [];
  private blockedNavigations: string[] = [];
  private popupsClosed = 0;
  private requestCount = 0;
  private addressViolation = false;
  private closed = false;
  navigationCount = 0;
  lastActivityAt = Date.now();

  private constructor(
    private readonly opts: SessionOptions,
    readonly scopeHost: string
  ) {}

  static async open(opts: SessionOptions): Promise<BrowserSession> {
    const session = new BrowserSession(opts, opts.scopeHost);
    await session.init();
    return session;
  }

  private get cfg(): SessionConfig {
    return this.opts.config;
  }

  private async init(): Promise<void> {
    const { browser, config, storageState } = this.opts;
    this.context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      acceptDownloads: false,
      serviceWorkers: 'block',
      permissions: [],
      locale: 'en-US',
      ...(storageState ? { storageState: storageState as never } : {}),
    });
    this.context.setDefaultTimeout(config.actionTimeoutMs);
    this.context.setDefaultNavigationTimeout(config.navTimeoutMs);

    await this.context.route('**/*', (route) => this.onRoute(route));
    // WebSockets bypass request routing, so they are not allowed at all in this phase.
    await this.context.routeWebSocket(/.*/, (ws) => {
      void ws.close();
    });

    this.page = await this.context.newPage();
    this.page.on('framenavigated', (frame) => {
      if (frame === this.page.mainFrame()) this.navigationCount++;
    });
    this.page.on('response', (response) => void this.onResponse(response));
    // Native dialogs would freeze the page; downloads and file pickers are never accepted.
    this.page.on('dialog', (dialog) => void dialog.dismiss().catch(() => undefined));
    this.page.on('download', (download) => void download.cancel().catch(() => undefined));
    this.page.on('filechooser', () => undefined);
    this.context.on('page', (popup) => {
      if (popup === this.page) return;
      this.popupsClosed++;
      void popup.close().catch(() => undefined);
    });
  }

  // ------------------------------------------------------------------------------------ network guard

  private async onRoute(route: Route): Promise<void> {
    const request: Request = route.request();
    const urlString = request.url();
    try {
      if (this.closed) return await route.abort('blockedbyclient');
      this.requestCount++;
      if (this.requestCount > this.cfg.maxRequests) return await route.abort('blockedbyclient');

      const isMainNavigation = request.isNavigationRequest() && request.frame() === this.page.mainFrame();
      try {
        await this.opts.policy.validate(urlString, isMainNavigation ? { scopeHost: this.scopeHost } : {});
      } catch (err) {
        if (isMainNavigation) this.blockedNavigations.push(redactUrl(urlString) || '[url]');
        logger.warn(
          { code: err instanceof UrlPolicyError ? err.code : 'POLICY_ERROR', url: redactUrl(urlString), mainFrame: isMainNavigation },
          'Browser request blocked by URL policy'
        );
        return await route.abort('blockedbyclient');
      }

      const method = request.method().toUpperCase();
      if (this.cfg.blockUnconfirmedMutations && !SAFE_METHODS.has(method)) {
        // Data may only leave through a confirmed action, and only to the site the user is working on.
        const sameSite = hostInScope(new URL(urlString).hostname, this.scopeHost);
        if (!this.mutationWindow || !sameSite) {
          this.blockedMutations.push({ method, url: redactUrl(urlString) });
          logger.warn({ method, url: redactUrl(urlString) }, 'Browser blocked a data-changing request without a confirmed action');
          return await route.abort('blockedbyclient');
        }
      }
      await route.continue();
    } catch (err) {
      // The page may have been closed mid-request; nothing to recover.
      logger.debug({ err: describeError(err) }, 'Route handler error');
      await route.abort('failed').catch(() => undefined);
    }
  }

  private async onResponse(response: Response): Promise<void> {
    try {
      const request = response.request();
      const method = request.method().toUpperCase();
      if (request.isNavigationRequest() && request.frame() === this.page.mainFrame()) {
        this.lastStatus = response.status();
      }
      if (this.mutationWindow && !SAFE_METHODS.has(method)) this.mutationResponses.push(response.status());

      // Second line of defence against DNS rebinding: the address the browser ACTUALLY connected to.
      const server = await response.serverAddr();
      if (server) {
        try {
          this.opts.policy.assertRemoteAddressPublic(server.ipAddress);
        } catch {
          this.addressViolation = true;
          logger.error({ url: redactUrl(request.url()) }, 'Browser connected to a private address; session will be stopped');
        }
      }
    } catch {
      // response already disposed
    }
  }

  private assertUsable(): void {
    if (this.closed) throw new BrowserSessionError('SESSION_CLOSED', 'The browser session is closed.');
    if (this.addressViolation) {
      throw new BrowserSessionError('UNSAFE_TARGET', 'The page resolved to a private network address and was stopped.');
    }
    if (this.requestCount > this.cfg.maxRequests) {
      throw new BrowserSessionError('RESOURCE_LIMIT', 'The page made too many requests and was stopped.');
    }
    this.lastActivityAt = Date.now();
  }

  // ------------------------------------------------------------------------------------- navigation

  get currentUrl(): string {
    return redactUrl(this.page.url());
  }

  async goto(rawUrl: string): Promise<NavigationResult> {
    this.assertUsable();
    let url: URL;
    try {
      url = await this.opts.policy.validate(rawUrl, { scopeHost: this.scopeHost });
    } catch (err) {
      throw this.mapPolicyError(err);
    }

    this.blockedNavigations = [];
    let response: Response | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await this.page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: this.cfg.navTimeoutMs });
        break;
      } catch (err) {
        if (this.blockedNavigations.length > 0) {
          throw new BrowserSessionError('OUT_OF_SCOPE', 'The site redirected somewhere that is not allowed, so navigation was stopped.');
        }
        const message = err instanceof Error ? err.message : '';
        // Only a plain GET navigation is retried, and only for transient network failures.
        if (attempt < 2 && TRANSIENT_NAV_ERRORS.test(message)) {
          await sleep(300 * 2 ** attempt);
          continue;
        }
        if (/Timeout/i.test(message)) throw new BrowserSessionError('NAVIGATION_TIMEOUT', 'The page took too long to load.');
        throw new BrowserSessionError('NAVIGATION_FAILED', `The page could not be loaded (${describeError(err)}).`);
      }
    }
    await this.settle();
    await this.verifyLocation();
    this.assertUsable();
    return { status: response?.status() ?? this.lastStatus, url: this.currentUrl };
  }

  /** Waits for the page to stop loading, bounded. Event-driven; no fixed sleeps. */
  private async settle(maxIdleMs = 3000): Promise<void> {
    await this.page.waitForLoadState('domcontentloaded', { timeout: this.cfg.navTimeoutMs }).catch(() => undefined);
    await this.page.waitForLoadState('networkidle', { timeout: maxIdleMs }).catch(() => undefined);
  }

  /** The browser must never be left on a page outside the run's scope (JS redirects, meta refresh). */
  private async verifyLocation(): Promise<void> {
    const current = this.page.url();
    if (current === 'about:blank' || current.startsWith('chrome-error://')) return;
    try {
      await this.opts.policy.validate(current, { scopeHost: this.scopeHost });
    } catch (err) {
      await this.page.goto('about:blank').catch(() => undefined);
      throw this.mapPolicyError(err);
    }
  }

  private mapPolicyError(err: unknown): BrowserSessionError {
    if (err instanceof UrlPolicyError) {
      const code = err.code === 'OUT_OF_SCOPE' ? 'OUT_OF_SCOPE' : 'UNSAFE_TARGET';
      return new BrowserSessionError(code, err.message);
    }
    return new BrowserSessionError('NAVIGATION_FAILED', 'The URL could not be checked.');
  }

  // ---------------------------------------------------------------------------------------- snapshot

  async snapshot(opts: { maxText?: number; maxElements?: number } = {}): Promise<PageSnapshot> {
    this.assertUsable();
    this.generation++;
    const raw = (await this.page.evaluate(
      SNAPSHOT_EXPRESSION({
        generation: this.generation,
        maxElements: opts.maxElements ?? this.cfg.maxElements,
        maxText: opts.maxText ?? this.cfg.maxText,
        sensitiveName: SENSITIVE_NAME_SOURCE,
        sensitiveAutocomplete: SENSITIVE_AUTOCOMPLETE_SOURCE,
      })
    )) as {
      title: string;
      text: string;
      headings: string[];
      elements: ElementInfo[];
      truncated: boolean;
      hints: { passwordVisible: boolean; textInputVisible: boolean; captchaFrame: boolean };
    };

    const url = this.currentUrl;
    const path = (() => {
      try {
        return new URL(this.page.url()).pathname;
      } catch {
        return '';
      }
    })();
    const status = this.lastStatus;
    const reasons: string[] = [];

    const loginRequired =
      raw.hints.passwordVisible || (LOGIN_PATH.test(path) && raw.hints.textInputVisible);
    if (loginRequired) reasons.push('a sign-in form is shown');
    const captcha = raw.hints.captchaFrame || CAPTCHA_TEXT.test(raw.text.slice(0, 1500)) || /^just a moment/i.test(raw.title);
    if (captcha) reasons.push('a CAPTCHA or bot check is shown');
    const blocked =
      (status !== null && [401, 403, 429, 451].includes(status) && (BLOCKED_TEXT.test(`${raw.title} ${raw.text.slice(0, 800)}`) || raw.text.length < 400)) ||
      BLOCKED_TEXT.test(raw.title);
    if (blocked) reasons.push(`the site refused access${status ? ` (HTTP ${status})` : ''}`);

    const state: PageState = { loginRequired, captcha, blocked, httpStatus: status, reasons };
    const joined = `${raw.title}\n${raw.text}\n${raw.elements.map((e) => e.name).join('\n')}`;

    return {
      generation: this.generation,
      url,
      title: scrubText(raw.title),
      text: scrubText(raw.text),
      headings: raw.headings.map(scrubText),
      elements: raw.elements.map((e) => ({ ...e, name: scrubText(e.name) })),
      truncated: raw.truncated,
      state,
      suspectedInjection: detectPromptInjection(joined),
    };
  }

  // ------------------------------------------------------------------------------------------ elements

  private locate(ref: string): Locator {
    if (!REF_PATTERN.test(ref)) {
      throw new BrowserSessionError('INVALID_INPUT', 'That is not a valid element ref. Use a ref from the latest snapshot.');
    }
    const generation = Number(ref.slice(1, ref.indexOf('-')));
    if (generation !== this.generation) {
      throw new BrowserSessionError('STALE_ELEMENT', 'That ref is from an older view of the page. Take a new snapshot and use its refs.');
    }
    return this.page.locator(`[${REF_ATTRIBUTE}="${ref}"]`);
  }

  /** Describes what the element IS right now (re-derived from the live page, never from an old snapshot). */
  async describeElement(ref: string): Promise<ElementDetails & { visible: boolean; sensitive: boolean }> {
    this.assertUsable();
    const locator = this.locate(ref);
    if ((await locator.count()) !== 1) {
      throw new BrowserSessionError('ELEMENT_NOT_FOUND', 'That element is no longer on the page. Take a new snapshot.');
    }
    const raw = (await locator.evaluate(describePageFunction, {
      sensitiveName: SENSITIVE_NAME_SOURCE,
      sensitiveAutocomplete: SENSITIVE_AUTOCOMPLETE_SOURCE,
    }).catch(() => {
      throw new BrowserSessionError('ELEMENT_NOT_FOUND', 'That element is no longer on the page. Take a new snapshot.');
    })) as {
      role: string; name: string; tag: string; type: string; href: string | null; disabled: boolean; visible: boolean;
      sensitive: boolean; form: ElementDetails['form']; origin: string; path: string;
    };

    const base = {
      pageOrigin: raw.origin,
      pagePath: raw.path,
      role: raw.role,
      name: scrubText(raw.name),
      tag: raw.tag,
      type: raw.type,
      href: raw.href,
      form: raw.form,
    };
    return {
      ref,
      ...base,
      disabled: raw.disabled,
      visible: raw.visible,
      sensitive: raw.sensitive,
      fingerprint: computeFingerprint(base),
    };
  }

  classify(details: ElementDetails): ActionClassification {
    return classifyClick(details);
  }

  // --------------------------------------------------------------------------------------------- actions

  /**
   * Clicks an element. Anything classified as sensitive is refused unless `confirmed` is set, which only the
   * confirmation-gated tool does, after the user approved this exact fingerprint.
   */
  async click(ref: string, opts: { confirmed?: boolean; expectedFingerprint?: string } = {}): Promise<ActionResult> {
    const details = await this.describeElement(ref);
    if (!details.visible || details.disabled) {
      throw new BrowserSessionError('ELEMENT_NOT_ACTIONABLE', 'That element is hidden or disabled.');
    }
    if (opts.expectedFingerprint && details.fingerprint !== opts.expectedFingerprint) {
      throw new BrowserSessionError(
        'ACTION_CHANGED',
        'The page or the form values changed after the user was asked to confirm. Nothing was done. Inspect the action again and ask for a new confirmation.'
      );
    }
    const classification = classifyClick(details);
    if (classification.risk === 'sensitive' && !opts.confirmed) {
      throw new BrowserSessionError(
        'USE_SENSITIVE_ACTION',
        `This click is consequential (${classification.category}). Use browser_inspect_action and then browser_perform_sensitive_action so the user can confirm it.`
      );
    }
    return this.performClick(ref, details, opts.confirmed === true);
  }

  private async performClick(ref: string, details: ElementDetails, confirmed: boolean): Promise<ActionResult> {
    const locator = this.locate(ref);
    const urlBefore = this.currentUrl;
    const blockedBefore = this.blockedMutations.length;
    const navBefore = this.navigationCount;
    const popupsBefore = this.popupsClosed;
    this.mutationResponses = [];
    this.mutationWindow = confirmed;

    // Links that open a new tab are loaded in this tab instead: popups are closed, never followed.
    if (details.tag === 'a') {
      await locator.evaluate(retargetLinkPageFunction, undefined).catch(() => undefined);
    }
    const navigation = this.page
      .waitForEvent('framenavigated', { timeout: 1500, predicate: (f) => f === this.page.mainFrame() })
      .catch(() => null);

    try {
      try {
        await locator.click({ timeout: this.cfg.actionTimeoutMs, noWaitAfter: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        if (/Timeout/i.test(message)) {
          throw new BrowserSessionError(
            'ELEMENT_NOT_ACTIONABLE',
            'The element could not be clicked (it may be covered, moving, or not clickable). Take a new snapshot before trying anything else.'
          );
        }
        throw new BrowserSessionError('ELEMENT_NOT_FOUND', 'That element is no longer on the page. Take a new snapshot.');
      }
      await navigation;
      await this.settle(confirmed ? 6000 : 3000);
    } finally {
      this.mutationWindow = false;
    }
    await this.verifyLocation();
    this.assertUsable();

    const blocked = this.blockedMutations.length - blockedBefore;
    if (blocked > 0 && !confirmed) {
      throw new BrowserSessionError(
        'SUBMISSION_BLOCKED',
        'That click tried to send data to the website and was blocked because the user has not confirmed it. Use browser_inspect_action then browser_perform_sensitive_action.'
      );
    }
    return {
      navigated: this.navigationCount > navBefore,
      urlBefore,
      urlAfter: this.currentUrl,
      blockedMutations: blocked,
      mutationStatuses: [...this.mutationResponses],
      popupsClosed: this.popupsClosed - popupsBefore,
    };
  }

  /** Gathers what the page shows after an action, so success is judged from evidence and never assumed. */
  async collectEvidence(result: ActionResult): Promise<ActionEvidence> {
    this.assertUsable();
    const body = this.page.locator('body');
    const excerpt = (await body
      .evaluate(elementTextPageFunction, { maxText: 600 })
      .catch(() => '')) as string;
    const alertText = (await this.page
      .locator('[role=alert],[aria-live=assertive],.error,.alert-danger,.alert-error')
      .allInnerTexts()
      .catch(() => [] as string[])).join(' ');
    let path = '';
    try {
      path = new URL(this.page.url()).pathname;
    } catch {
      /* about:blank */
    }
    const signals = findSignals(excerpt, path);
    const alertSignals = findSignals(alertText, '').error;
    return {
      urlBefore: result.urlBefore,
      urlAfter: result.urlAfter,
      titleAfter: scrubText(await this.page.title().catch(() => '')),
      mutationStatuses: result.mutationStatuses,
      navigated: result.navigated,
      successSignals: signals.success,
      errorSignals: [...signals.error, ...alertSignals],
      excerpt: redactText(excerpt, 300),
    };
  }

  async fill(ref: string, value: string): Promise<{ filledChars: number }> {
    if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) {
      throw new BrowserSessionError('INVALID_INPUT', 'The text is too long or contains control characters.');
    }
    const details = await this.describeElement(ref);
    if (details.sensitive) {
      throw new BrowserSessionError(
        'SENSITIVE_FIELD',
        'This field takes a password, payment detail or one-time code. The assistant never types those. Ask the user to complete that step themselves.'
      );
    }
    if (!details.visible || details.disabled) {
      throw new BrowserSessionError('ELEMENT_NOT_ACTIONABLE', 'That field is hidden or disabled.');
    }
    if (details.role !== 'textbox' && details.role !== 'searchbox') {
      throw new BrowserSessionError('INVALID_INPUT', 'That element is not a text field.');
    }
    try {
      await this.locate(ref).fill(value, { timeout: this.cfg.actionTimeoutMs });
    } catch {
      throw new BrowserSessionError('ELEMENT_NOT_ACTIONABLE', 'The field could not be filled. Take a new snapshot.');
    }
    return { filledChars: value.length };
  }

  async select(ref: string, option: string): Promise<{ selected: string }> {
    const details = await this.describeElement(ref);
    if (details.sensitive || details.role !== 'combobox' && details.role !== 'listbox') {
      throw new BrowserSessionError('INVALID_INPUT', 'That element is not a dropdown the assistant may change.');
    }
    const locator = this.locate(ref);
    try {
      await locator.selectOption({ label: option }, { timeout: this.cfg.actionTimeoutMs });
    } catch {
      try {
        await locator.selectOption(option, { timeout: 2000 });
      } catch {
        throw new BrowserSessionError('ELEMENT_NOT_ACTIONABLE', 'That option does not exist in the dropdown.');
      }
    }
    return { selected: option.slice(0, 80) };
  }

  async setChecked(ref: string, checked: boolean): Promise<{ checked: boolean }> {
    const details = await this.describeElement(ref);
    if (details.role !== 'checkbox' && details.role !== 'radio' && details.role !== 'switch') {
      throw new BrowserSessionError('INVALID_INPUT', 'That element is not a checkbox or radio button.');
    }
    if (details.disabled || !details.visible) {
      throw new BrowserSessionError('ELEMENT_NOT_ACTIONABLE', 'That control is hidden or disabled.');
    }
    try {
      await this.locate(ref).setChecked(checked, { timeout: this.cfg.actionTimeoutMs });
    } catch {
      throw new BrowserSessionError('ELEMENT_NOT_ACTIONABLE', 'The control could not be changed. Take a new snapshot.');
    }
    return { checked };
  }

  // ------------------------------------------------------------------------------------- waiting & reading

  async waitFor(cond: {
    text?: string | undefined;
    textGone?: string | undefined;
    urlContains?: string | undefined;
    state?: 'load' | 'networkidle' | undefined;
    timeoutMs: number;
  }): Promise<{ matched: true }> {
    this.assertUsable();
    const timeout = Math.min(Math.max(cond.timeoutMs, 500), 15000);
    try {
      if (cond.text) await this.page.getByText(cond.text).first().waitFor({ state: 'visible', timeout });
      if (cond.textGone) await this.page.getByText(cond.textGone).first().waitFor({ state: 'hidden', timeout });
      if (cond.urlContains) {
        const needle = cond.urlContains;
        await this.page.waitForURL((u) => u.pathname.includes(needle), { timeout });
      }
      if (cond.state) await this.page.waitForLoadState(cond.state, { timeout });
    } catch {
      throw new BrowserSessionError('WAIT_TIMEOUT', 'The condition was not met in time.');
    }
    await this.verifyLocation();
    return { matched: true };
  }

  async extract(what: 'text' | 'links' | 'tables', ref?: string): Promise<unknown> {
    this.assertUsable();
    const target = ref ? this.locate(ref) : this.page.locator('body');
    if (ref && (await target.count()) !== 1) {
      throw new BrowserSessionError('ELEMENT_NOT_FOUND', 'That element is no longer on the page. Take a new snapshot.');
    }
    if (what === 'text') {
      return scrubText(await target.evaluate(elementTextPageFunction, { maxText: this.cfg.maxText }));
    }
    return target.evaluate(extractPageFunction, { what, limit: 40 });
  }

  /** The image stays in memory; callers get a hash and size unless a later phase stores evidence deliberately. */
  async screenshot(): Promise<{ bytes: Buffer; sha256: string }> {
    this.assertUsable();
    const bytes = await this.page.screenshot({ type: 'png', fullPage: false, timeout: this.cfg.actionTimeoutMs });
    return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  }

  async storageState(): Promise<StorageState> {
    return (await this.context.storageState()) as unknown as StorageState;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => undefined);
  }
}
