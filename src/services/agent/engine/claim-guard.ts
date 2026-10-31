import type { TranscriptMessage } from './transcript';

/**
 * Code-level check for the worst model failure: announcing that something was done when no tool
 * actually did it (an email "sent" with no send call). The prompt forbids it, but a prompt is only a
 * request, so the final answer is also checked against the tool results of the current task.
 */
interface ClaimRule {
  /** Matches wording that says the action is already done. */
  claim: RegExp;
  /** A tool result that proves it. */
  proof: (m: Extract<TranscriptMessage, { role: 'tool' }>) => boolean;
  what: string;
}

const RULES: ClaimRule[] = [
  {
    what: 'send the email',
    claim:
      /\b(?:email|e-mail|mail|message|reply)\b[^.!?\n]{0,60}\b(?:has been|have been|was|is been)\s+(?:sent|delivered)\b|\b(?:i(?:'|’)?ve|i have|i)\s+(?:just\s+)?sent\b|\bsent (?:it|the (?:email|e-mail|mail|message|reply))\b/i,
    proof: (m) => m.name === 'gmail_send_draft' && /"sent":true/.test(m.content),
  },
  {
    what: 'set the reminder',
    claim:
      /\breminder\b[^.!?\n]{0,40}\b(?:is|has been|was)\s+(?:set|created|scheduled|saved)\b|\b(?:i(?:'|’)?ve|i have)\s+(?:set|created|scheduled)\s+(?:a|your|the)\s+reminder\b/i,
    proof: (m) => (m.name === 'create_reminder' || m.name === 'reschedule_reminder') && m.content.includes('"ok":true'),
  },
];

/** Marks the automated correction we add to the transcript, so we only ever do it once per task. */
export const CLAIM_NOTICE_PREFIX = '[Automated check]';

export const CLAIM_FALLBACK_REPLY =
  "I haven't actually done that yet, so please ignore my last message. Tell me again what you'd like and I'll do it properly (I'll ask you to confirm first when needed).";

/** What the model claimed to have done without any proof in this task, or null when the answer is fine. */
export function unverifiedClaim(text: string, transcript: TranscriptMessage[]): string | null {
  for (const rule of RULES) {
    if (!rule.claim.test(text)) continue;
    const proven = transcript.some((m) => m.role === 'tool' && rule.proof(m));
    if (!proven) return rule.what;
  }
  return null;
}

export function claimNotice(what: string): string {
  return `${CLAIM_NOTICE_PREFIX} Your last reply says the action is done, but no successful tool call in this conversation turn actually did it. Do not claim it. If the user asked you to ${what}, call the right tool now (for email: gmail_send_draft with the draftId returned by gmail_draft, never an email message id). Otherwise correct your reply to say it has not been done.`;
}

export function alreadyNudged(transcript: TranscriptMessage[]): boolean {
  return transcript.some((m) => m.role === 'user' && m.content.startsWith(CLAIM_NOTICE_PREFIX));
}
