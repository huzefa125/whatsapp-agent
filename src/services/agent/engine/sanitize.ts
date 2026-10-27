const SECRET_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
];

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Removes control characters, redacts common credential shapes and neutralises prompt delimiters. */
export function scrubText(text: string): string {
  let out = text.replace(CONTROL_CHARS, '');
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  // Tool data must not be able to forge our own prompt delimiters.
  return out.replace(/<<</g, '<​<<').replace(/>>>/g, '>>​>');
}

export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Serializes a tool result into the exact string the model will see.
 * Output is always valid JSON of the form {"ok":true,"data":...} and never exceeds maxChars.
 */
export function serializeToolSuccess(data: unknown, maxChars: number): string {
  let json: string;
  try {
    json = JSON.stringify(data === undefined ? null : data) ?? 'null';
  } catch {
    return serializeToolFailure('TOOL_OUTPUT_INVALID', 'The tool returned data that could not be serialized.');
  }
  json = scrubText(json);

  const overhead = '{"ok":true,"data":}'.length;
  if (json.length + overhead <= maxChars) {
    return `{"ok":true,"data":${json}}`;
  }
  const previewBudget = Math.max(0, maxChars - overhead - '{"truncated":true,"preview":""}'.length - 16);
  const preview = JSON.stringify(json.slice(0, previewBudget)).slice(1, -1).slice(0, previewBudget);
  return `{"ok":true,"data":{"truncated":true,"preview":"${preview}"}}`;
}

export function serializeToolFailure(code: string, message: string): string {
  return JSON.stringify({ ok: false, error: { code, message: truncate(scrubText(message), 500) } });
}

/** Wraps a serialized tool result so the model can distinguish data from instructions. */
export function wrapToolResultForModel(name: string, serialized: string): string {
  return `<<<TOOL_RESULT name=${name}>>>\n${serialized}\n<<<END_TOOL_RESULT>>>`;
}

export function sanitizeFinalResponse(text: string, maxChars: number): string {
  return truncate(scrubText(text.replace(/\0/g, '')).trim(), maxChars);
}
