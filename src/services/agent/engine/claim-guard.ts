import type { TranscriptMessage } from './transcript';

/**
 * Code-level checks for the model's worst habits: announcing that something was done when no tool did it
 * (an email "sent" with no send call), and refusing something it can do ("I can't search the web" while
 * web_search is available). The prompt forbids both, but a prompt is only a request, so the final answer
 * is also checked against the tools it was given and the results of the current task.
 */
type ToolMessage = Extract<TranscriptMessage, { role: 'tool' }>;

interface ClaimRule {
  /** Matches the wording to catch. */
  claim: RegExp;
  /** Rule only applies when the user's session has at least one of these tools. Omit = always. */
  whenToolsAvailable?: readonly string[];
  /** A tool result that makes the wording legitimate. */
  proof: (m: ToolMessage) => boolean;
  /** Correction shown to the model. */
  notice: string;
  /** Shown to the user if the model repeats the mistake. Omit to let the model's reply through. */
  fallback?: string;
}

const NOT_DONE_FALLBACK =
  "I haven't actually done that yet, so please ignore my last message. Tell me again what you'd like and I'll do it properly (I'll ask you to confirm first when needed).";

const SEARCH_TOOLS = ['web_search', 'browser_open'] as const;

const RULES: ClaimRule[] = [
  {
    claim:
      /\b(?:email|e-mail|mail|message|reply)\b[^.!?\n]{0,60}\b(?:has been|have been|was|is been)\s+(?:sent|delivered)\b|\b(?:i(?:'|’)?ve|i have|i)\s+(?:just\s+)?sent\b|\bsent (?:it|the (?:email|e-mail|mail|message|reply))\b/i,
    proof: (m) => m.name === 'gmail_send_draft' && /"sent":true/.test(m.content),
    notice:
      'Your last reply says the email was sent, but no successful gmail_send_draft call in this turn actually sent it. Do not claim it. If the user asked you to send it, call gmail_send_draft now with the draftId returned by gmail_draft (never an email message id). Otherwise correct your reply to say it has not been sent.',
    fallback: NOT_DONE_FALLBACK,
  },
  {
    claim:
      /\breminder\b[^.!?\n]{0,40}\b(?:is|has been|was)\s+(?:set|created|scheduled|saved)\b|\b(?:i(?:'|’)?ve|i have)\s+(?:set|created|scheduled)\s+(?:a|your|the)\s+reminder\b/i,
    proof: (m) => (m.name === 'create_reminder' || m.name === 'reschedule_reminder') && m.content.includes('"ok":true'),
    notice:
      'Your last reply says a reminder was set, but no successful create_reminder call in this turn did it. Do not claim it. Call create_reminder now if the user asked for one, otherwise correct your reply.',
    fallback: NOT_DONE_FALLBACK,
  },
  {
    // Refusing to search/browse. Typical cause: older replies in the chat, written before the tools existed.
    claim:
      /\b(?:i\s*(?:don(?:'|’)?t|do not|can(?:'|’)?t|cannot|can not|am unable to|(?:'|’)m unable to|am not able to|(?:'|’)m not able to)|(?:i\s+(?:have|got)\s+no|no)\s+(?:ability|way|capabilit\w*))\b[^.!?\n]{0,70}\b(?:search|browse|browsing|web|google|look\s*up|internet|websites?)\b/i,
    whenToolsAvailable: SEARCH_TOOLS,
    proof: (m) => (SEARCH_TOOLS as readonly string[]).includes(m.name) || m.name.startsWith('browser_'),
    notice:
      'Your last reply says you cannot search or browse the web, but you can: web_search is available in this chat (and browser tools may be too). Earlier messages in this chat that say otherwise were written before these tools were enabled and are wrong. Call web_search now with a short query for what the user asked, then answer from the results and say they come from a web search.',
  },
];

/** Marks the automated correction we add to the transcript, so we only ever do it once per task. */
export const CLAIM_NOTICE_PREFIX = '[Automated check]';

export interface ClaimProblem {
  notice: string;
  fallback: string | null;
}

/** The mistake found in a final answer, or null when it is fine. */
export function unverifiedClaim(
  text: string,
  transcript: TranscriptMessage[],
  availableTools: readonly string[] = []
): ClaimProblem | null {
  for (const rule of RULES) {
    if (rule.whenToolsAvailable && !rule.whenToolsAvailable.some((t) => availableTools.includes(t))) continue;
    if (!rule.claim.test(text)) continue;
    if (transcript.some((m) => m.role === 'tool' && rule.proof(m))) continue;
    return { notice: rule.notice, fallback: rule.fallback ?? null };
  }
  return null;
}

export function claimNotice(problem: ClaimProblem): string {
  return `${CLAIM_NOTICE_PREFIX} ${problem.notice}`;
}

export function alreadyNudged(transcript: TranscriptMessage[]): boolean {
  return transcript.some((m) => m.role === 'user' && m.content.startsWith(CLAIM_NOTICE_PREFIX));
}
