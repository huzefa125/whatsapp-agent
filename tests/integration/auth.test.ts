import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { StubPhoneSender } from '../../src/services/auth/providers/stub-phone-sender';
import { StubEmailSender } from '../../src/services/auth/providers/stub-email-sender';
import {
  setPhoneOtpSenderForTesting,
  setEmailOtpSenderForTesting,
} from '../../src/services/auth/providers';

describe('Dual-Channel Passwordless Authentication Integration', () => {
  const app = createApp();
  let stubPhoneSender: StubPhoneSender;
  let stubEmailSender: StubEmailSender;
  let runId = 0;

  function uniqueTarget(prefix: string) {
    runId++;
    const num = Math.floor(1000000 + Math.random() * 8999999);
    return {
      phone: `+1555${num}`,
      email: `${prefix}-${num}@example.com`,
    };
  }

  beforeEach(() => {
    stubPhoneSender = new StubPhoneSender();
    stubEmailSender = new StubEmailSender();
    setPhoneOtpSenderForTesting(stubPhoneSender);
    setEmailOtpSenderForTesting(stubEmailSender);
  });

  it('completes the full dual-channel authentication flow and issues a secure session', async () => {
    const target = uniqueTarget('flow');
    const rawPhone = `  ${target.phone} `;
    const rawEmail = `  ${target.email.toUpperCase()} `;

    // 1. Initiate auth flow
    const startRes = await request(app)
      .post('/api/auth/start')
      .send({ phoneNumber: rawPhone, email: rawEmail });

    expect(startRes.status).toBe(200);
    expect(startRes.body.status).toBe('success');
    expect(startRes.body.data.phoneNumber).toBe(target.phone);
    expect(startRes.body.data.email).toBe(target.email);
    expect(startRes.body.data.phoneVerified).toBe(false);
    expect(startRes.body.data.emailVerified).toBe(false);

    const authFlowId = startRes.body.data.authFlowId;
    expect(authFlowId).toBeDefined();

    // 2. Dispatch Phone OTP via WhatsApp
    const sendPhoneRes = await request(app)
      .post('/api/auth/challenge/phone/send')
      .send({ authFlowId });

    expect(sendPhoneRes.status).toBe(200);
    expect(sendPhoneRes.body.data.accepted).toBe(true);
    expect(sendPhoneRes.body.data.channel).toBe('whatsapp');
    expect(stubPhoneSender.sentOtps).toHaveLength(1);

    const phoneOtp = stubPhoneSender.sentOtps[0]!.otp;

    // 3. Verify Phone OTP (Partial verification)
    const verifyPhoneRes = await request(app)
      .post('/api/auth/challenge/phone/verify')
      .send({ authFlowId, code: phoneOtp });

    expect(verifyPhoneRes.status).toBe(200);
    expect(verifyPhoneRes.body.data.phoneVerified).toBe(true);
    expect(verifyPhoneRes.body.data.emailVerified).toBe(false);
    expect(verifyPhoneRes.body.data.isFullyVerified).toBe(false);
    expect(verifyPhoneRes.body.data.session).toBeUndefined(); // NO session yet!

    // 4. Dispatch Email OTP via Transactional Email
    const sendEmailRes = await request(app)
      .post('/api/auth/challenge/email/send')
      .send({ authFlowId });

    expect(sendEmailRes.status).toBe(200);
    expect(sendEmailRes.body.data.accepted).toBe(true);
    expect(sendEmailRes.body.data.channel).toBe('email');
    expect(stubEmailSender.sentOtps).toHaveLength(1);

    const emailOtp = stubEmailSender.sentOtps[0]!.otp;

    // 5. Verify Email OTP (Dual verification completes!)
    const verifyEmailRes = await request(app)
      .post('/api/auth/challenge/email/verify')
      .send({ authFlowId, code: emailOtp });

    expect(verifyEmailRes.status).toBe(200);
    expect(verifyEmailRes.body.data.phoneVerified).toBe(true);
    expect(verifyEmailRes.body.data.emailVerified).toBe(true);
    expect(verifyEmailRes.body.data.isFullyVerified).toBe(true);

    const session = verifyEmailRes.body.data.session;
    expect(session).toBeDefined();
    expect(session.sessionToken).toBeDefined();
    expect(typeof session.sessionToken).toBe('string');
    expect(session.sessionToken.length).toBe(64);

    // 6. Access /api/auth/me with session bearer token
    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${session.sessionToken}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.data.user.phoneNumber).toBe(target.phone);
    expect(meRes.body.data.user.email).toBe(target.email);
    expect(meRes.body.data.user.phoneVerifiedAt).toBeDefined();
    expect(meRes.body.data.user.emailVerifiedAt).toBeDefined();

    // 7. Logout /api/auth/logout
    const logoutRes = await request(app)
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${session.sessionToken}`);

    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.status).toBe('success');

    // 8. Subsequent access must fail
    const postLogoutMeRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${session.sessionToken}`);

    expect(postLogoutMeRes.status).toBe(401);
  });

  it('rejects wrong OTP codes and locks the challenge after attempt limits are exceeded', async () => {
    const target = uniqueTarget('lockout');
    const startRes = await request(app)
      .post('/api/auth/start')
      .send({ phoneNumber: target.phone, email: target.email });

    const authFlowId = startRes.body.data.authFlowId;

    await request(app).post('/api/auth/challenge/phone/send').send({ authFlowId });

    // Attempt 1: wrong code
    const res1 = await request(app)
      .post('/api/auth/challenge/phone/verify')
      .send({ authFlowId, code: '000000' });
    expect(res1.status).toBe(400);
    expect(res1.body.message).toContain('2 attempts remaining');

    // Attempt 2: wrong code
    const res2 = await request(app)
      .post('/api/auth/challenge/phone/verify')
      .send({ authFlowId, code: '000000' });
    expect(res2.status).toBe(400);
    expect(res2.body.message).toContain('1 attempt remaining');

    // Attempt 3: wrong code -> locked!
    const res3 = await request(app)
      .post('/api/auth/challenge/phone/verify')
      .send({ authFlowId, code: '000000' });
    expect(res3.status).toBe(400);
    expect(res3.body.message).toContain('Maximum attempts reached; challenge is locked');

    // Attempt 4: challenge is locked
    const res4 = await request(app)
      .post('/api/auth/challenge/phone/verify')
      .send({ authFlowId, code: '000000' });
    expect(res4.status).toBe(400);
    expect(res4.body.message).toContain('Maximum verification attempts exceeded');
  });

  it('enforces resend cooldown and prevents rapid spamming of OTP dispatches', async () => {
    const target = uniqueTarget('cooldown');
    const startRes = await request(app)
      .post('/api/auth/start')
      .send({ phoneNumber: target.phone, email: target.email });

    const authFlowId = startRes.body.data.authFlowId;

    // Send 1st challenge
    const res1 = await request(app).post('/api/auth/challenge/phone/send').send({ authFlowId });
    expect(res1.status).toBe(200);

    // Send 2nd challenge immediately (< 60s) -> 429 RateLimitError
    const res2 = await request(app).post('/api/auth/challenge/phone/send').send({ authFlowId });
    expect(res2.status).toBe(429);
    expect(res2.body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(res2.body.message).toContain('Please wait');
  });

  it('prevents replay attacks on already verified challenges', async () => {
    const target = uniqueTarget('replay');
    const startRes = await request(app)
      .post('/api/auth/start')
      .send({ phoneNumber: target.phone, email: target.email });

    const authFlowId = startRes.body.data.authFlowId;

    const sendRes = await request(app).post('/api/auth/challenge/phone/send').send({ authFlowId });
    expect(sendRes.status).toBe(200);
    const otp = stubPhoneSender.sentOtps[0]!.otp;

    // Successful verify
    const verifyRes = await request(app)
      .post('/api/auth/challenge/phone/verify')
      .send({ authFlowId, code: otp });
    expect(verifyRes.status).toBe(200);

    // Replay attempt with same code
    const replayRes = await request(app)
      .post('/api/auth/challenge/phone/verify')
      .send({ authFlowId, code: otp });
    expect(replayRes.status).toBe(400);
    expect(replayRes.body.message).toContain('No pending phone verification challenge found');
  });

  it('retains partial verification and allows controlled retries when one channel fails delivery', async () => {
    const target = uniqueTarget('partial');
    const startRes = await request(app)
      .post('/api/auth/start')
      .send({ phoneNumber: target.phone, email: target.email });

    const authFlowId = startRes.body.data.authFlowId;

    // Verify phone
    const sendPhoneRes = await request(app).post('/api/auth/challenge/phone/send').send({ authFlowId });
    expect(sendPhoneRes.status).toBe(200);
    const phoneOtp = stubPhoneSender.sentOtps[0]!.otp;
    const phoneVerifyRes = await request(app)
      .post('/api/auth/challenge/phone/verify')
      .send({ authFlowId, code: phoneOtp });
    expect(phoneVerifyRes.body.data.phoneVerified).toBe(true);

    // Simulate email provider failure
    stubEmailSender.setSimulatedFailure(new Error('Email service temporarily unavailable'));

    const failedEmailSend = await request(app)
      .post('/api/auth/challenge/email/send')
      .send({ authFlowId });
    expect(failedEmailSend.status).toBe(502);

    // Recover email provider and retry
    stubEmailSender.setSimulatedFailure(null);

    const retryEmailSend = await request(app)
      .post('/api/auth/challenge/email/send')
      .send({ authFlowId });
    expect(retryEmailSend.status).toBe(200);

    const emailOtp = stubEmailSender.sentOtps[0]!.otp;
    const emailVerifyRes = await request(app)
      .post('/api/auth/challenge/email/verify')
      .send({ authFlowId, code: emailOtp });

    expect(emailVerifyRes.status).toBe(200);
    expect(emailVerifyRes.body.data.isFullyVerified).toBe(true);
    expect(emailVerifyRes.body.data.session).toBeDefined();
  });
});
