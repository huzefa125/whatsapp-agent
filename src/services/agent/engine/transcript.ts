import { z } from 'zod';
import type { ToolChatMessage } from '../../ai/types';

/**
 * Persisted model transcript (system prompt excluded; it is always rebuilt from code so a
 * stored transcript can never override it). Tool messages hold already-sanitized output.
 */
export const transcriptMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string() }),
  z.object({
    role: z.literal('assistant'),
    content: z.string().nullable(),
    toolCalls: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          rawArguments: z.string(),
          providerMetadata: z.unknown().optional(),
        })
      )
      .optional(),
  }),
  z.object({
    role: z.literal('tool'),
    toolCallId: z.string(),
    name: z.string(),
    content: z.string(),
  }),
]);

export const transcriptSchema = z.array(transcriptMessageSchema);

export type TranscriptMessage = z.infer<typeof transcriptMessageSchema>;

export function toProviderMessages(systemPrompt: string, transcript: TranscriptMessage[]): ToolChatMessage[] {
  return [{ role: 'system', content: systemPrompt }, ...transcript];
}

/** Tool calls in the most recent assistant message that do not have a tool result yet. */
export function unansweredToolCalls(transcript: TranscriptMessage[]) {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const msg = transcript[i];
    if (!msg) continue;
    if (msg.role === 'tool') continue;
    if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const answered = new Set(
        transcript
          .slice(i + 1)
          .flatMap((m) => (m.role === 'tool' ? [m.toolCallId] : []))
      );
      return msg.toolCalls.filter((c) => !answered.has(c.id));
    }
    return [];
  }
  return [];
}

export function countToolRounds(transcript: TranscriptMessage[]): number {
  return transcript.filter((m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0).length;
}
