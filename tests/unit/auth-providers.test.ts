import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhatsAppPhoneSender } from '../../src/services/auth/providers/whatsapp-phone-sender';
import { StubPhoneSender } from '../../src/services/auth/providers/stub-phone-sender';
import { StubEmailSender } from '../../src/services/auth/providers/stub-email-sender';
import { setWhatsAppClientForTesting } from '../../src/services/whatsapp/client';

describe('Auth Provider Implementations', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('WhatsAppPhoneSender', () => {
    it('dispatches text message and returns accepted status', async () => {
      const mockWhatsAppClient = {
        sendTextMessage: vi.fn().mockResolvedValue({
          messagingProduct: 'whatsapp',
          providerMessageId: 'wamid.OTP_MSG_1',
          recipientId: '15551234567',
        }),
      };
      setWhatsAppClientForTesting(mockWhatsAppClient as any);

      const sender = new WhatsAppPhoneSender();
      const result = await sender.sendOtp('+15551234567', '492019');

      expect(result.status).toBe('accepted');
      expect(result.channel).toBe('whatsapp');
      expect(result.providerMessageId).toBe('wamid.OTP_MSG_1');
      expect(mockWhatsAppClient.sendTextMessage).toHaveBeenCalledWith({
        to: '+15551234567',
        text: expect.stringContaining('492019'),
      });
    });
  });

  describe('StubPhoneSender', () => {
    it('records sent OTPs and honors simulated failure', async () => {
      const stub = new StubPhoneSender();
      const res = await stub.sendOtp('+15559876543', '112233');

      expect(res.status).toBe('accepted');
      expect(stub.sentOtps).toHaveLength(1);
      expect(stub.sentOtps[0]?.otp).toBe('112233');

      stub.setSimulatedFailure(new Error('WhatsApp service down'));
      await expect(stub.sendOtp('+15559876543', '112233')).rejects.toThrow('WhatsApp service down');
    });
  });

  describe('StubEmailSender', () => {
    it('records sent email OTPs and honors simulated failure', async () => {
      const stub = new StubEmailSender();
      const res = await stub.sendOtp('test@example.com', '556677');

      expect(res.status).toBe('accepted');
      expect(stub.sentOtps).toHaveLength(1);
      expect(stub.sentOtps[0]?.otp).toBe('556677');

      stub.setSimulatedFailure(new Error('SMTP connection refused'));
      await expect(stub.sendOtp('test@example.com', '556677')).rejects.toThrow('SMTP connection refused');
    });
  });
});
