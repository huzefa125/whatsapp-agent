import { describe, it, expect } from 'vitest';
import { alreadyNudged, claimNotice, unverifiedClaim } from '../../src/services/agent/engine/claim-guard';
import type { TranscriptMessage } from '../../src/services/agent/engine/transcript';
import { parseDecision } from '../../src/services/agent/whatsapp/channel';

const tool = (name: string, content: string): TranscriptMessage => ({ role: 'tool', toolCallId: 'c', name, content });

const notice = (text: string, t: TranscriptMessage[], tools: string[] = []) => unverifiedClaim(text, t, tools)?.notice ?? null;

describe('unverifiedClaim', () => {
  const draftOnly: TranscriptMessage[] = [
    { role: 'user', content: 'send it' },
    tool('gmail_draft', '<<<TOOL_RESULT name=gmail_draft>>>{"ok":true,"data":{"draftId":"r-1"}}<<<END_TOOL_RESULT>>>'),
  ];

  it('flags "email sent" when no send succeeded (the real bug: draft only, then "sent ✅")', () => {
    expect(notice('Your email has been sent to a@b.com with the subject "CRM Meeting at 3 PM". ✅', draftOnly)).toMatch(/gmail_send_draft/);
    expect(notice("I've sent it!", draftOnly)).toMatch(/gmail_send_draft/);
    expect(notice('Done, I sent the email.', [])).toMatch(/gmail_send_draft/);
  });

  it('accepts the claim once gmail_send_draft returned sent:true', () => {
    const proven = [...draftOnly, tool('gmail_send_draft', '{"ok":true,"data":{"ok":true,"sent":true,"messageId":"m"}}')];
    expect(unverifiedClaim('Your email has been sent.', proven)).toBeNull();
  });

  it('does not accept a failed or duplicate send as proof', () => {
    const failed = [...draftOnly, tool('gmail_send_draft', '{"ok":false,"error":{"code":"DRAFT_NOT_FOUND"}}')];
    expect(notice('Your email has been sent.', failed)).toMatch(/gmail_send_draft/);
  });

  it('leaves ordinary replies alone', () => {
    expect(unverifiedClaim('Here is the draft. Say "send" and I will send it.', draftOnly)).toBeNull();
    expect(unverifiedClaim('Please confirm: send this email to a@b.com', draftOnly)).toBeNull();
    expect(unverifiedClaim('You have 3 unread emails.', [])).toBeNull();
  });

  it('flags a reminder claimed without a successful create_reminder', () => {
    expect(notice('Your reminder has been set for 5 pm.', [])).toMatch(/create_reminder/);
    expect(notice("I've set a reminder for you.", [])).toMatch(/create_reminder/);
    const ok = [tool('create_reminder', '{"ok":true,"data":{"id":"x"}}')];
    expect(unverifiedClaim('Your reminder has been set for 5 pm.', ok)).toBeNull();
  });

  it('catches a wrong "I cannot search the web" when web_search exists (the real 3:17 and 3:18 replies)', () => {
    const tools = ['calculator', 'web_search'];
    const first = "I don't have the ability to perform Google searches or browse the web. I can only help with reminders.";
    const second = "I don't have live web browsing or search capabilities to look up current information about this website.";
    expect(notice(first, [], tools)).toMatch(/web_search/);
    expect(notice(second, [], tools)).toMatch(/web_search/);
    expect(unverifiedClaim(first, [], tools)?.fallback).toBeNull(); // the model's own words go through after one nudge
  });

  it('allows that refusal when it is true, or after a search tool already ran', () => {
    const refusal = "I can't browse the web right now.";
    expect(notice(refusal, [], ['calculator'])).toBeNull(); // no search tool: honest answer
    expect(notice(refusal, [tool('web_search', '{"ok":false,"error":{"code":"SEARCH_QUOTA"}}')], ['web_search'])).toBeNull();
    expect(notice("I can't make phone calls.", [], ['web_search'])).toBeNull();
    expect(notice('I cannot access your email online yet.', [], ['web_search'])).toBeNull();
  });

  it('nudges only once per task', () => {
    const t: TranscriptMessage[] = [{ role: 'user', content: 'hi' }];
    expect(alreadyNudged(t)).toBe(false);
    t.push({ role: 'user', content: claimNotice({ notice: 'x', fallback: null }) });
    expect(alreadyNudged(t)).toBe(true);
  });
});

describe('parseDecision', () => {
  it('keeps the strict single-word answers', () => {
    expect(parseDecision(' YES. ')).toBe('approve');
    expect(parseDecision('👍')).toBe('approve');
    expect(parseDecision('no')).toBe('reject');
    expect(parseDecision('cancel')).toBe('reject');
  });

  it('accepts short natural confirmations (the real "Yes send it" that was ignored)', () => {
    for (const t of ['Yes send it', 'yeah send it', 'yes please', 'ok go ahead', 'send it', 'haan bhej do', 'Yes, send it!']) {
      expect(parseDecision(t), t).toBe('approve');
    }
    for (const t of ['no thanks', 'nahi', 'no cancel it', 'please cancel']) {
      expect(parseDecision(t), t).toBe('reject');
    }
  });

  it('never treats anything with extra content or a contradiction as a decision', () => {
    for (const t of [
      'yes please also add milk',
      'yes but change the subject',
      'not now',
      "don't send it",
      'do not send',
      'no send it',
      'yes send it to someone else too',
      'what is the subject?',
    ]) {
      expect(parseDecision(t), t).toBeNull();
    }
  });
});
