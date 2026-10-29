import { ValidationError } from '../../utils/errors';

export const MEMORY_LIMITS = {
  TITLE_MIN_CHARS: 1,
  TITLE_MAX_CHARS: 255,
  CONTENT_MIN_CHARS: 1,
  CONTENT_MAX_CHARS: 5000,
  KEYWORDS_MAX_CHARS: 500,
  PROVENANCE_MAX_CHARS: 500,
  PROJECT_MAX_CHARS: 128,
  INTEGRATION_MAX_CHARS: 64,
} as const;

/**
 * Patterns matching credentials, secrets, and auth tokens that must NEVER be saved in memory.
 */
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:bearer|token|apikey|api_key|secret|password|passwd|pwd)\s*[:=\s]\s*['"]?[A-Za-z0-9_\-\.]{12,}['"]?/i,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS Access Key
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b/, // GitHub Token
  /\bsk-[A-Za-z0-9]{32,}\b/, // OpenAI API Key
  /\bAIza[0-9A-Za-z-_]{35}\b/, // Google API Key
  /\b1\/\/[0-9A-Za-z-_]{30,}\b/, // Google Refresh Token
  /\b(?:otp|code|verification[_\s]*code)\s*[:=]?\s*[0-9]{4,8}\b/i, // OTP codes
];

/**
 * Validates that text does not contain secret credentials or sensitive tokens.
 */
export function assertNoSecrets(text: string, fieldName = 'content'): void {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new ValidationError(
        `Memory ${fieldName} contains detected credentials, tokens, or passwords. Storing secrets in memory is prohibited.`
      );
    }
  }
}

/**
 * Strips control characters and neutralizes prompt injection delimiters.
 */
export function sanitizeMemoryContent(content: string): string {
  // Strip null bytes and non-printable ASCII control characters (preserving newlines and tabs)
  let sanitized = content.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  // Neutralize prompt injection delimiters
  sanitized = sanitized.replace(/<<</g, '<\u200B<<').replace(/>>>/g, '>>\u200B>');
  return sanitized.trim();
}

/**
 * Validates and normalizes memory fields.
 */
export function validateMemoryPayload(input: {
  title: string;
  content: string;
  searchKeywords?: string | null;
  project?: string | null;
  provenance?: string | null;
}): {
  title: string;
  content: string;
  searchKeywords: string | null;
  project: string | null;
  provenance: string | null;
} {
  const title = input.title?.trim();
  if (!title || title.length < MEMORY_LIMITS.TITLE_MIN_CHARS || title.length > MEMORY_LIMITS.TITLE_MAX_CHARS) {
    throw new ValidationError(
      `Memory title must be between ${MEMORY_LIMITS.TITLE_MIN_CHARS} and ${MEMORY_LIMITS.TITLE_MAX_CHARS} characters`
    );
  }
  assertNoSecrets(title, 'title');

  const content = sanitizeMemoryContent(input.content || '');
  if (!content || content.length < MEMORY_LIMITS.CONTENT_MIN_CHARS || content.length > MEMORY_LIMITS.CONTENT_MAX_CHARS) {
    throw new ValidationError(
      `Memory content must be between ${MEMORY_LIMITS.CONTENT_MIN_CHARS} and ${MEMORY_LIMITS.CONTENT_MAX_CHARS} characters`
    );
  }
  assertNoSecrets(content, 'content');

  let searchKeywords: string | null = null;
  if (input.searchKeywords) {
    searchKeywords = sanitizeMemoryContent(input.searchKeywords);
    if (searchKeywords.length > MEMORY_LIMITS.KEYWORDS_MAX_CHARS) {
      throw new ValidationError(`Keywords must be at most ${MEMORY_LIMITS.KEYWORDS_MAX_CHARS} characters`);
    }
    assertNoSecrets(searchKeywords, 'searchKeywords');
  }

  let project: string | null = null;
  if (input.project) {
    project = input.project.trim();
    if (project.length > MEMORY_LIMITS.PROJECT_MAX_CHARS) {
      throw new ValidationError(`Project must be at most ${MEMORY_LIMITS.PROJECT_MAX_CHARS} characters`);
    }
  }

  let provenance: string | null = null;
  if (input.provenance) {
    provenance = sanitizeMemoryContent(input.provenance);
    if (provenance.length > MEMORY_LIMITS.PROVENANCE_MAX_CHARS) {
      throw new ValidationError(`Provenance must be at most ${MEMORY_LIMITS.PROVENANCE_MAX_CHARS} characters`);
    }
  }

  return {
    title,
    content,
    searchKeywords,
    project,
    provenance,
  };
}
