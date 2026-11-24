/**
 * SahaTN / Maw2idi — 2FA Two-Factor Authentication Test Suite
 */

const assert = require('assert');
const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';

async function run2FATests() {
  console.log('\n======================================================');
  console.log('🔒 TESTING TWO-FACTOR AUTHENTICATION (2FA / OTP)');
  console.log(`🌐 Base URL: ${BASE_URL}`);
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  async function check(name, fn) {
    try {
      await fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
      failed++;
    }
  }

  let tempToken = null;
  let previewCode = null;

  // 1. Initial login with require2FA: true returns 2FA challenge
  await check('1. Admin Login with require2FA triggers 2FA Challenge', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@sahatn.tn',
        password: 'Saha2026!',
        require2FA: true
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.requires2FA, true, 'Must require 2FA');
    assert.ok(data.tempToken, 'Must issue tempToken');
    assert.ok(data.previewCode, 'Must issue 6-digit previewCode for OTP');
    tempToken = data.tempToken;
    previewCode = data.previewCode;
  });

  // 2. Submitting wrong 2FA code returns 401
  await check('2. Invalid 2FA code returns HTTP 401', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/verify-2fa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tempToken,
        code: '000000'
      })
    });
    assert.strictEqual(res.status, 401);
    const data = await res.json();
    assert.strictEqual(data.success, false);
    assert.strictEqual(data.error, 'INVALID_2FA_CODE');
  });

  // 3. Resending 2FA code generates a new valid code
  let newCode = null;
  await check('3. Resending 2FA code refreshes OTP challenge', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/resend-2fa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tempToken })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.previewCode);
    newCode = data.previewCode;
  });

  // 4. Valid 2FA code completes authentication & returns signed JWT
  let finalToken = null;
  await check('4. Correct 2FA code validates and issues session JWT & cookie', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/verify-2fa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tempToken,
        code: newCode
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.user.role, 'SUPER_ADMIN');
    assert.ok(data.token, 'Final JWT token required');
    finalToken = data.token;
  });

  // 5. Reusing tempToken fails (replay attack protection)
  await check('5. Reusing used tempToken is rejected (Replay Protection)', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/verify-2fa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tempToken,
        code: newCode
      })
    });
    assert.strictEqual(res.status, 401);
    const data = await res.json();
    assert.strictEqual(data.error, '2FA_EXPIRED');
  });

  // 6. Verify hardcoded 123456 backdoor code is STRICTLY REJECTED
  await check('6. Hardcoded 123456 fallback code is REJECTED (HTTP 401)', async () => {
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'dr.selim@sahatn.tn',
        password: 'Saha2026!',
        require2FA: true
      })
    });
    const loginData = await loginRes.json();
    assert.ok(loginData.tempToken);

    const verifyRes = await fetch(`${BASE_URL}/api/auth/verify-2fa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tempToken: loginData.tempToken,
        code: loginData.previewCode === '123456' ? '000000' : '123456'
      })
    });
    assert.strictEqual(verifyRes.status, 401);
    const verifyData = await verifyRes.json();
    assert.strictEqual(verifyData.success, false);
  });

  console.log('\n======================================================');
  console.log(`🔒 2FA Security Results: ${passed} passed, ${failed} failed`);
  console.log('======================================================\n');

  if (failed > 0) process.exit(1);
}

run2FATests().catch(err => {
  console.error('Fatal error running 2FA tests:', err);
  process.exit(1);
});
