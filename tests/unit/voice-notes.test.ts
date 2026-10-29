import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseYCloudPayload } from '../../src/services/whatsapp/webhook';
import { GeminiTranscriber } from '../../src/services/transcription';

const inbound = (message: Record<string, unknown>) => ({
  type: 'whatsapp.inbound_message.received',
  whatsappInboundMessage: { id: 'm1', wamid: 'wamid.1', from: '+919898597656', to: '+919978719852', ...message },
});

describe('YCloud voice notes', () => {
  it('parses an audio message into a text_message event carrying the audio link', () => {
    const [event] = parseYCloudPayload(
      inbound({ type: 'audio', audio: { link: 'https://files.ycloud.com/a.ogg', mime_type: 'audio/ogg; codecs=opus' } })
    );
    expect(event).toMatchObject({
      type: 'text_message',
      text: '',
      senderPhoneNumber: '919898597656',
      audio: { url: 'https://files.ycloud.com/a.ogg', mimeType: 'audio/ogg; codecs=opus' },
    });
  });

  it('keeps audio without a link as unsupported media', () => {
    const [event] = parseYCloudPayload(inbound({ type: 'audio', audio: { id: 'x' } }));
    expect(event?.type).toBe('unsupported_media');
  });
});

describe('GeminiTranscriber', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('downloads the audio, sends it inline to Gemini and returns the transcript', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).startsWith('https://files.ycloud.com')) {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/ogg' } });
      }
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: ' remind me in 5 min ' }] } }] }), {
        status: 200,
      });
    });

    const t = new GeminiTranscriber('gem-key', 'gemini-3.5-flash', 'yc-key');
    const text = await t.transcribe({ url: 'https://files.ycloud.com/a.ogg', mimeType: 'audio/ogg; codecs=opus' });

    expect(text).toBe('remind me in 5 min');
    // YCloud key goes only to ycloud.com, and the audio mime type has its parameters stripped.
    expect((calls[0]!.init!.headers as Record<string, string>)['X-API-Key']).toBe('yc-key');
    const sent = JSON.parse(String(calls[1]!.init!.body));
    expect(sent.contents[0].parts[1].inline_data.mime_type).toBe('audio/ogg');
  });

  it('does not leak the YCloud key to other hosts', async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      if (String(url).startsWith('https://evil.example')) {
        headers = init!.headers as Record<string, string>;
        return new Response(new Uint8Array([1]), { status: 200 });
      }
      return new Response(JSON.stringify({ candidates: [] }), { status: 200 });
    });
    const t = new GeminiTranscriber('gem-key', 'm', 'yc-key');
    expect(await t.transcribe({ url: 'https://evil.example/a.ogg' })).toBe('');
    expect(headers['X-API-Key']).toBeUndefined();
  });
});
