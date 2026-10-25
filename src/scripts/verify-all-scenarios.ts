import { config as dotenvConfig } from 'dotenv';
dotenvConfig();

import { getConfig } from '../config/env';
import { getDb } from '../db';
import { authChallenges, sessions } from '../db/schema';
import { eq, desc } from 'drizzle-orm';
import { computeOtpHash, hashSessionToken } from '../utils/otp';

const config = getConfig();
const BASE_URL = process.env.BASE_URL || `http://localhost:${config.PORT}`;
const HMAC_SECRET = config.AUTH_OTP_HMAC_SECRET;

interface TestResult {
  suite: string;
  scenario: string;
  passed: boolean;
  details: string;
  statusCode?: number;
}

const results: TestResult[] = [];

function record(suite: string, scenario: string, passed: boolean, details: string, statusCode?: number) {
  results.push({ suite, scenario, passed, details, statusCode });
  const statusIcon = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`[${statusIcon}] [${suite}] ${scenario} (${statusCode !== undefined ? statusCode : 'N/A'}): ${details}`);
}

/**
 * Resolves a 6-digit OTP from its keyed HMAC-SHA256 hash using the server secret.
 * Searches 100,000 - 999,999 in ~1 second.
 */
function resolveOtpFromHash(expectedHash: string, purpose: 'phone_verification' | 'email_verification', target: string): string | null {
  for (let i = 100000; i <= 999999; i++) {
    const candidate = i.toString();
    const hash = computeOtpHash(candidate, purpose, target, HMAC_SECRET);
    if (hash === expectedHash) {
      return candidate;
    }
  }
  return null;
}

async function request(path: string, options: RequestInit = {}): Promise<{ status: number; body: any }> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-test-bypass-rate-limit': 'true',
    ...(options.headers as Record<string, string> || {}),
  };

  const res = await fetch(url, { ...options, headers });
  let body: any;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function runAllScenarios() {
  console.log(`\n======================================================`);
  console.log(`  STARTING COMPLETE AUTHENTICATION SCENARIOS VERIFICATION`);
  console.log(`  Target: ${BASE_URL}`);
  console.log(`======================================================\n`);

  const db = getDb();
  const runId = Date.now().toString().slice(-6);

  // ---------------------------------------------------------
  // SUITE 1: Input Validation
  // ---------------------------------------------------------
  console.log('\n--- SUITE 1: Input Validation ---');

  // 1.1 Missing fields on start
  const v1 = await request('/api/auth/start', { method: 'POST', body: JSON.stringify({}) });
  record('Input Validation', 'Reject empty body on /api/auth/start', v1.status === 400 && v1.body?.code === 'BAD_REQUEST', `Status: ${v1.status}, Code: ${v1.body?.code}`, v1.status);

  // 1.2 Invalid phone format
  const v2 = await request('/api/auth/start', {
    method: 'POST',
    body: JSON.stringify({ phoneNumber: '12345', email: 'test@example.com' }),
  });
  record('Input Validation', 'Reject non-E.164 phone number', v2.status === 400, `Message: ${v2.body?.message}`, v2.status);

  // 1.3 Invalid email format
  const v3 = await request('/api/auth/start', {
    method: 'POST',
    body: JSON.stringify({ phoneNumber: '+15551234567', email: 'not-an-email' }),
  });
  record('Input Validation', 'Reject invalid email syntax', v3.status === 400, `Message: ${v3.body?.message}`, v3.status);

  // 1.4 Non-6-digit OTP verification codes
  const v4 = await request('/api/auth/challenge/phone/verify', {
    method: 'POST',
    body: JSON.stringify({ authFlowId: '00000000-0000-0000-0000-000000000000', code: '123' }),
  });
  record('Input Validation', 'Reject short 3-digit OTP code', v4.status === 400, `Message: ${v4.body?.message}`, v4.status);

  const v5 = await request('/api/auth/challenge/email/verify', {
    method: 'POST',
    body: JSON.stringify({ authFlowId: '00000000-0000-0000-0000-000000000000', code: 'abcdef' }),
  });
  record('Input Validation', 'Reject non-numeric letters OTP code', v5.status === 400, `Message: ${v5.body?.message}`, v5.status);

  // ---------------------------------------------------------
  // SUITE 2: Input Normalization
  // ---------------------------------------------------------
  console.log('\n--- SUITE 2: Input Normalization ---');

  const messyPhone = `  +1 (555) 345-${runId}  `;
  const messyEmail = `  USER.NORMALIZATION+${runId}@EXAMPLE.COM  `;
  const normRes = await request('/api/auth/start', {
    method: 'POST',
    body: JSON.stringify({ phoneNumber: messyPhone, email: messyEmail }),
  });

  const expectedCleanPhone = `+1555345${runId}`;
  const expectedCleanEmail = `user.normalization+${runId}@example.com`;

  const normPassed =
    normRes.status === 200 &&
    normRes.body?.data?.phoneNumber === expectedCleanPhone &&
    normRes.body?.data?.email === expectedCleanEmail;

  record(
    'Input Normalization',
    'Normalize E.164 phone and lowercase trimmed email',
    normPassed,
    `Clean phone: ${normRes.body?.data?.phoneNumber}, Clean email: ${normRes.body?.data?.email}`,
    normRes.status
  );

  // ---------------------------------------------------------
  // SUITE 3: Resend Cooldown Rate Limiting (60 seconds)
  // ---------------------------------------------------------
  console.log('\n--- SUITE 3: Resend Cooldown Rate Limiting ---');

  const cooldownFlowId = normRes.body?.data?.authFlowId;

  // Send first phone OTP
  const s1 = await request('/api/auth/challenge/phone/send', {
    method: 'POST',
    body: JSON.stringify({ authFlowId: cooldownFlowId }),
  });
  record('Resend Cooldown', 'Initial phone OTP send succeeds', s1.status === 200 && s1.body?.data?.accepted === true, `cooldownSeconds: ${s1.body?.data?.cooldownSeconds}`, s1.status);

  // Immediate second phone OTP send (should get 429)
  const s2 = await request('/api/auth/challenge/phone/send', {
    method: 'POST',
    body: JSON.stringify({ authFlowId: cooldownFlowId }),
  });
  record('Resend Cooldown', 'Immediate second phone OTP send blocked with 429 Too Many Requests', s2.status === 429, `Message: ${s2.body?.message}`, s2.status);

  // Send first email OTP
  const e1 = await request('/api/auth/challenge/email/send', {
    method: 'POST',
    body: JSON.stringify({ authFlowId: cooldownFlowId }),
  });
  record('Resend Cooldown', 'Initial email OTP send succeeds', e1.status === 200 && e1.body?.data?.accepted === true, `cooldownSeconds: ${e1.body?.data?.cooldownSeconds}`, e1.status);

  // Immediate second email OTP send (should get 429)
  const e2 = await request('/api/auth/challenge/email/send', {
    method: 'POST',
    body: JSON.stringify({ authFlowId: cooldownFlowId }),
  });
  record('Resend Cooldown', 'Immediate second email OTP send blocked with 429 Too Many Requests', e2.status === 429, `Message: ${e2.body?.message}`, e2.status);

  // ---------------------------------------------------------
  // SUITE 4: Attempt Limits & Lockout Protection
  // ---------------------------------------------------------
  console.log('\n--- SUITE 4: Attempt Limits & Lockout Protection ---');

  const lockoutPhone = `+1555444${runId}`;
  const lockoutEmail = `lockout+${runId}@example.com`;

  const lockoutStart = await request('/api/auth/start', {
    method: 'POST',
    body: JSON.stringify({ phoneNumber: lockoutPhone, email: lockoutEmail }),
  });
  const lockoutFlowId = lockoutStart.body?.data?.authFlowId;

  await request('/api/auth/challenge/phone/send', {
    method: 'POST',
    body: JSON.stringify({ authFlowId: lockoutFlowId }),
  });

  // Attempt 1: Wrong code
  const a1 = await request('/api/auth/challenge/phone/verify', {
    method: 'POST',
    body: JSON.stringify({ authFlowId: lockoutFlowId, code: '000000' }),
  });
  const a1Pass = a1.status === 400 && a1.body?.message?.includes('2 attempts remaining');
  record('Attempt Limits', 'Wrong code attempt 1: decrements remaining to 2', a1Pass, `Message: ${a1.body?.message}`, a1.status);

  // Attempt 2: Wrong code
  const a2 = await request('/api/auth/challenge/phone/verify', {
    method: 'POST',
    body: JSON.stringify({ authFlowId: lockoutFlowId, code: '000000' }),
  });
  const a2Pass = a2.status === 400 && a2.body?.message?.includes('1 attempt remaining');
  record('Attempt Limits', 'Wrong code attempt 2: decrements remaining to 1', a2Pass, `Message: ${a2.body?.message}`, a2.status);

  // Attempt 3: Wrong code -> locks challenge
  const a3 = await request('/api/auth/challenge/phone/verify', {
    method: 'POST',
    body: JSON.stringify({ authFlowId: lockoutFlowId, code: '000000' }),
  });
  const a3Pass = a3.status === 400 && (a3.body?.message?.includes('Maximum attempts') || a3.body?.message?.includes('locked'));
  record('Attempt Limits', 'Wrong code attempt 3: locks challenge (Max attempts exceeded)', a3Pass, `Message: ${a3.body?.message}`, a3.status);

  // Attempt 4: Even on subsequent attempts, challenge remains locked
  const a4 = await request('/api/auth/challenge/phone/verify', {
    method: 'POST',
    body: JSON.stringify({ authFlowId: lockoutFlowId, code: '000000' }),
  });
  const a4Pass = a4.status === 400 && (a4.body?.message?.includes('locked') || a4.body?.message?.includes('Maximum verification attempts'));
  record('Attempt Limits', 'Subsequent attempt on locked challenge is strictly rejected', a4Pass, `Message: ${a4.body?.message}`, a4.status);

  // ---------------------------------------------------------
  // SUITE 5: Full Dual-Channel Registration Happy Path
  // ---------------------------------------------------------
  console.log('\n--- SUITE 5: Full Dual-Channel Registration Happy Path ---');

  const happyPhone = `+1555888${runId}`;
  const happyEmail = `happy.path+${runId}@example.com`;

  // Step 5.1: Start auth
  const happyStart = await request('/api/auth/start', {
    method: 'POST',
    body: JSON.stringify({ phoneNumber: happyPhone, email: happyEmail }),
  });
  const happyFlowId = happyStart.body?.data?.authFlowId;
  record(
    'Registration Happy Path',
    'Start dual-channel flow initializes pending user state',
    happyStart.status === 200 && happyStart.body?.data?.phoneVerified === false && happyStart.body?.data?.emailVerified === false,
    `authFlowId: ${happyFlowId}`,
    happyStart.status
  );

  // Step 5.2: Send phone OTP
  const happyPhoneSend = await request('/api/auth/challenge/phone/send', {
    method: 'POST',
    body: JSON.stringify({ authFlowId: happyFlowId }),
  });
  record('Registration Happy Path', 'Dispatch phone OTP challenge', happyPhoneSend.status === 200, `Accepted: ${happyPhoneSend.body?.data?.accepted}`, happyPhoneSend.status);

  // Find phone OTP hash in DB
  const phoneChallenges = await db
    .select()
    .from(authChallenges)
    .where(eq(authChallenges.authFlowId, happyFlowId))
    .orderBy(desc(authChallenges.createdAt))
    .limit(1);

  const phoneChallengeRow = phoneChallenges[0]!;
  const phoneOtpCode = resolveOtpFromHash(phoneChallengeRow.otpHash, 'phone_verification', happyPhone)!;
  record('Registration Happy Path', 'Resolve cryptographically bound phone OTP', !!phoneOtpCode, `OTP resolved: ${phoneOtpCode ? 'YES (' + phoneOtpCode + ')' : 'NO'}`);

  // Step 5.3: Verify phone OTP
  const happyPhoneVerify = await request('/api/auth/challenge/phone/verify', {
    method: 'POST',
    body: JSON.stringify({ authFlowId: happyFlowId, code: phoneOtpCode }),
  });
  const phoneVerifyPass =
    happyPhoneVerify.status === 200 &&
    happyPhoneVerify.body?.data?.phoneVerified === true &&
    happyPhoneVerify.body?.data?.emailVerified === false &&
    !happyPhoneVerify.body?.data?.session;

  record(
    'Registration Happy Path',
    'Phone OTP verified: phoneVerified=true, emailVerified=false, no session issued yet',
    phoneVerifyPass,
    `phoneVerified: ${happyPhoneVerify.body?.data?.phoneVerified}, session: ${happyPhoneVerify.body?.data?.session}`,
    happyPhoneVerify.status
  );

  // Step 5.4: Send email OTP
  const happyEmailSend = await request('/api/auth/challenge/email/send', {
    method: 'POST',
    body: JSON.stringify({ authFlowId: happyFlowId }),
  });
  record('Registration Happy Path', 'Dispatch email OTP challenge', happyEmailSend.status === 200, `Accepted: ${happyEmailSend.body?.data?.accepted}`, happyEmailSend.status);

  // Find email OTP hash in DB
  const emailChallenges = await db
    .select()
    .from(authChallenges)
    .where(eq(authChallenges.authFlowId, happyFlowId))
    .orderBy(desc(authChallenges.createdAt))
    .limit(1);

  const emailChallengeRow = emailChallenges[0]!;
  const emailOtpCode = resolveOtpFromHash(emailChallengeRow.otpHash, 'email_verification', happyEmail)!;
  record('Registration Happy Path', 'Resolve cryptographically bound email OTP', !!emailOtpCode, `OTP resolved: ${emailOtpCode ? 'YES (' + emailOtpCode + ')' : 'NO'}`);

  // Step 5.5: Verify email OTP -> Full session issuance!
  const happyEmailVerify = await request('/api/auth/challenge/email/verify', {
    method: 'POST',
    body: JSON.stringify({ authFlowId: happyFlowId, code: emailOtpCode }),
  });

  const sessionToken = happyEmailVerify.body?.data?.session?.sessionToken;
  const happyFullPass =
    happyEmailVerify.status === 200 &&
    happyEmailVerify.body?.data?.isFullyVerified === true &&
    happyEmailVerify.body?.data?.phoneVerified === true &&
    happyEmailVerify.body?.data?.emailVerified === true &&
    typeof sessionToken === 'string' &&
    sessionToken.length === 64;

  record(
    'Registration Happy Path',
    'Email OTP verified: isFullyVerified=true, 64-char hex session token successfully issued',
    happyFullPass,
    `Token length: ${sessionToken?.length}, User ID: ${happyEmailVerify.body?.data?.user?.id}`,
    happyEmailVerify.status
  );

  // ---------------------------------------------------------
  // SUITE 6: Protected Session Endpoint Access (/api/auth/me)
  // ---------------------------------------------------------
  console.log('\n--- SUITE 6: Session Endpoints & Middleware ---');

  // 6.1 Valid Bearer Token
  const meRes = await request('/api/auth/me', {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  const mePass =
    meRes.status === 200 &&
    meRes.body?.data?.user?.phoneNumber === happyPhone &&
    meRes.body?.data?.user?.email === happyEmail;

  record(
    'Session Authentication',
    'GET /api/auth/me with valid Bearer token returns 200 OK & active user profile',
    mePass,
    `User ID: ${meRes.body?.data?.user?.id}, Phone: ${meRes.body?.data?.user?.phoneNumber}`,
    meRes.status
  );

  // 6.2 Missing Authorization Header
  const unauthRes = await request('/api/auth/me');
  record('Session Authentication', 'GET /api/auth/me without Bearer header returns 401 Unauthorized', unauthRes.status === 401, `Message: ${unauthRes.body?.message}`, unauthRes.status);

  // 6.3 Tampered / Invalid Bearer Token
  const badTokenRes = await request('/api/auth/me', {
    headers: { Authorization: `Bearer ${sessionToken ? sessionToken.slice(0, 32) + 'deadbeef' : 'invalid'}` },
  });
  record('Session Authentication', 'GET /api/auth/me with invalid token returns 401 Unauthorized', badTokenRes.status === 401, `Message: ${badTokenRes.body?.message}`, badTokenRes.status);

  // ---------------------------------------------------------
  // SUITE 7: Replay Protection
  // ---------------------------------------------------------
  console.log('\n--- SUITE 7: Replay Protection ---');

  // Attempt to reuse already verified phone OTP code
  const replayPhone = await request('/api/auth/challenge/phone/verify', {
    method: 'POST',
    body: JSON.stringify({ authFlowId: happyFlowId, code: phoneOtpCode }),
  });
  record('Replay Protection', 'Resubmitting already verified phone OTP rejected with 400', replayPhone.status === 400, `Message: ${replayPhone.body?.message}`, replayPhone.status);

  // Attempt to reuse already verified email OTP code
  const replayEmail = await request('/api/auth/challenge/email/verify', {
    method: 'POST',
    body: JSON.stringify({ authFlowId: happyFlowId, code: emailOtpCode }),
  });
  record('Replay Protection', 'Resubmitting already verified email OTP rejected with 400', replayEmail.status === 400, `Message: ${replayEmail.body?.message}`, replayEmail.status);

  // ---------------------------------------------------------
  // SUITE 8: Session Revocation / Logout (/api/auth/logout)
  // ---------------------------------------------------------
  console.log('\n--- SUITE 8: Session Revocation / Logout ---');

  const logoutRes = await request('/api/auth/logout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  record('Session Logout', 'POST /api/auth/logout with Bearer token successfully invalidates session', logoutRes.status === 200, `Message: ${logoutRes.body?.message}`, logoutRes.status);

  // Verify token is immediately dead
  const deadTokenRes = await request('/api/auth/me', {
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  record(
    'Session Logout',
    'Revoked session token immediately rejected with 401 Unauthorized',
    deadTokenRes.status === 401,
    `Message: ${deadTokenRes.body?.message}`,
    deadTokenRes.status
  );

  // ---------------------------------------------------------
  // SUITE 9: Cross-Account Identity Conflict Protection
  // ---------------------------------------------------------
  console.log('\n--- SUITE 9: Cross-Account Conflict Protection ---');

  // Create a second distinct user
  const userBPhone = `+1555999${runId}`;
  const userBEmail = `userb+${runId}@example.com`;
  const userBStart = await request('/api/auth/start', {
    method: 'POST',
    body: JSON.stringify({ phoneNumber: userBPhone, email: userBEmail }),
  });
  const userBFlowId = userBStart.body?.data?.authFlowId;

  // Complete User B registration
  await request('/api/auth/challenge/phone/send', { method: 'POST', body: JSON.stringify({ authFlowId: userBFlowId }) });
  const uBPhoneChall = (await db.select().from(authChallenges).where(eq(authChallenges.authFlowId, userBFlowId)).orderBy(desc(authChallenges.createdAt)).limit(1))[0]!;
  const uBPhoneOtp = resolveOtpFromHash(uBPhoneChall.otpHash, 'phone_verification', userBPhone)!;
  await request('/api/auth/challenge/phone/verify', { method: 'POST', body: JSON.stringify({ authFlowId: userBFlowId, code: uBPhoneOtp }) });

  await request('/api/auth/challenge/email/send', { method: 'POST', body: JSON.stringify({ authFlowId: userBFlowId }) });
  const uBEmailChall = (await db.select().from(authChallenges).where(eq(authChallenges.authFlowId, userBFlowId)).orderBy(desc(authChallenges.createdAt)).limit(1))[0]!;
  const uBEmailOtp = resolveOtpFromHash(uBEmailChall.otpHash, 'email_verification', userBEmail)!;
  await request('/api/auth/challenge/email/verify', { method: 'POST', body: JSON.stringify({ authFlowId: userBFlowId, code: uBEmailOtp }) });

  // Now: Attempt to start an auth flow pairing Happy User's phone with User B's email!
  const conflictRes = await request('/api/auth/start', {
    method: 'POST',
    body: JSON.stringify({ phoneNumber: happyPhone, email: userBEmail }),
  });
  const conflictPass = conflictRes.status === 409;
  record(
    'Cross-Account Security',
    'Starting flow combining User A phone with User B email returns 409 Conflict',
    conflictPass,
    `Message: ${conflictRes.body?.message}`,
    conflictRes.status
  );

  // ---------------------------------------------------------
  // SUITE 10: Cryptographic Security & Zero Plaintext DB Audit
  // ---------------------------------------------------------
  console.log('\n--- SUITE 10: Cryptographic Security & DB Audit ---');

  // Check auth_challenges table for happyFlowId
  const dbChallenges = await db
    .select()
    .from(authChallenges)
    .where(eq(authChallenges.authFlowId, happyFlowId));

  let challengesValid = dbChallenges.length >= 2;
  for (const chall of dbChallenges) {
    if (typeof chall.otpHash !== 'string' || chall.otpHash.length !== 64) {
      challengesValid = false;
    }
  }
  record(
    'Cryptographic Storage',
    'OTP hashes in auth_challenges are 64-char HMAC-SHA256 hex strings (No plaintext OTP)',
    challengesValid,
    `Challenges verified: ${dbChallenges.length}`
  );

  // Check sessions table
  const dbSessions = await db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, happyEmailVerify.body?.data?.user?.id));

  const sessionRow = dbSessions[0];
  const expectedTokenHash = hashSessionToken(sessionToken);
  const sessionValid =
    sessionRow &&
    sessionRow.tokenHash === expectedTokenHash &&
    sessionRow.tokenHash !== sessionToken &&
    sessionRow.tokenHash.length === 64 &&
    sessionRow.revokedAt !== null;

  record(
    'Cryptographic Storage',
    'Session token_hash in user_sessions is 64-char SHA-256 (Raw token never stored; Revocation recorded)',
    Boolean(sessionValid),
    `Stored hash: ${sessionRow?.tokenHash?.slice(0, 16)}..., Revoked: ${!!sessionRow?.revokedAt}`
  );

  // ---------------------------------------------------------
  // FINAL SUMMARY
  // ---------------------------------------------------------
  console.log('\n======================================================');
  console.log('                 TEST RESULTS SUMMARY                 ');
  console.log('======================================================');

  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log(`Total Scenarios Tested : ${total}`);
  console.log(`Passed                 : ${passed}`);
  console.log(`Failed                 : ${failed}`);
  console.log('======================================================\n');

  if (failed > 0) {
    console.error(`💥 ${failed} scenario(s) failed verification!`);
    process.exit(1);
  } else {
    console.log('🎉 ALL AUTHENTICATION SCENARIOS PASSED PERFECTLY!');
    process.exit(0);
  }
}

runAllScenarios().catch((err) => {
  console.error('Fatal runner error:', err);
  process.exit(1);
});
