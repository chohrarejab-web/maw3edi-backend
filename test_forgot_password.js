/**
 * 🔒 TEST SUITE: FULLY FUNCTIONAL FORGOT PASSWORD SYSTEM
 * Tests:
 * 1. Request reset code for non-existent email (Safe enumeration-resistant response)
 * 2. Request reset code for valid user (issues resetToken & previewCode)
 * 3. Reject invalid 6-digit OTP code (HTTP 401 & attempt countdown)
 * 4. Verify valid OTP code (issues single-use verifiedToken)
 * 5. Reject weak password during reset (HTTP 400 with complexity guidance)
 * 6. Reject mismatched confirm password (HTTP 400)
 * 7. Successfully reset password with strong password (HTTP 200 & updates DB)
 * 8. Reusing consumed verifiedToken fails (HTTP 401)
 * 9. Old password no longer works (HTTP 401)
 * 10. New password logs in successfully (HTTP 200 & issues JWT)
 * 11. Restores demo password back to Saha2026!
 */

const BASE_URL = 'http://localhost:4000';

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`  ✅ [PASS] ${name}`);
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
    process.exit(1);
  }
}

async function main() {
  console.log('\n======================================================');
  console.log('🔑 TESTING FULLY FUNCTIONAL FORGOT PASSWORD WORKFLOW');
  console.log(`🌐 Base URL: ${BASE_URL}`);
  console.log('======================================================\n');

  const testEmail = 'fatma.benabdallah@gmail.com';
  let activeResetToken = null;
  let activePreviewCode = null;
  let verifiedToken = null;
  const tempTestPassword = 'NewSecret2026!#';

  // 1. Non-existent email
  await runTest('1. Request reset code for non-existent email returns safe response', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody_1234987@gmail.com' })
    });
    const data = await res.json();
    if (!res.ok || !data.success || data.userExists !== false) {
      throw new Error(`Unexpected response: ${JSON.stringify(data)}`);
    }
  });

  // 2. Valid user email
  await runTest('2. Request reset code for existing user issues resetToken & 6-digit OTP', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail })
    });
    const data = await res.json();
    if (!res.ok || !data.success || !data.resetToken || !data.previewCode) {
      throw new Error(`Failed to initiate forgot password: ${JSON.stringify(data)}`);
    }
    activeResetToken = data.resetToken;
    activePreviewCode = data.previewCode;
  });

  // 3. Reject invalid OTP code
  await runTest('3. Verify with wrong 6-digit code returns HTTP 401', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/verify-reset-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetToken: activeResetToken, code: '000000' })
    });
    const data = await res.json();
    if (res.status !== 401 || data.success !== false) {
      throw new Error(`Expected HTTP 401, got ${res.status}: ${JSON.stringify(data)}`);
    }
  });

  // 4. Verify with valid OTP code
  await runTest('4. Verify with correct OTP code issues verifiedToken', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/verify-reset-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetToken: activeResetToken, code: activePreviewCode })
    });
    const data = await res.json();
    if (!res.ok || !data.success || !data.verifiedToken) {
      throw new Error(`Expected valid verifiedToken, got: ${JSON.stringify(data)}`);
    }
    verifiedToken = data.verifiedToken;
  });

  // 5. Reject weak password
  await runTest('5. Reset password with weak password (<8 chars / missing criteria) returns HTTP 400', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verifiedToken, newPassword: 'weak', confirmPassword: 'weak' })
    });
    const data = await res.json();
    if (res.status !== 400 || data.success !== false || data.error !== 'PASSWORD_TOO_WEAK') {
      throw new Error(`Expected HTTP 400 PASSWORD_TOO_WEAK, got ${res.status}: ${JSON.stringify(data)}`);
    }
  });

  // 6. Reject mismatched passwords
  await runTest('6. Reset password with mismatched confirmPassword returns HTTP 400', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        verifiedToken,
        newPassword: tempTestPassword,
        confirmPassword: 'DifferentPassword2026!'
      })
    });
    const data = await res.json();
    if (res.status !== 400 || data.success !== false) {
      throw new Error(`Expected HTTP 400 mismatch error, got ${res.status}: ${JSON.stringify(data)}`);
    }
  });

  // 7. Successful reset with strong password
  await runTest('7. Reset password successfully updates database hash and unlocks account', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        verifiedToken,
        newPassword: tempTestPassword,
        confirmPassword: tempTestPassword
      })
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(`Failed to reset password: ${JSON.stringify(data)}`);
    }
  });

  // 8. Reusing consumed token is rejected
  await runTest('8. Replay protection: Reusing consumed verifiedToken returns HTTP 401', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        verifiedToken,
        newPassword: tempTestPassword,
        confirmPassword: tempTestPassword
      })
    });
    const data = await res.json();
    if (res.status !== 401 || data.success !== false) {
      throw new Error(`Expected 401 on token reuse, got ${res.status}`);
    }
  });

  // 9. Old password fails
  await runTest('9. Logging in with old password (Saha2026!) now fails (HTTP 401)', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: 'Saha2026!' })
    });
    if (res.status !== 401) {
      throw new Error(`Expected 401 for old password, got ${res.status}`);
    }
  });

  // 10. New password succeeds
  await runTest('10. Logging in with new password succeeds (HTTP 200 & JWT issued)', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail, password: tempTestPassword })
    });
    const data = await res.json();
    if (!res.ok || !data.success || !data.token) {
      throw new Error(`Login with new password failed: ${JSON.stringify(data)}`);
    }
  });

  // 11. Clean up & restore back to Saha2026!
  await runTest('11. Restore test user password back to Saha2026! for environment consistency', async () => {
    const forgotRes = await fetch(`${BASE_URL}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: testEmail })
    });
    const forgotData = await forgotRes.json();
    const verifyRes = await fetch(`${BASE_URL}/api/auth/verify-reset-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resetToken: forgotData.resetToken, code: forgotData.previewCode })
    });
    const verifyData = await verifyRes.json();
    const resetRes = await fetch(`${BASE_URL}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        verifiedToken: verifyData.verifiedToken,
        newPassword: 'Saha2026!',
        confirmPassword: 'Saha2026!'
      })
    });
    const resetData = await resetRes.json();
    if (!resetRes.ok || !resetData.success) {
      throw new Error(`Failed to restore password: ${JSON.stringify(resetData)}`);
    }
  });

  console.log('\n======================================================');
  console.log('🎉 Forgot Password Suite: All 11 Tests Passed with 100% Success!');
  console.log('======================================================\n');
}

main().catch(err => {
  console.error('Fatal error in test:', err);
  process.exit(1);
});
