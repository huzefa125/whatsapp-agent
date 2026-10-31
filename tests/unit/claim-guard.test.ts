import { describe, it, expect } from 'vitest';
import { alreadyNudged, claimNotice, unverifiedClaim } from '../../src/services/agent/engine/claim-guard';
import type { TranscriptMessage } from '../../src/services/agent/engine/transcript';
import { parseDecision } from '../../src/services/agent/whatsapp/channel';

const tool = (name: string, content: string): TranscriptMessage => ({ role: 'tool', toolCallId: 'c', name, content });

describe('unverifiedClaim', () => {
  const draftOnly: TranscriptMessage[] = [
    { role: 'user', content: 'send it' },
    tool('gmail_draft', '<<<TOOL_RESULT name=gmail_draft>>>{"ok":true,"data":{"draftId":"r-1"}}<<<END_TOOL_RESULT>>>'),
  ];

  it('flags "email sent" when no send succeeded (the real bug: draft only, then "sent ✅")', () => {
    expect(unverifiedClaim('Your email has been sent to a@b.com with the subject "CRM Meeting at 3 PM". ✅', draftOnly)).toBe('send the email');
    expect(unverifiedClaim("I've sent it!", draftOnly)).toBe('send the email');
    expect(unverifiedClaim('Done, I sent the email.', [])).toBe('send the email');
  });

  it('accepts the claim once gmail_send_draft returned sent:true', () => {
    const proven = [...draftOnly, tool('gmail_send_draft', '{"ok":true,"data":{"ok":true,"sent":true,"messageId":"m"}}')];
    expect(unverifiedClaim('Your email has been sent.', proven)).toBeNull();
  });

  it('does not accept a failed or duplicate send as proof', () => {
    const failed = [...draftOnly, tool('gmail_send_draft', '{"ok":false,"error":{"code":"DRAFT_NOT_FOUND"}}')];
    expect(unverifiedClaim('Your email has been sent.', failed)).toBe('send the email');
  });

  it('leaves ordinary replies alone', () => {
    expect(unverifiedClaim('Here is the draft. Say "send" and I will send it.', draftOnly)).toBeNull();
    expect(unverifiedClaim('Please confirm: send this email to a@b.com', draftOnly)).toBeNull();
    expect(unverifiedClaim('You have 3 unread emails.', [])).toBeNull();
  });

  it('flags a reminder claimed without a successful create_reminder', () => {
    expect(unverifiedClaim('Your reminder has been set for 5 pm.', [])).toBe('set the reminder');
    expect(unverifiedClaim("I've set a reminder for you.", [])).toBe('set the reminder');
    const ok = [tool('create_reminder', '{"ok":true,"data":{"id":"x"}}')];
    expect(unverifiedClaim('Your reminder has been set for 5 pm.', ok)).toBeNull();
  });

  it('nudges only once per task', () => {
    const t: TranscriptMessage[] = [{ role: 'user', content: 'hi' }];
    expect(alreadyNudged(t)).toBe(false);
    t.push({ role: 'user', content: claimNotice('send the email') });
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
