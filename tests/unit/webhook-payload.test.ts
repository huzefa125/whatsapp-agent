import { describe, it, expect } from 'vitest';
import { verifyWebhookChallenge, parseWebhookPayload } from '../../src/services/whatsapp/webhook';
import { ParsedTextMessageEvent, ParsedUnsupportedMediaEvent, ParsedStatusEvent } from '../../src/services/whatsapp/types';

describe('WhatsApp Webhook Payload Processing', () => {
  describe('verifyWebhookChallenge', () => {
    const configuredToken = 'valid_verify_token_123';

    it('returns challenge string on valid mode and token', () => {
      const query = {
        'hub.mode': 'subscribe',
        'hub.verify_token': configuredToken,
        'hub.challenge': '1234567890',
      };
      const result = verifyWebhookChallenge(query, configuredToken);
      expect(result).toBe('1234567890');
    });

    it('rejects if hub.mode is not subscribe', () => {
      const query = {
        'hub.mode': 'other',
        'hub.verify_token': configuredToken,
        'hub.challenge': '1234567890',
      };
      expect(verifyWebhookChallenge(query, configuredToken)).toBeNull();
    });

    it('rejects if hub.verify_token does not match', () => {
      const query = {
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong_token',
        'hub.challenge': '1234567890',
      };
      expect(verifyWebhookChallenge(query, configuredToken)).toBeNull();
    });

    it('rejects if challenge is missing or not a string', () => {
      const query = {
        'hub.mode': 'subscribe',
        'hub.verify_token': configuredToken,
      };
      expect(verifyWebhookChallenge(query, configuredToken)).toBeNull();
    });
  });

  describe('parseWebhookPayload', () => {
    it('parses valid incoming text messages', () => {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'ENTRY_1',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '15551234567',
                    phone_number_id: 'PN_ID_100',
                  },
                  contacts: [
                    {
                      profile: { name: 'Alice Smith' },
                      wa_id: '15559876543',
                    },
                  ],
                  messages: [
                    {
                      from: '15559876543',
                      id: 'wamid.HBgLMTU1NTk4NzY1NDM=',
                      timestamp: '1700000000',
                      type: 'text',
                      text: {
                        body: 'Hello Instinct Agent!',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const events = parseWebhookPayload(payload);
      expect(events).toHaveLength(1);
      const event = events[0] as ParsedTextMessageEvent;
      expect(event.type).toBe('text_message');
      expect(event.senderPhoneNumber).toBe('15559876543');
      expect(event.senderName).toBe('Alice Smith');
      expect(event.text).toBe('Hello Instinct Agent!');
      expect(event.providerMessageId).toBe('wamid.HBgLMTU1NTk4NzY1NDM=');
      expect(event.phoneNumberId).toBe('PN_ID_100');
    });

    it('parses unsupported media (e.g. voice note / audio) gracefully', () => {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'ENTRY_2',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '15551234567',
                    phone_number_id: 'PN_ID_100',
                  },
                  messages: [
                    {
                      from: '15559876543',
                      id: 'wamid.AUDIO_MSG_1',
                      timestamp: '1700000005',
                      type: 'audio',
                      audio: {
                        id: 'media_id_audio_1',
                        voice: true,
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const events = parseWebhookPayload(payload);
      expect(events).toHaveLength(1);
      const event = events[0] as ParsedUnsupportedMediaEvent;
      expect(event.type).toBe('unsupported_media');
      expect(event.mediaType).toBe('audio');
      expect(event.providerMessageId).toBe('wamid.AUDIO_MSG_1');
    });

    it('parses status receipts (delivered / read)', () => {
      const payload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'ENTRY_3',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  metadata: {
                    display_phone_number: '15551234567',
                    phone_number_id: 'PN_ID_100',
                  },
                  statuses: [
                    {
                      id: 'wamid.HBgLMTU1NTk4NzY1NDM=',
                      status: 'delivered',
                      timestamp: '1700000010',
                      recipient_id: '15559876543',
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const events = parseWebhookPayload(payload);
      expect(events).toHaveLength(1);
      const event = events[0] as ParsedStatusEvent;
      expect(event.type).toBe('status_update');
      expect(event.status).toBe('delivered');
      expect(event.recipientPhoneNumber).toBe('15559876543');
    });

    it('ignores invalid objects or empty payloads safely', () => {
      expect(parseWebhookPayload(null)[0]?.type).toBe('ignored');
      expect(parseWebhookPayload({})[0]?.type).toBe('ignored');
      expect(parseWebhookPayload({ object: 'page' })[0]?.type).toBe('ignored');
      expect(parseWebhookPayload({ object: 'whatsapp_business_account', entry: [] })[0]?.type).toBe('ignored');
    });
  });
});
