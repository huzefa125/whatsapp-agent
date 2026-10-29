import { describe, it, expect, vi } from 'vitest';
import { createGmailTools } from '../../src/services/gmail/tools/gmail-tools';
import type { GmailApiService } from '../../src/services/gmail/gmail-api';
import type { ToolExecutionContext } from '../../src/services/agent/engine/types';

describe('Gmail Tools', () => {
  const mockApi: GmailApiService = {
    searchEmails: vi.fn().mockResolvedValue([
      { id: 'm1', threadId: 't1', from: 'alice@example.com', subject: 'Hello', date: '2026-10-29', snippet: 'Hi there' },
    ]),
    readEmail: vi.fn().mockResolvedValue({
      id: 'm1',
      threadId: 't1',
      from: 'alice@example.com',
      to: 'me@example.com',
      subject: 'Hello',
      date: '2026-10-29',
      body: 'Hello world',
      hasAttachments: false,
    }),
    listThreadMessages: vi.fn().mockResolvedValue([
      { id: 'm1', threadId: 't1', from: 'alice@example.com', subject: 'Hello', date: '2026-10-29', snippet: 'Hi' },
    ]),
    createDraft: vi.fn().mockResolvedValue({
      draftId: 'd1',
      messageId: 'm2',
      to: 'bob@example.com',
      subject: 'Re: Hello',
      bodyPreview: 'Sounds good',
    }),
    sendDraft: vi.fn().mockResolvedValue({
      messageId: 'm2',
      threadId: 't1',
      duplicate: false,
    }),
    getConnectionStatus: vi.fn().mockResolvedValue({
      connected: true,
      email: 'user@gmail.com',
    }),
  };

  const fakeCtx: ToolExecutionContext = {
    userId: 'user-123',
    taskId: 'task-456',
    executionId: 'exec-789',
    toolCallId: 'call-001',
    idempotencyKey: 'idem-key-abc',
    signal: new AbortController().signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
  };

  const tools = createGmailTools(mockApi);
  const byName = (name: string) => tools.find((t) => t.name === name)!;

  it('registers all 8 expected Gmail tools', () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain('gmail_search');
    expect(names).toContain('gmail_read');
    expect(names).toContain('gmail_summarize_thread');
    expect(names).toContain('gmail_draft');
    expect(names).toContain('gmail_send_draft');
    expect(names).toContain('gmail_reply');
    expect(names).toContain('gmail_list_thread');
    expect(names).toContain('gmail_status');
    expect(tools.length).toBe(8);
  });

  describe('gmail_search', () => {
    const tool = byName('gmail_search');

    it('has correct metadata', () => {
      expect(tool.permissions).toEqual(['gmail:read']);
      expect(tool.sideEffect).toBe('none');
      expect(tool.requiresConfirmation).toBe(false);
    });

    it('validates input and executes with ctx.userId', async () => {
      const result = await tool.execute({ query: 'from:alice', maxResults: 5 }, fakeCtx);
      expect(mockApi.searchEmails).toHaveBeenCalledWith('user-123', 'from:alice', 5);
      expect(result).toEqual({
        emails: [{ id: 'm1', threadId: 't1', from: 'alice@example.com', subject: 'Hello', date: '2026-10-29', snippet: 'Hi there' }],
        count: 1,
      });

      const formatted = tool.formatResult!(result);
      expect(formatted).toEqual({
        ok: true,
        count: 1,
        emails: result.emails,
      });
    });

    it('rejects invalid query input', () => {
      expect(() => tool.inputSchema.parse({ query: '' })).toThrow();
      expect(() => tool.inputSchema.parse({ query: 'test', maxResults: 50 })).toThrow();
    });
  });

  describe('gmail_read', () => {
    const tool = byName('gmail_read');

    it('has correct metadata', () => {
      expect(tool.permissions).toEqual(['gmail:read']);
      expect(tool.sideEffect).toBe('none');
      expect(tool.requiresConfirmation).toBe(false);
    });

    it('executes with ctx.userId', async () => {
      const email = await tool.execute({ messageId: 'm1' }, fakeCtx);
      expect(mockApi.readEmail).toHaveBeenCalledWith('user-123', 'm1');
      const formatted = tool.formatResult!(email);
      expect(formatted).toEqual({
        ok: true,
        email: {
          id: 'm1',
          from: 'alice@example.com',
          to: 'me@example.com',
          cc: undefined,
          subject: 'Hello',
          date: '2026-10-29',
          body: 'Hello world',
          hasAttachments: false,
        },
      });
    });
  });

  describe('gmail_draft', () => {
    const tool = byName('gmail_draft');

    it('has correct metadata', () => {
      expect(tool.permissions).toEqual(['gmail:write']);
      expect(tool.sideEffect).toBe('idempotent');
      expect(tool.requiresConfirmation).toBe(false);
    });

    it('creates draft and informs user that confirmation is required to send', async () => {
      const draft = await tool.execute(
        { to: 'bob@example.com', subject: 'Re: Hello', body: 'Sounds good' },
        fakeCtx,
      );
      expect(mockApi.createDraft).toHaveBeenCalledWith(
        'user-123',
        'bob@example.com',
        'Re: Hello',
        'Sounds good',
        undefined,
        undefined,
      );
      const formatted = tool.formatResult!(draft) as any;
      expect(formatted.ok).toBe(true);
      expect(formatted.note).toContain('confirm before sending');
    });

    it('rejects invalid email address', () => {
      expect(() =>
        tool.inputSchema.parse({ to: 'invalid-email', subject: 'test', body: 'body' }),
      ).toThrow();
    });
  });

  describe('gmail_send_draft', () => {
    const tool = byName('gmail_send_draft');

    it('enforces non_idempotent sideEffect, requiresConfirmation=true, and maxRetries=0', () => {
      expect(tool.permissions).toEqual(['gmail:send']);
      expect(tool.sideEffect).toBe('non_idempotent');
      expect(tool.requiresConfirmation).toBe(true);
      expect(tool.retry.maxRetries).toBe(0);
    });

    it('passes idempotency key to prevent double sends', async () => {
      const res = await tool.execute({ draftId: 'd1' }, fakeCtx);
      expect(mockApi.sendDraft).toHaveBeenCalledWith('user-123', 'd1', 'idem-key-abc');
      const formatted = tool.formatResult!(res) as any;
      expect(formatted.ok).toBe(true);
      expect(formatted.sent).toBe(true);
    });

    it('formats duplicate detection gracefully', async () => {
      (mockApi.sendDraft as any).mockResolvedValueOnce({
        duplicate: true,
        messageId: 'm2',
        threadId: 't1',
      });
      const res = await tool.execute({ draftId: 'd1' }, fakeCtx);
      const formatted = tool.formatResult!(res) as any;
      expect(formatted.ok).toBe(true);
      expect(formatted.sent).toBe(false);
      expect(formatted.duplicate).toBe(true);
    });
  });

  describe('gmail_reply', () => {
    const tool = byName('gmail_reply');

    it('reads original email and prepares draft with Re: prefix', async () => {
      await tool.execute({ messageId: 'm1', body: 'Thanks for writing' }, fakeCtx);
      expect(mockApi.readEmail).toHaveBeenCalledWith('user-123', 'm1');
      expect(mockApi.createDraft).toHaveBeenCalledWith(
        'user-123',
        'alice@example.com',
        'Re: Hello',
        'Thanks for writing',
        't1',
        '<m1>',
      );
    });
  });

  describe('gmail_status', () => {
    const tool = byName('gmail_status');

    it('returns connection status for current user', async () => {
      const res = await tool.execute({}, fakeCtx);
      expect(mockApi.getConnectionStatus).toHaveBeenCalledWith('user-123');
      expect(res).toEqual({ connected: true, email: 'user@gmail.com' });
    });
  });
});
