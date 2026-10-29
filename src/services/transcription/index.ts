import { getConfig } from '../../config/env';
import { AppError, ExternalServiceError } from '../../utils/errors';
import { logger } from '../../utils/logger';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15000;

export interface AudioSource {
  url: string;
  mimeType?: string;
}

export interface Transcriber {
  /** Returns the spoken text, or '' when nothing intelligible was said. */
  transcribe(audio: AudioSource): Promise<string>;
}

const PROMPT =
  'Transcribe this voice message exactly as spoken. Keep the original language (English, Hindi, Hinglish, etc.) ' +
  'and write Hindi in the same script it is spoken naturally, Roman letters for Hinglish. ' +
  'Return ONLY the transcript text, with no quotes, labels or explanations. ' +
  'If there is no intelligible speech, return an empty string.';

export class GeminiTranscriber implements Transcriber {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly ycloudApiKey = ''
  ) {}

  async transcribe(audio: AudioSource): Promise<string> {
    const { data, mimeType } = await this.download(audio);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            { parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: data.toString('base64') } }] },
          ],
          generationConfig: { temperature: 0 },
        }),
        signal: AbortSignal.timeout(30000),
      }
    );

    const body = (await response.json().catch(() => null)) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { message?: string };
    } | null;

    if (!response.ok) {
      throw new ExternalServiceError('Gemini transcription', body?.error?.message || `HTTP ${response.status}`, {
        statusCode: response.status,
      });
    }

    return (body?.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
  }

  private download(audio: AudioSource) {
    return downloadAudio(audio, this.ycloudApiKey);
  }
}

/** Groq-hosted Whisper (OpenAI-compatible /audio/transcriptions). Language is auto-detected. */
export class GroqTranscriber implements Transcriber {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly ycloudApiKey = ''
  ) {}

  async transcribe(audio: AudioSource): Promise<string> {
    const { data, mimeType } = await downloadAudio(audio, this.ycloudApiKey);

    const form = new FormData();
    const ext = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'ogg';
    form.append('file', new Blob([new Uint8Array(data)], { type: mimeType }), `voice.${ext}`);
    form.append('model', this.model);
    form.append('response_format', 'json');
    form.append('temperature', '0');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(30000),
    });

    const body = (await response.json().catch(() => null)) as { text?: string; error?: { message?: string } } | null;
    if (!response.ok) {
      throw new ExternalServiceError('Groq transcription', body?.error?.message || `HTTP ${response.status}`, {
        statusCode: response.status,
      });
    }
    return (body?.text ?? '').trim();
  }
}

async function downloadAudio(audio: AudioSource, ycloudApiKey: string): Promise<{ data: Buffer; mimeType: string }> {
  const url = new URL(audio.url);
  if (url.protocol !== 'https:') {
    throw new AppError('Voice note URL must be https', 400, 'TRANSCRIPTION_BAD_URL');
  }
  // Only ever send our YCloud key to YCloud itself.
  const headers: Record<string, string> = {};
  if (ycloudApiKey && (url.hostname === 'ycloud.com' || url.hostname.endsWith('.ycloud.com'))) {
    headers['X-API-Key'] = ycloudApiKey;
  }

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) {
    throw new ExternalServiceError('Voice note download', `HTTP ${res.status}`, { statusCode: res.status });
  }
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length === 0 || data.length > MAX_AUDIO_BYTES) {
    throw new AppError(`Voice note size out of range (${data.length} bytes)`, 400, 'TRANSCRIPTION_BAD_SIZE');
  }

  // "audio/ogg; codecs=opus" -> "audio/ogg"
  const mimeType = ((audio.mimeType || res.headers.get('content-type') || 'audio/ogg').split(';')[0] ?? 'audio/ogg').trim();
  return { data, mimeType };
}

let activeTranscriber: Transcriber | null | undefined;

/** Returns null when voice transcription is not configured. */
export function getTranscriber(): Transcriber | null {
  if (activeTranscriber !== undefined) return activeTranscriber;
  const config = getConfig();
  if (!config.TRANSCRIBE_API_KEY) {
    logger.warn('TRANSCRIBE_API_KEY not set: voice notes are disabled');
    activeTranscriber = null;
  } else if (config.TRANSCRIBE_PROVIDER === 'groq') {
    activeTranscriber = new GroqTranscriber(config.TRANSCRIBE_API_KEY, config.TRANSCRIBE_MODEL, config.YCLOUD_API_KEY);
  } else {
    activeTranscriber = new GeminiTranscriber(config.TRANSCRIBE_API_KEY, config.TRANSCRIBE_MODEL, config.YCLOUD_API_KEY);
  }
  return activeTranscriber;
}

export function setTranscriberForTesting(t: Transcriber | null | undefined): void {
  activeTranscriber = t;
}
