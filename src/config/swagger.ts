export const swaggerDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Instinct WhatsApp AI Agent API',
    version: '1.0.0',
    description:
      'Production-grade WhatsApp AI Agent backend inspired by Instinct. Features Meta Cloud API webhook lifecycle, dual-channel passwordless authentication (WhatsApp Phone + Email), cryptographic HMAC verification, durable outbox processing, and conversational AI orchestration.',
    contact: {
      name: 'Instinct Engineering Team',
    },
  },
  servers: [
    {
      url: '/',
      description: 'Current Server Instance',
    },
  ],
  paths: {
    '/health/live': {
      get: {
        summary: 'Liveness Probe',
        description: 'Returns HTTP 200 if the Node.js server process is running and able to handle traffic.',
        tags: ['Health'],
        responses: {
          '200': {
            description: 'Server is alive',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ok' },
                    uptimeSeconds: { type: 'integer', example: 120 },
                    timestamp: { type: 'string', format: 'date-time', example: '2026-10-25T18:00:00.000Z' },
                  },
                  required: ['status', 'uptimeSeconds', 'timestamp'],
                },
              },
            },
          },
        },
      },
    },
    '/health/ready': {
      get: {
        summary: 'Readiness Probe',
        description:
          'Validates critical infrastructure dependencies (PostgreSQL database pool) before routing traffic. Does not expose credentials.',
        tags: ['Health'],
        responses: {
          '200': {
            description: 'All dependencies healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'ready' },
                    checks: {
                      type: 'object',
                      properties: {
                        database: {
                          type: 'object',
                          properties: {
                            status: { type: 'string', example: 'connected' },
                            latencyMs: { type: 'number', example: 8 },
                          },
                        },
                      },
                    },
                    timestamp: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          '503': {
            description: 'Dependency unavailable or degraded',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'unavailable' },
                    checks: {
                      type: 'object',
                      properties: {
                        database: {
                          type: 'object',
                          properties: {
                            status: { type: 'string', example: 'disconnected' },
                            error: { type: 'string', example: 'Failed to communicate with primary database' },
                          },
                        },
                      },
                    },
                    timestamp: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/auth/start': {
      post: {
        summary: 'Start Dual-Channel Passwordless Authentication',
        description:
          'Initiates an authentication flow requiring both phone (E.164) and email. Normalizes inputs, checks account safety, and returns an authFlowId.',
        tags: ['Authentication'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  phoneNumber: { type: 'string', example: '+15551234567' },
                  email: { type: 'string', format: 'email', example: 'user@example.com' },
                },
                required: ['phoneNumber', 'email'],
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Authentication flow initialized',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'success' },
                    data: {
                      type: 'object',
                      properties: {
                        authFlowId: { type: 'string', format: 'uuid' },
                        phoneNumber: { type: 'string', example: '+15551234567' },
                        email: { type: 'string', example: 'user@example.com' },
                        phoneVerified: { type: 'boolean', example: false },
                        emailVerified: { type: 'boolean', example: false },
                        expiresAt: { type: 'string', format: 'date-time' },
                      },
                    },
                  },
                },
              },
            },
          },
          '400': { description: 'Invalid phone number or email format' },
          '409': { description: 'Phone and email belong to different registered accounts' },
        },
      },
    },
    '/api/auth/challenge/phone/send': {
      post: {
        summary: 'Send WhatsApp Phone OTP Challenge',
        description:
          'Generates a keyed HMAC OTP and dispatches it via official WhatsApp Business Platform. Enforces resend cooldowns and attempt limits.',
        tags: ['Authentication'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  authFlowId: { type: 'string', format: 'uuid' },
                },
                required: ['authFlowId'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Challenge accepted by WhatsApp dispatch provider' },
          '429': { description: 'Resend cooldown in effect (wait 60 seconds)' },
        },
      },
    },
    '/api/auth/challenge/phone/verify': {
      post: {
        summary: 'Verify WhatsApp Phone OTP Challenge',
        description:
          'Validates the OTP code using constant-time keyed HMAC comparison. Protects against replays, locked attempts, and expired codes.',
        tags: ['Authentication'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  authFlowId: { type: 'string', format: 'uuid' },
                  code: { type: 'string', example: '123456' },
                },
                required: ['authFlowId', 'code'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Phone verified. If email also verified, issues session.' },
          '400': { description: 'Incorrect code, expired, or locked' },
        },
      },
    },
    '/api/auth/challenge/email/send': {
      post: {
        summary: 'Send Transactional Email OTP Challenge',
        description:
          'Generates a keyed HMAC OTP and dispatches it via transactional email provider. Enforces resend cooldowns and attempt limits.',
        tags: ['Authentication'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  authFlowId: { type: 'string', format: 'uuid' },
                },
                required: ['authFlowId'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Challenge accepted by transactional email provider' },
          '429': { description: 'Resend cooldown in effect (wait 60 seconds)' },
        },
      },
    },
    '/api/auth/challenge/email/verify': {
      post: {
        summary: 'Verify Email OTP Challenge',
        description:
          'Validates the OTP code using constant-time keyed HMAC comparison. Protects against replays, locked attempts, and expired codes.',
        tags: ['Authentication'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  authFlowId: { type: 'string', format: 'uuid' },
                  code: { type: 'string', example: '654321' },
                },
                required: ['authFlowId', 'code'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Email verified. If phone also verified, issues session.' },
          '400': { description: 'Incorrect code, expired, or locked' },
        },
      },
    },
    '/api/auth/me': {
      get: {
        summary: 'Get Authenticated User Profile & Session',
        description:
          'Returns user profile and active session details. Accessible only with a valid Bearer token for an account with both phone and email verified.',
        tags: ['Authentication'],
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Authenticated user profile' },
          '401': { description: 'Unauthorized: missing, invalid, or expired session token' },
          '403': { description: 'Forbidden: dual-channel verification incomplete' },
        },
      },
    },
    '/api/auth/logout': {
      post: {
        summary: 'Revoke Current Session Token',
        description: 'Revokes the active session token in the database.',
        tags: ['Authentication'],
        security: [{ BearerAuth: [] }],
        responses: {
          '200': { description: 'Session revoked successfully' },
        },
      },
    },
    '/api/agent/tasks': {
      post: {
        summary: 'Create Agent Task',
        description:
          'Queues a request for the tool-using agent engine and returns immediately (202). Poll GET /api/agent/tasks/{id}. Identity comes from the Bearer session only. Supply an Idempotency-Key header (or idempotencyKey field) to make retries safe: a replay returns 200 with the original task, reuse with a different request returns 409.',
        tags: ['Agent Tasks'],
        security: [{ BearerAuth: [] }],
        parameters: [
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 128 } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['request'],
                properties: {
                  request: { type: 'string', example: 'What is 17.5% of 2480?', description: 'Max AGENT_MAX_REQUEST_CHARS (default 4000)' },
                  conversationId: { type: 'string', format: 'uuid', description: 'Optional. Must belong to the caller.' },
                  idempotencyKey: { type: 'string', maxLength: 128 },
                },
              },
            },
          },
        },
        responses: {
          '202': { description: 'Task accepted' },
          '200': { description: 'Idempotent replay of an existing task' },
          '400': { description: 'Validation error' },
          '401': { description: 'Unauthorized' },
          '404': { description: 'conversationId not found for this user' },
          '409': { description: 'Idempotency key reused with a different request' },
        },
      },
      get: {
        summary: 'List My Agent Tasks',
        description: 'Newest first. Only tasks owned by the caller are ever returned.',
        tags: ['Agent Tasks'],
        security: [{ BearerAuth: [] }],
        parameters: [
          {
            name: 'status',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['pending', 'running', 'awaiting_confirmation', 'succeeded', 'failed', 'cancelled'] },
          },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, default: 0 } },
        ],
        responses: { '200': { description: 'Tasks' }, '400': { description: 'Validation error' }, '401': { description: 'Unauthorized' } },
      },
    },
    '/api/agent/tasks/{id}': {
      get: {
        summary: 'Get Agent Task',
        description:
          'Returns status, sanitized result or error, and, while status is awaiting_confirmation, pendingConfirmation { callId, toolName, summary, arguments }.',
        tags: ['Agent Tasks'],
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Task' }, '401': { description: 'Unauthorized' }, '404': { description: 'Not found (or not yours)' } },
      },
    },
    '/api/agent/tasks/{id}/cancel': {
      post: {
        summary: 'Cancel Agent Task',
        description:
          'pending / awaiting_confirmation tasks are cancelled immediately. A running task gets cancelRequested=true and stops at its next checkpoint. Finished tasks return 409.',
        tags: ['Agent Tasks'],
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { '200': { description: 'Task after cancellation' }, '404': { description: 'Not found' }, '409': { description: 'Task already finished' } },
      },
    },
    '/api/agent/tasks/{id}/confirm': {
      post: {
        summary: 'Approve or Reject a Pending Action',
        description:
          'Resolves exactly one pending tool call. Approval runs exactly the arguments shown in pendingConfirmation. Rejection tells the model the user declined.',
        tags: ['Agent Tasks'],
        security: [{ BearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['callId', 'decision'],
                properties: {
                  callId: { type: 'string', example: 'call_1_1' },
                  decision: { type: 'string', enum: ['approve', 'reject'] },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Decision recorded; task re-queued' },
          '400': { description: 'Validation error' },
          '404': { description: 'Task or pending call not found' },
          '409': { description: 'Task is not awaiting confirmation, or the request expired' },
        },
      },
    },
    '/webhook': {
      get: {
        summary: 'Meta Webhook Challenge Verification',
        description:
          'Meta sends a GET request to verify the webhook endpoint during setup in the Meta App Dashboard.',
        tags: ['WhatsApp Webhook'],
        parameters: [
          {
            name: 'hub.mode',
            in: 'query',
            required: true,
            description: 'Verification mode, must be "subscribe"',
            schema: { type: 'string', example: 'subscribe' },
          },
          {
            name: 'hub.verify_token',
            in: 'query',
            required: true,
            description: 'Must match configured WHATSAPP_VERIFY_TOKEN',
            schema: { type: 'string', example: 'your_verify_token' },
          },
          {
            name: 'hub.challenge',
            in: 'query',
            required: true,
            description: 'Challenge number or string sent by Meta to echo back',
            schema: { type: 'string', example: '1158201444' },
          },
        ],
        responses: {
          '200': {
            description: 'Successful verification; returns raw hub.challenge text',
            content: {
              'text/plain': {
                schema: { type: 'string', example: '1158201444' },
              },
            },
          },
          '403': {
            description: 'Verification failed due to token or mode mismatch',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse',
                },
              },
            },
          },
        },
      },
      post: {
        summary: 'Meta Webhook Event Ingestion',
        description:
          'Receives inbound WhatsApp events (messages, media, delivery statuses) from Meta Cloud API. Validates HMAC-SHA256 signature using timingSafeEqual.',
        tags: ['WhatsApp Webhook'],
        parameters: [
          {
            name: 'x-hub-signature-256',
            in: 'header',
            required: true,
            description: 'Meta HMAC-SHA256 signature: sha256={digest}',
            schema: { type: 'string', example: 'sha256=abcdef1234567890...' },
          },
        ],
        requestBody: {
          required: true,
          description: 'Official WhatsApp Business Webhook payload',
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/MetaWebhookPayload',
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Event accepted and persisted into durable outbox queue',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', example: 'received' },
                  },
                },
              },
            },
          },
          '400': {
            description: 'Invalid JSON payload format',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
          '403': {
            description: 'Invalid or missing cryptographic HMAC-SHA256 signature',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ErrorResponse' },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'Hex Token',
        description: 'Provide your session bearer token issued after completing dual-channel verification.',
      },
    },
    schemas: {
      ErrorResponse: {
        type: 'object',
        properties: {
          status: { type: 'string', example: 'error' },
          code: { type: 'string', example: 'FORBIDDEN' },
          message: { type: 'string', example: 'Invalid webhook signature' },
          requestId: { type: 'string', example: '8f7a6b2c-1d3e-4f5a-9b8c-7d6e5f4a3b2c' },
        },
        required: ['status', 'code', 'message'],
      },
      MetaWebhookPayload: {
        type: 'object',
        properties: {
          object: { type: 'string', example: 'whatsapp_business_account' },
          entry: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', example: 'WHATSAPP_BUSINESS_ACCOUNT_ID' },
                changes: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      field: { type: 'string', example: 'messages' },
                      value: {
                        type: 'object',
                        properties: {
                          messaging_product: { type: 'string', example: 'whatsapp' },
                          metadata: {
                            type: 'object',
                            properties: {
                              display_phone_number: { type: 'string', example: '15551234567' },
                              phone_number_id: { type: 'string', example: '9876543210' },
                            },
                          },
                          contacts: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                profile: {
                                  type: 'object',
                                  properties: { name: { type: 'string', example: 'Alice Doe' } },
                                },
                                wa_id: { type: 'string', example: '15559876543' },
                              },
                            },
                          },
                          messages: {
                            type: 'array',
                            items: {
                              type: 'object',
                              properties: {
                                from: { type: 'string', example: '15559876543' },
                                id: { type: 'string', example: 'wamid.HBgLMTU1NTk4NzY1NDM=' },
                                timestamp: { type: 'string', example: '1700000000' },
                                type: { type: 'string', example: 'text' },
                                text: {
                                  type: 'object',
                                  properties: { body: { type: 'string', example: 'Hello Instinct Agent!' } },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        required: ['object', 'entry'],
      },
    },
  },
};
