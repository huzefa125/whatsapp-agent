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
npm run db:generate
npm run db:migrate
```

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

> The existing WhatsApp reply path (`AgentOrchestrator` + outbox) is **not** routed through this engine yet.

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

> **Not wired yet:** inbound WhatsApp chat messages still go through the original reply path, not the agent engine. Reminders are reachable via `POST /api/reminders` and via `POST /api/agent/tasks`; routing WhatsApp conversations into the engine is a separate step.

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

`create_reminder`, `list_reminders`, `reschedule_reminder`, `cancel_reminder`, `complete_reminder`, registered in `createDefaultToolRegistry()`. Identity is the authenticated task owner; the tools have no user argument. Permissions: `reminders:read` / `reminders:write` (granted via `AGENT_DEFAULT_PERMISSIONS`). Each task's system prompt includes the user's current local time and timezone so "tomorrow" resolves correctly, and instructs the model to ask rather than guess. Reminders at 00:00–04:59 local or more than `REMINDER_CONFIRM_BEYOND_DAYS` ahead require the user's explicit confirmation (`POST /api/agent/tasks/:id/confirm`) before anything is written. Replayed tool calls and retried inbound messages (reuse the same task `idempotencyKey`, e.g. `wa:<wamid>`) never create a second reminder.

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
