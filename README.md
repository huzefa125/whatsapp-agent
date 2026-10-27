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
| `AGENT_MODEL_TIMEOUT_MS` | `30000` | Per model call |
| `AGENT_TASK_TIMEOUT_MS` | `120000` | Whole execution attempt |
| `AGENT_MAX_TOOL_OUTPUT_CHARS` | `4000` | Cap on tool output shown to the model (per-tool override available) |
| `AGENT_MAX_REQUEST_CHARS` / `AGENT_MAX_RESPONSE_CHARS` | `4000` | Request and final-answer caps |
| `AGENT_MAX_ATTEMPTS` | `3` | Executions per task (transient provider errors, lease recovery) |
| `AGENT_LEASE_SECONDS` | `60` | Worker lease; stale tasks are requeued after it expires |
| `AGENT_HISTORY_LIMIT` | `20` | Recent conversation turns given to the model |
| `AGENT_CONFIRMATION_TTL_MINUTES` | `30` | Unanswered confirmations are cancelled after this |
| `AGENT_DEFAULT_PERMISSIONS` | `utility:read` | Permissions of every fully verified user. There is no per-user grant table yet; implement `PermissionResolver` to add one |

The model must be served through an `AiProvider` that implements `generateWithTools` (OpenAI-compatible providers, including the Gemini endpoint, do; the stub answers without tools).

### 8.6 Testing the engine

`npm test` runs everything. DB-backed engine tests need a **dedicated** PostgreSQL database whose name contains `test` (they truncate the agent tables) and are skipped otherwise:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/whatsapp_test \
DATABASE_URL=$TEST_DATABASE_URL NODE_ENV=test npx tsx src/db/migrate.ts
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/whatsapp_test npm test
```

The model is always mocked; no paid API calls are made.
#   w h a t s a p p - a g e n t  
 