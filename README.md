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
#   w h a t s a p p - a g e n t  
 