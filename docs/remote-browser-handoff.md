# Secure Remote Browser Handoff (Phase 2)

Lets a user sign in, pass MFA, or complete a CAPTCHA **on their own device**, then lets the paused agent task resume.
The AI never sees credentials, codes, cookies, or the link. It is **off by default** (`BROWSER_HANDOFF_ENABLED=false`).

## How it works

```
Agent hits a login/CAPTCHA page
  -> browser_request_user_signin (tool)           model learns only: "link sent, end your turn"
  -> HandoffService.create: 256-bit token, store SHA-256 hash, revoke older links for the site
  -> existing WhatsApp notification service sends  https://<PUBLIC_BASE_URL>/handoff/<token>
User taps the link
  -> GET  /handoff/<token>          shows a page only (chat link-previews cannot burn the single use)
  -> POST /handoff/<token>/start    atomically redeems (single use) -> HttpOnly cookie, opens a SEPARATE remote browser
  -> /handoff/session/*             frame polling + input events (click, text, allowlisted keys, scroll) + CSRF header
User taps "I'm done"
  -> server reloads the page it is on, checks: signed in, no CAPTCHA/block, still on the approved site
  -> session saved ENCRYPTED (AES-256-GCM, bound to user + origin) in browser_connections
  -> run reattached to the connection, remote browser destroyed, agent task resumed in the same conversation
```

While a handoff is `pending` or `active`, the run's agent actions are rejected (`HANDOFF_IN_PROGRESS`). The agent resumes
only after the server verified the sign-in; the resume message is built from trusted server data (host and run id), never
from page content.

### States shown to the user
`Waiting for sign-in` (pending/active), `Connected`, `Expired`, `Cancelled`, `Failed`. Expiry, cancellation, failure and a
restart each notify the user exactly once.

### Token and session model
| Item | Detail |
|---|---|
| Link token | 32 random bytes (256-bit), base64url. Only its SHA-256 is stored. Single use (atomic compare-and-set). Default 10 min to open. |
| Browser-session secret | A second 256-bit secret in an `HttpOnly; SameSite=Strict; Path=/handoff` cookie (`Secure` on https). Only its hash is stored. |
| CSRF | Derived from the session secret (HMAC), sent as `X-CSRF-Token`; plus `Origin` and `Sec-Fetch-Site` checks. |
| Public URL | Contains only the token. No user id, run id, task id, origin or browser id. |
| Logs | `/handoff/<token>` is logged as `/handoff/[token]`; query strings, `params`, cookies, CSRF headers and request bodies are never logged. |
| Rate limits | Per-IP on link endpoints, per-sign-in on input and frames, per-user creation limit per hour. |

### What the remote browser can and cannot do
- Starts on the approved page; the user can only follow that site's own links. **No URL bar, no "open address" endpoint.**
- Main-frame navigation limited to the site (and subdomains) plus `BROWSER_HANDOFF_EXTRA_HOSTS` (explicit identity providers).
- All existing protections stay on: public-address-only DNS and connection checks, redirect validation, popups closed,
  downloads/dialogs/file pickers/WebSockets/service workers blocked, one isolated context per sign-in.
- One difference from agent runs, on purpose: form posts are allowed, because the *user* is the one acting (their own login).
- Input is limited to click (normalized coordinates), typed text (<= 200 chars), 13 named keys, and scroll. No shortcuts.
- Not bypassed: CAPTCHA, MFA, bot protection. A challenge the user cannot complete stays unfinished; "I'm done" is refused.

## Is the existing single-server, in-memory design safe enough?

**Yes for one instance, with these conditions. Not for several instances without changes.**

| Question | Assessment |
|---|---|
| Handoff requests must reach the process that holds the Chromium session | True for a single instance. With 2+ instances you need sticky routing (hash on the `hs` cookie) or a dedicated browser worker. |
| Restart | Remote browsers are lost. Active sign-ins are marked failed (`SERVER_RESTARTED`) and the user is told to ask again; unopened links stay valid. Agent runs resume from checkpoints as before. |
| Blast radius | Chromium shares the host with the app, its database credentials and the WhatsApp token. The renderer is sandboxed, but a browser escape would land next to those secrets, and egress filtering is only application-level. |
| Capacity | Each sign-in holds a Chromium context (~150-300 MB). Limits: `BROWSER_MAX_SESSIONS`, one per user. |

**Recommendation for production:** run the remote browser in a **separate worker container** and keep this app as the
authentication/relay tier.

- Worker: Chromium plus a thin internal API (`frame`, `input`, `complete -> returns storage state`). No database credentials,
  no `BROWSER_ENCRYPTION_KEY`, no WhatsApp tokens. Reached only over mTLS or a private network from the app.
- **Egress firewall on the worker** (the real SSRF control): allow only outbound TCP 80/443 to the public internet; deny
  RFC1918, `169.254.0.0/16` (cloud metadata), `100.64.0.0/10`, loopback, IPv6 ULA/link-local, and the app/DB subnets.
  Use a filtering DNS resolver that does not return private answers.
- The app keeps token, cookie, CSRF, rate limits and encryption; the worker only draws pixels and replays validated input.
  `HandoffService` already depends on a small surface (`manager.open/get/close`, `BrowserSession` methods), so this is a
  swap of that boundary, not a redesign. **Not implemented in this phase.**

## Deployment requirements (before enabling publicly)

1. **HTTPS only.** Terminate TLS at the reverse proxy; send HSTS. `PUBLIC_BASE_URL` must be the exact public `https://` origin
   (the app compares it with the `Origin` header). Production refuses to start with handoff enabled on a non-https URL.
2. **Proxy headers.** Set `TRUST_PROXY` to the number of proxies (1 behind nginx/ngrok/Cloudflare) so client IPs (rate limits)
   and HTTPS detection are correct. Never trust `X-Forwarded-*` from the open internet.
3. **Do not log or cache the token.** In the proxy/CDN, strip or hash the path for `/handoff/*` in access logs; disable caching
   for `/handoff/*` (the app already sends `Cache-Control: no-store`). Disable any "link scanning" that submits POSTs (the app
   already makes GET harmless).
4. **Cookies.** `Secure; HttpOnly; SameSite=Strict; Path=/handoff`. Prefer a dedicated subdomain (e.g. `handoff.example.com`)
   so the cookie never shares an origin with the API.
5. **CSRF/CORS.** Keep `CORS_ALLOWED_ORIGINS` empty for this origin. State-changing calls require the cookie, `X-CSRF-Token`, and a
   same-origin `Origin`/`Sec-Fetch-Site`.
6. **Headers.** Served by the app: strict nonce CSP (`default-src 'none'`), `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
   `Referrer-Policy: no-referrer`, `noindex`. Do not let the proxy override them.
7. **Isolation.** Run the app (or the future worker) as a non-root user, read-only filesystem except a tmp dir, memory/CPU
   limits, no `--no-sandbox`. See the worker/egress recommendation above.
8. **Do not expose** `/docs`, `/api/*` or any admin surface on the handoff hostname.
9. **Rotate** `BROWSER_ENCRYPTION_KEY` deliberately: existing stored sessions become unreadable and users reconnect.

**This phase does not deploy anything.** Exposing the handoff publicly needs explicit approval.

## Manual setup (local or staged)
```bash
# .env
BROWSER_ENABLED=true
BROWSER_ENCRYPTION_KEY=<npm run browser:genkey>
BROWSER_HANDOFF_ENABLED=true
PUBLIC_BASE_URL=https://<your tunnel or domain>     # ngrok works for staging
TRUST_PROXY=1
AGENT_DEFAULT_PERMISSIONS=utility:read,reminders:read,reminders:write,browser:*
npm run browser:install && npm run db:migrate && npm run dev
```
Remove `BROWSER_HANDOFF_ENABLED` (or set false) to make every `/handoff/*` route answer 404.

## Safe local demonstration (no WhatsApp, no real accounts)
```bash
npm run browser:handoff-demo
```
It starts a local test site (login `demo@example.com` / `correct-horse`), a throwaway user, and prints the link instead of
sending WhatsApp. Open the link in your own browser, sign in through the remote view, tap "I'm done". The script then shows
the agent resuming on the signed-in page and that the stored session is ciphertext. The user is deleted when it ends.

## Known limitations
- Popup-based SSO ("Sign in with Google" in a popup window) cannot work because popups are closed. Redirect-based SSO works if the
  identity-provider host is in `BROWSER_HANDOFF_EXTRA_HOSTS`.
- Frame polling (about 1 frame per second, faster after input) is simple and proxy-friendly but not smooth; no clipboard, no file
  upload, no audio, no hardware keys/passkeys. Authenticator-app, SMS and e-mail codes work (the user types them).
- A site that shows its login form even when signed in can make verification conservative; the check uses the page the user
  ends on, after a reload.
- Remote-browser input is relayed through this server in memory. It is never stored or logged, but it is not end-to-end encrypted
  from the user's phone to the website. This is inherent to any remote-browser design and is stated on the link page.
- Single instance only until a sticky route or the separate worker exists.
