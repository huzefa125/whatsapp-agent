import { google, gmail_v1 } from 'googleapis';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { gmailSendLog } from '../../db/schema';
import { getConfig } from '../../config/env';
import { logger } from '../../utils/logger';
import { ToolError } from '../agent/engine/types';
import type { GmailOAuthService } from './gmail-oauth';
import { GMAIL_SCOPES } from './gmail-oauth';

/** Sanitize email body content to prevent prompt injection. */
function sanitizeEmailContent(content: string): string {
  // Strip null bytes and control characters
  let sanitized = content.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  // Neutralize prompt delimiters
  sanitized = sanitized.replace(/<<</g, '<\u200B<<').replace(/>>>/g, '>>\u200B>');
  return sanitized;
}

/** Strip HTML tags for a text-only summary. */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function getMessageBody(payload: gmail_v1.Schema$MessagePart): string {
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.parts) {
    // Prefer text/plain over text/html
    const textPart = payload.parts.find((p) => p.mimeType === 'text/plain');
    if (textPart?.body?.data) return decodeBase64Url(textPart.body.data);
    const htmlPart = payload.parts.find((p) => p.mimeType === 'text/html');
    if (htmlPart?.body?.data) return stripHtml(decodeBase64Url(htmlPart.body.data));
    // Recursive multipart
    for (const part of payload.parts) {
      const body = getMessageBody(part);
      if (body) return body;
    }
  }
  return '';
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

/** A wrong or stale draft id is the model's mistake, so say so plainly instead of "failed unexpectedly". */
function draftLookupError(err: unknown): unknown {
  const status = (err as { code?: number; status?: number; response?: { status?: number } })?.code ??
    (err as { response?: { status?: number } })?.response?.status;
  if (status === 404 || status === 400) {
    return new ToolError(
      'DRAFT_NOT_FOUND',
      'There is no draft with that id. Use the draftId returned by gmail_draft or gmail_reply (never an email message id), or create the draft again.'
    );
  }
  return err;
}

export interface EmailMetadata {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
  labelIds: string[];
  hasAttachments: boolean;
}

export interface EmailFull extends EmailMetadata {
  body: string;
  cc: string;
  bcc: string;
  replyTo: string;
}

export interface DraftResult {
  draftId: string;
  to: string;
  subject: string;
  bodyPreview: string;
}

export interface SendResult {
  messageId: string;
  threadId: string;
  duplicate: boolean;
}

export interface GmailApiService {
  searchEmails(userId: string, query: string, maxResults?: number): Promise<EmailMetadata[]>;
  readEmail(userId: string, messageId: string): Promise<EmailFull>;
  listThreadMessages(userId: string, threadId: string): Promise<EmailMetadata[]>;
  createDraft(userId: string, to: string, subject: string, body: string, threadId?: string, inReplyTo?: string): Promise<DraftResult>;
  sendDraft(userId: string, draftId: string, idempotencyKey: string): Promise<SendResult>;
  /** Recipient and subject of a draft, for the confirmation shown to the user. */
  describeDraft?(userId: string, draftId: string): Promise<{ to: string; subject: string }>;
  getConnectionStatus(userId: string): ReturnType<GmailOAuthService['getStatus']>;
}

export function createGmailApiService(oauth: GmailOAuthService): GmailApiService {
  const config = getConfig();

  async function getGmail(userId: string) {
    const { client, connectionId, scopes } = await oauth.getAuthenticatedClient(userId);
    return { gmail: google.gmail({ version: 'v1', auth: client }), connectionId, scopes };
  }

  function assertScope(scopes: string[], required: string, actionName: string) {
    if (!scopes.includes(required)) {
      throw new Error(
        `Your Gmail connection does not include ${actionName} permission. ` +
        `Please reconnect with the send permission enabled.`
      );
    }
  }

  return {
    async searchEmails(userId, query, maxResults) {
      const max = maxResults ?? config.GMAIL_MAX_RESULTS;
      const { gmail } = await getGmail(userId);

      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: max,
      });

      const messageIds = listRes.data.messages ?? [];
      if (messageIds.length === 0) return [];

      const emails: EmailMetadata[] = [];
      for (const msg of messageIds) {
        if (!msg.id) continue;
        try {
          const full = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject', 'Date'],
          });
          const headers = full.data.payload?.headers;
          const hasAttachments = full.data.payload?.parts?.some(
            (p) => p.filename && p.filename.length > 0
          ) ?? false;

          emails.push({
            id: full.data.id ?? msg.id,
            threadId: full.data.threadId ?? '',
            from: sanitizeEmailContent(getHeader(headers, 'From')),
            to: sanitizeEmailContent(getHeader(headers, 'To')),
            subject: sanitizeEmailContent(getHeader(headers, 'Subject')),
            date: getHeader(headers, 'Date'),
            snippet: sanitizeEmailContent(full.data.snippet ?? ''),
            labelIds: full.data.labelIds ?? [],
            hasAttachments,
          });
        } catch (err) {
          logger.warn({ userId, messageId: msg.id, err: (err as Error).message }, 'Failed to fetch email metadata');
        }
      }
      return emails;
    },

    async readEmail(userId, messageId) {
      const { gmail } = await getGmail(userId);
      const res = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });

      const headers = res.data.payload?.headers;
      const body = res.data.payload ? getMessageBody(res.data.payload) : '';
      const hasAttachments = res.data.payload?.parts?.some(
        (p) => p.filename && p.filename.length > 0
      ) ?? false;

      return {
        id: res.data.id ?? messageId,
        threadId: res.data.threadId ?? '',
        from: sanitizeEmailContent(getHeader(headers, 'From')),
        to: sanitizeEmailContent(getHeader(headers, 'To')),
        cc: sanitizeEmailContent(getHeader(headers, 'Cc')),
        bcc: sanitizeEmailContent(getHeader(headers, 'Bcc')),
        replyTo: sanitizeEmailContent(getHeader(headers, 'Reply-To')),
        subject: sanitizeEmailContent(getHeader(headers, 'Subject')),
        date: getHeader(headers, 'Date'),
        snippet: sanitizeEmailContent(res.data.snippet ?? ''),
        body: sanitizeEmailContent(body).slice(0, 4000), // Cap body for model context
        labelIds: res.data.labelIds ?? [],
        hasAttachments,
      };
    },

    async listThreadMessages(userId, threadId) {
      const { gmail } = await getGmail(userId);
      const thread = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      });

      return (thread.data.messages ?? []).map((msg) => {
        const headers = msg.payload?.headers;
        const hasAttachments = msg.payload?.parts?.some(
          (p) => p.filename && p.filename.length > 0
        ) ?? false;

        return {
          id: msg.id ?? '',
          threadId: msg.threadId ?? threadId,
          from: sanitizeEmailContent(getHeader(headers, 'From')),
          to: sanitizeEmailContent(getHeader(headers, 'To')),
          subject: sanitizeEmailContent(getHeader(headers, 'Subject')),
          date: getHeader(headers, 'Date'),
          snippet: sanitizeEmailContent(msg.snippet ?? ''),
          labelIds: msg.labelIds ?? [],
          hasAttachments,
        };
      });
    },

    async createDraft(userId, to, subject, body, threadId, inReplyTo) {
      const { gmail, scopes } = await getGmail(userId);
      assertScope(scopes, GMAIL_SCOPES.COMPOSE, 'compose');

      // Build RFC 2822 message
      const messageParts = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset="UTF-8"',
        'MIME-Version: 1.0',
      ];

      if (inReplyTo) {
        messageParts.push(`In-Reply-To: ${inReplyTo}`);
        messageParts.push(`References: ${inReplyTo}`);
      }

      messageParts.push('', body);
      const rawMessage = Buffer.from(messageParts.join('\r\n')).toString('base64url');

      const draft = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: {
            raw: rawMessage,
            threadId: threadId || undefined,
          },
        },
      });

      logger.info({ userId, draftId: draft.data.id }, 'Gmail draft created');

      return {
        draftId: draft.data.id ?? '',
        to,
        subject,
        bodyPreview: body.slice(0, 200),
      };
    },

    async sendDraft(userId, draftId, idempotencyKey) {
      const { gmail, connectionId, scopes } = await getGmail(userId);
      assertScope(scopes, GMAIL_SCOPES.SEND, 'send');

      const db = getDb();

      // Duplicate-send protection
      const [existing] = await db
        .select()
        .from(gmailSendLog)
        .where(and(eq(gmailSendLog.userId, userId), eq(gmailSendLog.idempotencyKey, idempotencyKey)))
        .limit(1);

      if (existing) {
        logger.info({ userId, idempotencyKey }, 'Duplicate send prevented');
        return {
          messageId: existing.messageId ?? '',
          threadId: existing.threadId ?? '',
          duplicate: true,
        };
      }

      // Read the draft first to get metadata for the send log
      const draftData = await gmail.users.drafts
        .get({ userId: 'me', id: draftId, format: 'metadata' })
        .catch((err: unknown) => {
          throw draftLookupError(err);
        });

      const draftHeaders = draftData.data.message?.payload?.headers;
      const recipient = getHeader(draftHeaders, 'To');
      const subject = getHeader(draftHeaders, 'Subject');

      // Send the draft
      const sent = await gmail.users.drafts.send({
        userId: 'me',
        requestBody: { id: draftId },
      });

      const messageId = sent.data.id ?? '';
      const threadId = sent.data.threadId ?? '';

      // Record in send log
      await db.insert(gmailSendLog).values({
        userId,
        connectionId,
        idempotencyKey,
        messageId,
        threadId,
        recipient: recipient || 'unknown',
        subject: subject || '(no subject)',
      });

      logger.info({ userId, messageId, threadId }, 'Email sent via Gmail');
      return { messageId, threadId, duplicate: false };
    },

    async describeDraft(userId, draftId) {
      const { gmail } = await getGmail(userId);
      const draft = await gmail.users.drafts
        .get({ userId: 'me', id: draftId, format: 'metadata' })
        .catch((err: unknown) => {
          throw draftLookupError(err);
        });
      const headers = draft.data.message?.payload?.headers;
      return { to: getHeader(headers, 'To'), subject: getHeader(headers, 'Subject') };
    },

    async getConnectionStatus(userId) {
      return oauth.getStatus(userId);
    },
  };
}
