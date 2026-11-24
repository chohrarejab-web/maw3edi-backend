/**
 * Enterprise Security & Compliance Pack — Test Suite Phase 3
 * Validates:
 * 1. 2FA (Double Authentification) Login & Verification
 * 2. Public Prescription QR Anti-Fraud Verification & Tamper Detection
 * 3. Admin Security Command Center API (Overview, Unlock Account, Revoke Session, Encrypted Backup)
 * 4. IDOR Protection (Patient cross-record authorization barrier)
 */

const assert = require('assert');
const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';

async function runPhase3Tests() {
  console.log('\n======================================================');
  console.log('🛡️ ENTERPRISE SECURITY & COMPLIANCE TEST SUITE (PHASE 3)');
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

  let adminToken = null;
  let temp2FAToken = null;
  let preview2FACode = null;

  // 1. Admin 2FA Challenge Trigger
  await check('1. Admin Login triggers 2FA Challenge with OTP & tempToken', async () => {
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
    assert.strictEqual(data.requires2FA, true);
    assert.ok(data.tempToken);
    assert.ok(data.previewCode);
    temp2FAToken = data.tempToken;
    preview2FACode = data.previewCode;
  });

  // 2. Complete 2FA Verification and obtain JWT
  await check('2. 2FA Verification with previewCode issues valid admin JWT', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/verify-2fa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tempToken: temp2FAToken,
        code: preview2FACode
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.user.role, 'SUPER_ADMIN');
    assert.ok(data.token);
    adminToken = data.token;
  });

  // 3. Prescription QR Anti-Fraud Verification (Authentic Document)
  await check('3. Prescription QR Verification returns certified certificate & practitioner details', async () => {
    const res = await fetch(`${BASE_URL}/api/prescriptions/verify/sha256-085eb2e8d2a714af199e010d`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.verified, true);
    assert.ok(data.certificate);
    assert.strictEqual(data.certificate.authority, "Conseil National de l'Ordre des Médecins de Tunisie (CNOMT)");
    assert.ok(data.certificate.doctor);
    assert.ok(data.certificate.drugs.length > 0);
  });

  // 4. Prescription QR Tamper Detection (Tampered / Invalid Hash)
  await check('4. Falsified or non-existent prescription hash returns HTTP 404 & fraud alert', async () => {
    const res = await fetch(`${BASE_URL}/api/prescriptions/verify/fake-tampered-hash-9999`);
    assert.strictEqual(res.status, 404);
    const data = await res.json();
    assert.strictEqual(data.success, false);
    assert.strictEqual(data.verified, false);
    assert.strictEqual(data.alert, 'FRAUD_SUSPECTED');
  });

  // 5. Prescription Public URL Route redirects to certificate page
  await check('5. /verify/prescription/:hash redirects to frontend certificate portal', async () => {
    const res = await fetch(`${BASE_URL}/verify/prescription/sha256-085eb2e8d2a714af199e010d`, {
      redirect: 'manual'
    });
    assert.ok(res.status === 301 || res.status === 302);
    const location = res.headers.get('location');
    assert.ok(location.includes('/pages/Prescriptions/verify.html'));
  });

  // 6. Admin Security Overview Telemetry
  await check('6. GET /api/admin/security/overview returns active sessions, lockouts, & Merkle status', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/security/overview`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.stats);
    assert.ok(Array.isArray(data.activeSessions));
    assert.ok(Array.isArray(data.lockedAccounts));
    assert.strictEqual(data.stats.merkleIntegrity, 'INTACT');
  });

  // 7. Admin Account Unlock Action
  await check('7. POST /api/admin/security/unlock-account unlocks target account', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/security/unlock-account`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({ email: 'dr.test@sahatn.tn' })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
  });

  // 8. Admin Remote Session Revocation (Kill Switch)
  await check('8. POST /api/admin/security/revoke-session revokes active session', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/security/revoke-session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({ token: 'simulated-revoked-token-12345', email: 'test@sahatn.tn' })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
  });

  // 9. Admin AES-256-GCM Encrypted Database Backup
  await check('9. GET /api/admin/security/backup-encrypted exports authenticated AES-256-GCM dump', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/security/backup-encrypted`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.algorithm, 'AES-256-GCM');
    assert.ok(data.iv);
    assert.ok(data.authTag);
    assert.ok(data.ciphertext);
    assert.strictEqual(data.compliance, 'INPDP Loi 2004-63 & HIPAA');
  });

  // 10. IDOR Prevention: Patient cannot access another patient's medical records
  await check('10. IDOR Protection: Patient token blocked from accessing other patient records (HTTP 403)', async () => {
    // 10.1 Login as patient fatma
    const patientLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'fatma.benali@gmail.com', password: 'Saha2026!' })
    });
    const patientData = await patientLoginRes.json();
    const patientToken = patientData.token;

    // 10.2 Attempt to query someone else's patientId (e.g. usr-victim-999)
    const idorRes = await fetch(`${BASE_URL}/api/patient/profile?patientId=usr-victim-999`, {
      headers: { 'Authorization': `Bearer ${patientToken}` }
    });
    assert.strictEqual(idorRes.status, 403);
    const idorData = await idorRes.json();
    assert.strictEqual(idorData.success, false);
    assert.strictEqual(idorData.error, 'IDOR_ACCESS_DENIED');
  });

  console.log('\n======================================================');
  console.log(`🛡️ Enterprise Security Phase 3 Results: ${passed} passed, ${failed} failed`);
  console.log('======================================================\n');

  if (failed > 0) process.exit(1);
}

runPhase3Tests().catch(err => {
  console.error('Fatal error running Phase 3 tests:', err);
  process.exit(1);
});
