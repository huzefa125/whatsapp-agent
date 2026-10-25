export interface MetaWebhookPayload {
  object: string;
  entry?: Array<{
    id: string;
    changes?: Array<{
      field: string;
      value: {
        messaging_product: string;
        metadata: {
          display_phone_number: string;
          phone_number_id: string;
        };
        contacts?: Array<{
          profile: {
            name?: string;
          };
          wa_id: string;
        }>;
        messages?: Array<{
          from: string;
          id: string;
          timestamp: string;
          type: 'text' | 'image' | 'audio' | 'voice' | 'video' | 'document' | 'location' | 'contacts' | 'interactive' | string;
          text?: {
            body: string;
          };
          image?: { id: string; mime_type?: string; sha256?: string; caption?: string };
          audio?: { id: string; mime_type?: string; voice?: boolean };
          document?: { id: string; filename?: string; mime_type?: string };
        }>;
        statuses?: Array<{
          id: string;
          status: 'sent' | 'delivered' | 'read' | 'failed';
          timestamp: string;
          recipient_id: string;
          errors?: Array<{ code: number; title: string; message?: string }>;
        }>;
      };
    }>;
  }>;
}

export type ParsedInboundEventType = 'text_message' | 'unsupported_media' | 'status_update' | 'ignored';

export interface ParsedTextMessageEvent {
  type: 'text_message';
  providerMessageId: string;
  senderPhoneNumber: string;
  senderName?: string;
  text: string;
  timestamp: Date;
  phoneNumberId: string;
  raw: unknown;
}

export interface ParsedUnsupportedMediaEvent {
  type: 'unsupported_media';
  providerMessageId: string;
  senderPhoneNumber: string;
  senderName?: string;
  mediaType: string;
  timestamp: Date;
  phoneNumberId: string;
  raw: unknown;
}

export interface ParsedStatusEvent {
  type: 'status_update';
  providerMessageId: string;
  recipientPhoneNumber: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: Date;
  errors?: Array<{ code: number; title: string; message?: string }>;
  raw: unknown;
}

export interface ParsedIgnoredEvent {
  type: 'ignored';
  reason: string;
}

export type ParsedWebhookEvent =
  | ParsedTextMessageEvent
  | ParsedUnsupportedMediaEvent
  | ParsedStatusEvent
  | ParsedIgnoredEvent;

export interface WhatsAppSendTextRequest {
  to: string;
  text: string;
  previewUrl?: boolean;
}

export interface WhatsAppSendMessageResult {
  messagingProduct: string;
  providerMessageId: string;
  recipientId: string;
}
