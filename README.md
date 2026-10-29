# Instinct WhatsApp AI Agent

A production-grade, secure, and resilient WhatsApp-first AI agent backend foundation built to world-class engineering standards. Inspired by personal and business AI assistants like Instinct.

---

## 1. Architectural Highlights

- **Clean Architecture & Separation of Concerns**: Strict decoupling of controllers, services, database schemas, and HTTP middleware.
- **Strict TypeScript**: 100% strictly typed (`noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`, zero `any` types).
- **Cryptographic Security**: Constant-time HMAC-SHA256 verification (`crypto.timingSafeEqual`) on `X-Hub-Signature-256` using captured raw request body buffers. Fails closed in production.
- **Durable Event Storage & Idempotency**: Meta webhooks are ingested and persisted into PostgreSQL (`webhook_events`) and processed via an asynchronous Outbox (`outbox_jobs`) with unique provider message IDs to guarantee at-least-once delivery with idempotent execution.
- **Provider-Agnostic AI Layer**: Pluggable `AiProvider` interface supporting OpenAI, Groq, local LLMs, and an offline testing stub (`StubAiProvider`).
- **Prompt Injection Defense**: Boundary delimiter tagging (`<<<USER_INPUT>>>`), whitespace/null-byte sanitization, and strict system safety rules.
- **Relational Data Integrity**: Built on PostgreSQL and Drizzle ORM with foreign keys, cascade deletes, and composite indexes for user and conversation isolation.
- **Dual-Channel Passwordless Authentication**: Requires both verified WhatsApp phone (E.164) and verified email before issuing secure session bearer tokens. Uses purpose-bound keyed HMAC-SHA256 OTP hashes, rate limits, attempt locks, cooldowns, and replay protection.
- **Interactive Swagger / OpenAPI 3.0 Documentation**: Live interactive documentation served at `/docs` and raw machine-readable specification at `/docs.json`.
- **Observability**: Structured JSON logging powered by Pino with automated secret and credential redaction, request correlation IDs (`x-request-id`), and liveness/readiness health probes.

---

## 2. Technology Stack

- **Runtime**: Node.js >= 20.0.0
- **Language**: TypeScript 5.7+ (Strict Mode)
- **Framework**: Express.js 4.21+
- **Database**: PostgreSQL with Drizzle ORM
- **Validation**: Zod for configuration and runtime validation
- **Logging**: Pino & Pino HTTP (structured, redacted)
- **Security**: Helmet, Timing-safe Crypto, Express Rate Limit
- **Messaging API**: Official Meta WhatsApp Business Platform (Cloud API v21.0)
- **AI Models**: OpenAI (e.g. `gpt-4o-mini`) / Groq (`llama-3.3-70b-versatile`)
- **Testing**: Vitest, Supertest, V8 Coverage

---

## 3. Directory Layout

```
.
├── src/
│   ├── app.ts                  # Express application factory & security middleware
│   ├── server.ts               # HTTP bootstrap & graceful shutdown lifecycle
│   ├── index.ts                # Process entry point
│   ├── config/
│   │   ├── env.ts              # Zod environment schema & startup validator
│   │   └── index.ts
│   ├── controllers/
│   │   ├── health.controller.ts  # /health/live and /health/ready probes
│   │   └── webhook.controller.ts # Meta GET verification & POST event ingestion
│   ├── db/
│   │   ├── client.ts           # pg.Pool connection lifecycle & health ping
│   │   ├── schema.ts           # Drizzle schema (users, conversations, messages, jobs)
│   │   └── migrate.ts          # Programmatic migration runner
│   ├── middleware/
│   │   ├── raw-body.ts         # Raw Buffer preservation for cryptographic HMAC
│   │   ├── logging.ts          # Pino HTTP middleware with correlation IDs
│   │   ├── rate-limit.ts       # Express rate limiter
│   │   ├── error-handler.ts    # Centralized RFC 7807 error formatter
│   │   └── not-found.ts        # 404 route fallthrough
│   ├── routes/
│   │   ├── health.routes.ts
│   │   ├── webhook.routes.ts
│   │   └── index.ts
│   ├── services/
│   │   ├── agent/              # Prompt management, conversation history, orchestrator
│   │   ├── ai/                 # Replaceable AI provider implementations & stub
│   │   ├── queue/              # Durable PostgreSQL outbox queue with exponential backoff
│   │   └── whatsapp/           # Meta Graph API client, webhook parser, signature check
│   └── utils/
│       ├── crypto.ts           # Timing-safe HMAC verification
│       ├── errors.ts           # Typed error hierarchy (AppError, RateLimitError, etc.)
│       ├── logger.ts           # Pino structured logger with redaction
│       └── retry.ts            # Bounded exponential backoff with jitter
├── tests/
│   ├── unit/                   # Unit tests (crypto, config, whatsapp, ai, outbox, etc.)
│   └── integration/            # HTTP integration tests (routes, signatures, health)
├── drizzle/                    # Generated SQL migrations
├── docker-compose.yml          # Local PostgreSQL container
└── .env.example                # Environment variables template
```

---

## 4. Setup and Quick Start

### 4.1 Prerequisites
- Node.js >= 20.0.0
- npm >= 10.0.0
- Docker (optional, for local PostgreSQL)

### 4.2 Installation
```bash
git clone <repo-url>
cd instinct-whatsapp-ai-agent
npm install
```

### 4.3 Configure Environment
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Fill in the parameters (refer to section 5 for Meta WhatsApp credentials).

### 4.4 Start Local PostgreSQL
```bash
docker compose up -d
```

### 4.5 Run Database Migrations
```bash
npm run db:migrate        # development (tsx)
npm run build && npm run db:migrate:prod   # production build (node dist/db/migrate.js)
```
Migrations are never run automatically at startup. Run them as a single deploy step **before** starting the new version, from any directory (the folder is resolved relative to the code). They are applied in one transaction each, so a failed migration leaves the database unchanged, and re-running is a no-op. Use `npm run db:generate` only when you change `src/db/schema.ts`, and commit the generated SQL.

### 4.6 Start the Application
- **Development Mode** (with hot reload):
  ```bash
  npm run dev
  ```
- **Production Build & Run**:
  ```bash
  npm run build
  npm start
  ```

### 4.7 Dual-Channel Passwordless Authentication API

The application requires both a verified WhatsApp phone number and a verified email address before a session is issued.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth/start` | Initializes flow with `{ phoneNumber, email }`, normalizes to E.164, and returns `authFlowId`. |
| `POST` | `/api/auth/challenge/phone/send` | Dispatches 6-digit OTP to WhatsApp. Enforces 60s cooldown. |
| `POST` | `/api/auth/challenge/phone/verify` | Verifies WhatsApp OTP. Locks challenge after 3 failed attempts. |
| `POST` | `/api/auth/challenge/email/send` | Dispatches 6-digit OTP to Email. Enforces 60s cooldown. |
| `POST` | `/api/auth/challenge/email/verify` | Verifies Email OTP. When both channels are verified, issues a session bearer token. |
| `GET` | `/api/auth/me` | Returns user and session metadata (`Authorization: Bearer <sessionToken>`). |
| `POST` | `/api/auth/logout` | Revokes the active session token in the database. |

---

## 5. Meta WhatsApp Business Setup

1. **Meta Developer App**:
   - Go to [developers.facebook.com](https://developers.facebook.com).
   - Create a Business App and add the **WhatsApp** product.
2. **API Setup**:
   - Obtain your **Phone Number ID** and temporary/system user **Access Token**.
   - Copy these to `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_ACCESS_TOKEN` in `.env`.
3. **App Secret**:
   - In App Settings -> Basic, copy the **App Secret** to `WHATSAPP_APP_SECRET`.
4. **Configure Webhook**:
   - In WhatsApp -> Configuration, edit the Webhook URL.
   - Enter your public URL (e.g. `https://your-domain.com/webhook` or your ngrok tunnel).
   - Enter your chosen `WHATSAPP_VERIFY_TOKEN`.
   - Click "Verify and Save". Meta will send a `GET /webhook` challenge.
   - Subscribe to the `messages` webhook field.

---

## 6. Testing & Quality Assurance

Run the automated test suite:
```bash
npm test
```

Run test suite with V8 code coverage:
```bash
npm run test:coverage
```

Run TypeScript strict type checking:
```bash
npm run typecheck
```

---

## 7. Reliability and Delivery Guarantees

- **Webhook Ingestion**: Responds with `200 OK` promptly to Meta after durably saving the payload to `webhook_events`.
- **Idempotency Gate**: Deduplication checks both the `providerEventId` in `webhook_events` and `providerMessageId` in `messages` to prevent duplicate AI responses on retries or replay attacks.
- **Durable Outbox Queue**: Failed outgoing operations retry up to 3 times with exponential backoff before being safely marked `dead_letter` for operator inspection.
- **Graceful Shutdown**: Intercepts `SIGTERM` and `SIGINT`, drains in-flight HTTP requests, halts the outbox poller, and cleanly closes PostgreSQL connections.

---

## 8. Agent Task Engine

A reusable, durable, tool-using agent runtime in `src/services/agent/engine/`. Integrations (reminders, Gmail, Calendar, ...) plug in by registering tools; they never touch the loop.

> Inbound WhatsApp messages run through this engine (see section 10). The old `AgentOrchestrator` is no longer used by the webhook path.

### 8.1 How a task runs

1. `POST /api/agent/tasks` stores a `pending` task (and the user message, if a `conversationId` is given) and returns `202`.
2. A worker claims it atomically (`FOR UPDATE SKIP LOCKED`), takes a time-limited lease, and loops: **model call → validate every tool call → authorize → execute → sanitized result back to the model → final text**.
3. The transcript and every tool call are checkpointed in PostgreSQL after each step, so a restart resumes instead of starting over.
4. The final answer (and assistant message, if there is a conversation) is committed in one transaction.

Only the database is the source of truth; no in-memory queue or timer holds task state.

### 8.2 Task states

| State | Meaning | Moves to |
|---|---|---|
| `pending` | Waiting for a worker (`run_after` is the retry/backoff time) | `running`, `cancelled` |
| `running` | Claimed; owned by one execution (the *lease*) | `succeeded`, `failed`, `cancelled`, `pending` (transient failure or lease recovery), `awaiting_confirmation` |
| `awaiting_confirmation` | A tool needs the user's approval; nothing has been executed | `pending` (approved **or** rejected), `cancelled` (user cancel or expiry), `failed` |
| `succeeded` / `failed` / `cancelled` | Terminal | none |

Waiting for a human does not consume the retry budget (`AGENT_MAX_ATTEMPTS`).

### 8.3 API (all require `Authorization: Bearer <session>`)

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/agent/tasks` | `{ request, conversationId?, idempotencyKey? }` (or `Idempotency-Key` header). `202` new, `200` replay, `409` key reused with a different request |
| `GET` | `/api/agent/tasks` | `?status=&limit=&offset=`, newest first, caller's tasks only |
| `GET` | `/api/agent/tasks/:id` | Status, result/error, `pendingConfirmation` |
| `POST` | `/api/agent/tasks/:id/cancel` | Immediate for `pending`/`awaiting_confirmation`; cooperative for `running`; `409` if finished |
| `POST` | `/api/agent/tasks/:id/confirm` | `{ callId, decision: "approve" \| "reject" }` |

Another user's task or conversation always returns `404`.

### 8.4 Adding a tool

```ts
import { z } from 'zod';
import { ToolDefinition, ToolError, TransientToolError } from './services/agent/engine';

const input = z.object({ title: z.string().min(1).max(200), at: z.string().datetime() }).strict();

export const createReminderTool: ToolDefinition<z.infer<typeof input>, { id: string }> = {
  name: 'create_reminder',                       // stable snake_case; persisted in transcripts
  description: 'Creates a reminder for the user at a given time.',
  inputSchema: input,                            // also becomes the JSON Schema shown to the model
  permissions: ['reminders:write'],              // user must hold ALL of these
  sideEffect: 'idempotent',                      // 'none' | 'idempotent' | 'non_idempotent'
  requiresConfirmation: false,                   // REQUIRED true when sideEffect is 'non_idempotent'
  timeoutMs: 5000,
  retry: { maxRetries: 2, backoffMs: 500 },      // only TransientToolError is retried; never for non_idempotent
  describeCall: (i) => `Remind you "${i.title}" at ${i.at}`, // shown to the user on confirmation
  async execute(args, ctx) {
    // ctx.userId is trusted; ctx.idempotencyKey is stable per call — pass it to the external API.
    // Throw ToolError(code, message) for expected failures (the message is shown to the model).
    // Throw TransientToolError for retryable ones. Anything else is logged and hidden.
    return { id: await reminders.create(ctx.userId, args, ctx.idempotencyKey) };
  },
};
```

Register it in `createDefaultToolRegistry()` (`engine/task-service.ts`) with `.register(createReminderTool)`, and grant the permission to users (see 8.5). The registry rejects duplicate names, tools without permissions, and non-idempotent tools that skip confirmation or allow retries.

Rules the engine enforces **regardless of what the model says**: unknown tools and invalid arguments are rejected without execution; permissions are checked from server-side grants at execution time (and the model is only shown tools the user may call); confirmation-required tools never run until the authenticated user approves the exact arguments displayed; a call recorded as finished is never executed twice; a non-idempotent call interrupted mid-flight fails the task (`OUTCOME_UNKNOWN`) instead of being replayed.

### 8.5 Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_WORKER_ENABLED` | `true` | Run the worker in this process (multiple instances are safe) |
| `AGENT_POLL_INTERVAL_MS` | `2000` | Worker poll interval |
| `AGENT_MAX_TOOL_ROUNDS` | `5` | Model-requested tool rounds before the task fails |
| `AGENT_MAX_TOOL_CALLS_PER_ROUND` | `4` | Calls the model may request at once |
| `AGENT_MODEL_TIMEOUT_MS` | `60000` | Per model call (keep above `AI_TIMEOUT_MS`) |
| `AI_TIMEOUT_MS` | `30000` | HTTP timeout of the AI provider request |
| `AGENT_TASK_TIMEOUT_MS` | `120000` | Whole execution attempt |
| `AGENT_MAX_TOOL_OUTPUT_CHARS` | `4000` | Cap on tool output shown to the model (per-tool override available) |
| `AGENT_MAX_REQUEST_CHARS` / `AGENT_MAX_RESPONSE_CHARS` | `4000` | Request and final-answer caps |
| `AGENT_MAX_ATTEMPTS` | `3` | Executions per task (transient provider errors, lease recovery) |
| `AGENT_LEASE_SECONDS` | `60` | Worker lease; stale tasks are requeued after it expires |
| `AGENT_HISTORY_LIMIT` | `20` | Recent conversation turns given to the model |
| `AGENT_CONFIRMATION_TTL_MINUTES` | `30` | Unanswered confirmations are cancelled after this |
| `AGENT_DEFAULT_PERMISSIONS` | `utility:read,reminders:read,reminders:write` | Permissions of every fully verified user. There is no per-user grant table yet; implement `PermissionResolver` to add one |

The model must be served through an `AiProvider` that implements `generateWithTools` (OpenAI-compatible providers, including the Gemini endpoint, do; the stub answers without tools).

### 8.6 Testing the engine

`npm test` runs everything. DB-backed engine tests need a **dedicated** PostgreSQL database whose name contains `test` (they truncate the agent tables) and are skipped otherwise:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/whatsapp_test \
DATABASE_URL=$TEST_DATABASE_URL NODE_ENV=test npx tsx src/db/migrate.ts
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/whatsapp_test npm test
```

The model is always mocked; no paid API calls are made.

---

## 9. Reminders and Scheduling

One-time reminders, created through the REST API or by the agent (registered as tools in the Agent Task Engine), stored in PostgreSQL and delivered by a durable worker over the WhatsApp Business Platform.

> Reminders are reachable from WhatsApp chat (section 10), `POST /api/reminders` and `POST /api/agent/tasks`.

### 9.1 Using it

1. Set the user's timezone once (reminders are refused without it; the server timezone is never used):
   `PATCH /api/users/me {"timezone":"Asia/Kolkata"}` — IANA region names only (`IST`, `EST`, `+05:30` are rejected).
2. Create: `POST /api/reminders`

   ```json
   { "title": "Call the client", "when": { "kind": "local", "date": "2026-10-28", "time": "10:00" } }
   ```

   `when` is one of `{kind:"relative",amount,unit:"minutes"|"hours"}`, `{kind:"local",date,time,disambiguation?}` (wall-clock time in the user's timezone) or `{kind:"instant",at}` (ISO-8601 **with offset**). The response returns `remindAtLocal` ("Wed, 28 Oct 2026, 10:00 (Asia/Kolkata, UTC+05:30)") so the interpretation is always visible.
3. `GET /api/reminders?upcoming=true`, `GET /api/reminders/:id`, `PATCH /api/reminders/:id` (`{when}`, `{title}` or `{status:"completed"}`), `DELETE /api/reminders/:id` (cancels, keeps the record).

Nothing is guessed: a missing time, a past time, a date beyond `REMINDER_MAX_HORIZON_DAYS`, a time skipped by a DST jump (`NONEXISTENT_LOCAL_TIME`) or repeated by one (`AMBIGUOUS_LOCAL_TIME`, resolve with `disambiguation`) returns `422` with a code instead of a silent adjustment.

### 9.2 Status model

| `status` | Meaning |
|---|---|
| `scheduled` | Waiting for its time (also used between retries) |
| `processing` | A worker holds a lease and is delivering it |
| `sent` | **The provider accepted the send request.** This is not proof of delivery |
| `failed` | Permanent failure, retries exhausted, or WhatsApp later reported failure |
| `cancelled` / `completed` | User actions |

Delivery is reported separately in `delivery.state`: `not_sent` → `accepted_by_provider` → `delivered` (set only when WhatsApp's status webhook says so) or `failed`. `delivery.simulated: true` means the **mock** provider was used and nothing reached WhatsApp.

### 9.3 Scheduler design (`services/reminders/reminder-worker.ts`)

- **The table is the schedule.** `reminders.next_attempt_at` is what workers claim against; the poll timer only wakes the worker. A DB `CHECK (next_attempt_at >= remind_at)` plus the claim predicate `remind_at <= now` make early sending structurally impossible.
- **Claiming:** `SELECT … WHERE status='scheduled' AND next_attempt_at <= now FOR UPDATE SKIP LOCKED LIMIT 1`, then a compare-and-set to `processing` with a lease. Any number of workers/instances can run it.
- **Retries:** attempts are counted at claim. Retryable errors (timeouts, 5xx, rate limits, rejected credentials) back off 30 s → 2 min → 8 min → … (max 1 h; a provider retry-after hint is honoured) up to `REMINDER_MAX_ATTEMPTS`, then `failed/RETRIES_EXHAUSTED`. Permanent errors (invalid/undeliverable number, rejected template, closed window without a template) fail immediately.
- **Stale recovery:** a `processing` row whose lease expired is re-queued (or failed with `WORKER_LOST` when out of attempts); every write is fenced by the lease holder's ID so a late "zombie" cannot overwrite newer state.
- **Duplicates:** delivery is **at-least-once**. Once WhatsApp accepts a message its ID is stored and never re-sent, but WhatsApp has no idempotency key, so a crash or timeout *between* WhatsApp accepting the message and us recording it can produce one duplicate on retry. That trade-off was chosen deliberately: a missed reminder is worse than a repeated one.
- **Shutdown:** `stop()` halts polling and waits for the in-flight delivery.

### 9.4 WhatsApp rules

- Inside the 24-hour customer-service window (measured from the user's last *real* WhatsApp message) the reminder is sent as text.
- Outside it, an approved template is required: set `WHATSAPP_REMINDER_TEMPLATE_NAME` (one body variable `{{1}}` = reminder text) and `WHATSAPP_REMINDER_TEMPLATE_LANG`. Without one the reminder fails with `OUTSIDE_WINDOW_NO_TEMPLATE` (visible in `error`) rather than pretending to deliver.
- `REMINDER_PROVIDER=whatsapp` uses the real Cloud API; `mock` (the default outside production, rejected in production) only records locally.

### 9.5 Agent tools

`create_reminder`, `list_reminders`, `reschedule_reminder`, `cancel_reminder`, `complete_reminder`, `set_timezone`, registered in `createDefaultToolRegistry()`. Identity is the authenticated task owner; the tools have no user argument. Permissions: `reminders:read` / `reminders:write` (granted via `AGENT_DEFAULT_PERMISSIONS`). Each task's system prompt includes the user's current local time and timezone so "tomorrow" resolves correctly, and instructs the model to ask rather than guess. Reminders at 00:00–04:59 local or more than `REMINDER_CONFIRM_BEYOND_DAYS` ahead require the user's explicit confirmation (`POST /api/agent/tasks/:id/confirm`) before anything is written. Replayed tool calls and retried inbound messages (reuse the same task `idempotencyKey`, e.g. `wa:<wamid>`) never create a second reminder.

### 9.6 Running the worker

It runs inside the server process (`npm run dev` / `npm start`) when `REMINDER_WORKER_ENABLED=true` (default). Run extra instances freely; set it to `false` on instances that should only serve HTTP. Apply the migration first (`npm run db:migrate`, includes `0003_reminders`).

| Variable | Default | Purpose |
|---|---|---|
| `REMINDER_WORKER_ENABLED` | `true` | Run the scheduler in this process |
| `REMINDER_PROVIDER` | `whatsapp` in production, else `mock` | Delivery backend |
| `REMINDER_POLL_INTERVAL_MS` / `REMINDER_BATCH_SIZE` | `5000` / `10` | Polling cadence and per-pass cap |
| `REMINDER_LEASE_SECONDS` | `120` | Time before a silent worker's claim is recovered |
| `REMINDER_MAX_ATTEMPTS` | `5` | Delivery attempts |
| `REMINDER_SEND_TIMEOUT_MS` | `15000` | Per provider call |
| `REMINDER_MAX_TITLE_CHARS` / `REMINDER_MAX_HORIZON_DAYS` / `REMINDER_MIN_LEAD_SECONDS` | `500` / `365` / `5` | Input bounds |
| `REMINDER_MAX_ACTIVE_PER_USER` / `REMINDER_MAX_CREATES_PER_HOUR` | `100` / `30` | Per-user quotas (DB-enforced, global across instances) |
| `REMINDER_CONFIRM_BEYOND_DAYS` | `30` | Agent-created reminders further out need confirmation |
| `REMINDER_RATE_LIMIT_WINDOW_MS` / `REMINDER_RATE_LIMIT_MAX` | `60000` / `20` | Per-user write limiter (per process) |
| `WHATSAPP_REMINDER_TEMPLATE_NAME` / `_LANG` | unset / `en` | Approved template for out-of-window delivery |

Reminder code never logs the reminder text; its log lines carry `reminderId`, `executionId` and attempt number only, and the HTTP logger does not log request bodies. The one exception to be aware of: unexpected exceptions are logged with their stack, and a third-party error message could in principle embed text.

---

## 10. WhatsApp Chat Channel

Inbound WhatsApp text → `POST /webhook` (signature verified) → durable `webhook_events` + `outbox_jobs` (one transaction) → `WhatsAppChannel` → an `agent_tasks` row (`channel='whatsapp'`, idempotency key `wa:<wamid>`) → the Agent Task Engine (Gemini + tools) → `WhatsAppReplyDispatcher` sends the outcome back.

- **Who can talk to the agent:** only users who completed dual-channel registration (`/api/auth/*`). Any other number gets one fixed "please sign up" message; no model call, no account is created.
- **Conversation:** one active conversation per user; the last `AGENT_HISTORY_LIMIT` turns are given to the model, so follow-ups work. The model asks a clarifying question as a normal reply.
- **Confirmations:** risky actions (reminders at 00:00-04:59 local or > `REMINDER_CONFIRM_BEYOND_DAYS` away) pause the task and the user gets "Please confirm: ... Reply YES or NO". Only a whole-message YES/NO answers it; anything else gets a re-prompt. Unanswered confirmations are cancelled after `AGENT_CONFIRMATION_TTL_MINUTES` and the user is told.
- **Cancel:** sending just `cancel` or `stop` cancels the request being worked on.
- **Timezone:** the agent asks for it once and saves it with `set_timezone`.
- **Replies are durable:** the task row records which outcome was last announced (`reply_key`). Failed sends back off 5 s, 20 s, 80 s, ... up to `5` attempts; permanent errors (invalid number) stop immediately. Delivery is at-least-once.
- **24h window:** each inbound message is stored with its WhatsApp message id, which is what opens the window for free-text reminders. Outside it, reminders need the approved template (section 9.4).
- **Known limits:** two messages sent in quick succession run as two independent tasks (the second may not see the first's answer). Only text is handled; media gets no reply. Free-text only: no WhatsApp interactive buttons.

### Go-live checklist (external setup)

1. PostgreSQL that persists (managed DB or `docker compose up -d` with its volume) → set `DATABASE_URL`, run `npm run db:migrate:prod`.
2. `NODE_ENV=production`, real `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN` (permanent system-user token), `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN`, `AI_API_KEY`; `REMINDER_PROVIDER=whatsapp`.
3. Public HTTPS URL for `/webhook`; subscribe the app to the `messages` field.
4. Create and get approved a WhatsApp template with one body variable, set `WHATSAPP_REMINDER_TEMPLATE_NAME` / `_LANG`.
5. Email OTPs: set `EMAIL_PROVIDER=smtp` and `SMTP_HOST/PORT/USER/PASS/FROM` (the default `stub` sends nothing).
6. Register your own number through `/api/auth/*`. **Message the business number first** (any text): the phone OTP is sent as free text, which WhatsApp only allows inside the 24-hour window, so a number that has never written to you cannot receive its code. While the Meta app is in development mode, also add your number to the allowed recipients list.
7. Set your timezone by chatting ("remind me tomorrow at 10", the agent asks) or `PATCH /api/users/me`.

## 11. Browser Automation (Phase 1)

A reusable, security-first browser engine (Playwright + Chromium) that the agent drives through its normal tool registry.
It is **off by default** (`BROWSER_ENABLED=false`). Later phases (Gmail, calendars, travel, CRM...) build on it.

### Enabling it

```bash
npm run browser:install          # downloads Chromium once
npm run browser:genkey           # prints a key for BROWSER_ENCRYPTION_KEY (needed only to store website sign-ins)
# .env: BROWSER_ENABLED=true, BROWSER_ENCRYPTION_KEY=..., and add browser:* to AGENT_DEFAULT_PERMISSIONS
npm run db:migrate
```

### Architecture

```
WhatsApp / API  ->  Agent Engine (existing)  ->  browser_* tools  ->  BrowserService  ->  BrowserSession (Playwright)
                                                      |                     |                    |
                                              confirmation gate       browser_runs         network guard + URL policy
                                              (existing engine)       (checkpoints)        (SSRF, scope, mutation block)
```

- `src/services/browser/session.ts`: one isolated BrowserContext per run. Snapshot of visible text and interactive
  elements with server-issued **refs** (`e<generation>-<n>`); the model never supplies selectors or scripts.
- `browser-service.ts`: limits (steps, navigations, deadline), per-run serialization, checkpoints, replay protection,
  login/CAPTCHA/blocked detection (`waiting_for_user`), restart recovery.
- `browser-tools.ts`: 14 tools. Reads and low-risk interaction run directly. Anything that sends, books, buys, cancels,
  deletes or submits is only possible through `browser_perform_sensitive_action`, a `non_idempotent` tool that the
  engine runs only after the user confirms it.
- `connection-service.ts`: authorized websites; AES-256-GCM encrypted, bound to user + origin.

### Run states

`queued` -> `running` -> `completed | failed | cancelled`, and `waiting_for_user` (login, CAPTCHA, blocked). After a restart,
`running` runs return to `queued` and resume from their last checkpointed page (GET only; actions are never replayed).

### Security boundaries

| Concern | Control |
|---|---|
| SSRF / DNS rebinding | Every request (typed URL, redirect hop, sub-resource) is validated: http(s) only, no credentials, public addresses only (loopback, private, link-local, metadata, IPv4-mapped IPv6 refused), DNS answers re-checked, and the connected address is verified after the response. |
| Leaving the site | Main-frame navigation is limited to the start host and its subdomains; JS/meta redirects and popups are stopped. |
| Unconfirmed submissions | POST/PUT/PATCH/DELETE from a page is aborted unless a user-confirmed action is running (backstop against mislabelled buttons). |
| Confirmation binding | The user sees recipient, page, form values; approval is bound to a fingerprint of the element, page and every form value. Any change refuses the action (`ACTION_CHANGED`). |
| Prompt injection | Page text is labelled untrusted, hidden/tiny/transparent text is dropped, injected instructions are flagged, and none of it can grant permissions or skip confirmation. |
| Secrets | The assistant never types password, payment or one-time-code fields. Cookies/tokens are never given to the model and never logged; URLs are stored/logged as origin + path only. |
| Isolation | Runs, connections and sessions are always queried by `user_id`; no profile or cookie jar is shared. |
| Resources | Session caps (global and per user), request cap, step/navigation/time limits, idle sweeper; downloads, dialogs, file pickers, WebSockets, service workers and permissions are blocked. |

### Connecting a website (user signs in themselves)

```bash
npm run browser:connect -- --user <user-uuid> --url https://app.example.com --label "My CRM"
```

A real browser window opens; the user signs in (including CAPTCHA/2FA) and presses Enter. Only the session for that
site is kept, encrypted. `GET /api/browser/connections` lists them; `DELETE /api/browser/connections/:id` erases the
stored session and ends any live browser using it. An expired session is detected and the user is asked to reconnect.

### Manual test (no database, model or account needed)

```bash
npm run browser:demo                 # reads https://example.com and shows the safety guards refusing things
npm run browser:demo -- --local      # local test shop: forms, a "Send message" button that is refused without confirmation
```

### Tests

`tests/unit/browser-security.test.ts` (policy, SSRF, encryption, risk, redaction, fingerprints) and
`tests/integration/browser-{session,service,agent}.test.ts` (real Chromium against a local site that never touches the
internet). The DB-backed ones need `TEST_DATABASE_URL` (a database whose name contains "test"); all are skipped, not failed,
when Chromium or the test DB is missing.

## 12. Secure Remote Browser Handoff (Phase 2)

Lets a user sign in, pass MFA or complete a CAPTCHA on their own device through a short-lived, single-use link sent on
WhatsApp, after which the paused agent task resumes. Off by default (`BROWSER_HANDOFF_ENABLED=false`). The AI never sees the
link, credentials, codes or cookies; the session is stored encrypted. Full architecture, the single-server vs. separate-worker
evaluation, reverse-proxy/HTTPS/cookie/CSRF requirements and the safe local demo are in
[`docs/remote-browser-handoff.md`](docs/remote-browser-handoff.md).

```bash
npm run browser:handoff-demo     # local test site, printed link instead of WhatsApp, throwaway user
```

## 13. Gmail Integration (Phase 3)

Direct Google OAuth 2.0 and Gmail API integration. Plugs into the `IntegrationRegistry` so the agent automatically uses fast, structured API tools for email workflows instead of falling back to browser automation.

### 13.1 Security & Architecture Highlights

| Area | Implementation |
|---|---|
| **Least privilege scopes** | Read-only by default (`userinfo.email`, `gmail.readonly`). Write/send scopes (`gmail.send`, `gmail.compose`) are requested only when the user explicitly enables email sending. |
| **Google OAuth 2.0 + PKCE** | Uses Google's official authorization code flow with SHA-256 PKCE code challenges and randomized CSRF state tokens stored in DB with a 10-minute expiry and one-time use check. |
| **No credentials in WhatsApp** | Users are NEVER asked for passwords or verification codes in chat. The assistant generates a secure Google OAuth consent link for the user to authorize in their browser. |
| **Encrypted at rest** | Refresh tokens are encrypted using AES-256-GCM (`v1.<iv>.<tag>.<ciphertext>`) bound to the user's ID via authenticated additional data (`gmail:<userId>`). Access tokens are transient and auto-refreshed in memory. |
| **Duplicate send protection** | `gmail_send_draft` enforces `non_idempotent` classification, `requiresConfirmation=true`, zero automatic retries, and records sends in `gmail_send_log` with the engine's stable `idempotencyKey`. |
| **Draft-first workflow** | All email sends require creating a draft first (`gmail_draft` or `gmail_reply`). The agent presents recipient, subject, and body to the user for explicit confirmation before triggering `gmail_send_draft`. |
| **Prompt injection defense** | Email bodies are treated as untrusted data: control characters stripped, model delimiters (`<<<`, `>>>`) neutralized with zero-width spaces, and body lengths capped to prevent context overflow. |

### 13.2 Registered Tools

| Tool | Permission | Side Effect | Confirmation | Description |
|---|---|---|---|---|
| `gmail_search` | `gmail:read` | `none` | No | Search inbox with standard Gmail operators (`from:`, `is:unread`, etc.) |
| `gmail_read` | `gmail:read` | `none` | No | Read email headers and sanitized plain text body |
| `gmail_summarize_thread` | `gmail:read` | `none` | No | Fetch all messages in a thread for conversation summarization |
| `gmail_draft` | `gmail:write` | `idempotent` | No | Create an email draft without sending |
| `gmail_send_draft` | `gmail:send` | `non_idempotent` | **Yes** | Send an approved draft; idempotency-protected |
| `gmail_reply` | `gmail:write` | `idempotent` | No | Create a reply draft matching thread and subject |
| `gmail_list_thread` | `gmail:read` | `none` | No | List thread metadata and participants |
| `gmail_status` | `gmail:read` | `none` | No | Check account connection status and linked address |

### 13.3 Configuration

```env
GMAIL_ENABLED=true
GMAIL_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=your-google-client-secret
GMAIL_REDIRECT_URI=http://localhost:3000/api/gmail/oauth/callback
GMAIL_ENCRYPTION_KEY=<32-byte-base64-key>
```

## 14. Workflow Memory System (Phase 4)

Persistent memory system that enables the WhatsApp AI agent to remember user-approved preferences, reusable workflows, non-sensitive facts, and project context across conversations.

### 14.1 Key Architecture & Safety Features

| Area | Implementation |
|---|---|
| **Categories** | `preference` (communication style/formatting), `workflow` (reusable procedures for recurring tasks), `fact` (user-approved facts), and `project_context` (project-scoped notes). |
| **Approval Flow** | Explicit user requests to remember something are saved as `approvalState: 'approved'` and immediately active. Inferred suggestions are saved as `pending_approval` and require explicit user consent before becoming active. |
| **Context Injection** | Relevant, active, approved memories are queried before model execution and injected as a clearly separated section in the system prompt. Memories are treated as untrusted contextual data and cannot override system policies or confirmation gates. |
| **Safe Fallback** | If memory retrieval fails or database is unavailable, the agent fails open and continues answering the user's task without interruption. |
| **Secret Detection** | Automated regex scanner blocks saving passwords, private keys, AWS keys, GitHub tokens, OpenAI keys, Google tokens, and OTP codes into memory. |
| **Prompt Injection Protection** | Null bytes and control characters are stripped. Prompt delimiters (`<<<` / `>>>`) are neutralized with zero-width spaces (`\u200B`). External emails or websites cannot trigger silent memory creation. |
| **Strict User Isolation** | Every query and mutation enforces `WHERE user_id = :userId`. A user can never read, modify, or delete another user's memories. |
| **Immediate Exclusion & Deletion Confirmation** | Deleted memories are immediately excluded from all searches. Deletion (`memory_delete`) enforces `requiresConfirmation: true` and supports single memory deletion or bulk "forget all". |

### 14.2 Registered Tools

| Tool | Permission | Side Effect | Confirmation | Description |
|---|---|---|---|---|
| `memory_save` | `memory:write` | `idempotent` | No | Save preference, workflow, fact, or project context (inferred = pending approval) |
| `memory_search` | `memory:read` | `none` | No | Search user's approved memories by keyword or phrase |
| `memory_list` | `memory:read` | `none` | No | List memories with pagination and category/status filters |
| `memory_update` | `memory:write` | `idempotent` | No | Update memory title, content, project, or approval state |
| `memory_delete` | `memory:write` | `non_idempotent` | **Yes** | Delete a specific memory or bulk-delete all memories |

### 14.3 Configuration

```env
MEMORY_ENABLED=true
MEMORY_MAX_RETRIEVED=5
MEMORY_MAX_CONTEXT_CHARS=2500
MEMORY_DEFAULT_EXPIRY_DAYS=0
```
