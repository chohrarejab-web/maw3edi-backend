/**
 * SahaTN / Maw2idi — Phase 2 Enterprise Security Verification Suite
 * 
 * Verifies:
 * 1. AES-256-GCM Field-Level EHR Encryption at Rest & Decryption in Memory
 * 2. Strict Password Complexity & Policy Enforcement
 * 3. Anti-Bruteforce Account Lockout (5 failed attempts -> HTTP 423)
 * 4. Immediate JWT Revocation on Logout (Token Blacklisting -> HTTP 401)
 * 5. HMAC-SHA256 Anti-CSRF Token Generation & Mutation Defense
 * 6. Prototype Pollution Attack Shield
 * 7. Cryptographic Audit Ledger Integrity Verification (Merkle Hash Chain)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';

async function runPhase2Tests() {
  console.log('\n======================================================');
  console.log('🛡️  TESTING SAHATN PHASE 2 ENTERPRISE SECURITY PACK');
  console.log(`🌐 Target: ${BASE_URL}`);
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

  // 1. Healthcheck security report
  await check('1. Security Engine Status (Phase 2 Pillars Active)', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.security.aes256Encryption, 'ACTIVE (Field-Level EHR at Rest)');
    assert.strictEqual(data.security.csrfProtection, 'ACTIVE (HMAC-SHA256 Cryptographic Tokens)');
    assert.strictEqual(data.security.auditMerkleChain, 'ACTIVE (SHA-256 Ledger Chaining)');
    assert.strictEqual(data.security.tokenBlacklist, 'ACTIVE (Immediate Revocation on Logout)');
    assert.strictEqual(data.security.accountLockout, 'ACTIVE (5-attempt lockout)');
  });

  // 2. AES-256-GCM Field-Level Encryption & Decryption
  await check('2. AES-256-GCM Field-Level Encryption on EHR at Rest', async () => {
    const testPatientId = `usr-test-${Date.now()}`;
    const testAllergies = ['Pénicilline G', 'Arachides'];
    const testDiseases = ['Asthme sévère', 'Diabète'];

    // Update health record
    const putRes = await fetch(`${BASE_URL}/api/patient/health-record`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        patientId: testPatientId,
        bloodType: 'AB+',
        allergies: testAllergies,
        chronicDiseases: testDiseases
      })
    });
    assert.strictEqual(putRes.status, 200, 'PUT /api/patient/health-record failed');
    const putData = await putRes.json();
    assert.strictEqual(putData.success, true);
    assert.deepStrictEqual(putData.data.allergies, testAllergies, 'Decrypted allergies should match in response');

    // Check raw database file on disk to prove it is encrypted at rest
    await new Promise(resolve => setTimeout(resolve, 200));
    const dbPath = path.join(__dirname, 'data', 'database.json');
    let rawDb = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rawDb = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
        break;
      } catch (e) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    const diskRecord = rawDb.patientHealthRecords.find(r => r.patientId === testPatientId);
    assert.ok(diskRecord, 'Record must exist on disk');
    assert.ok(typeof diskRecord.allergies === 'string', 'Allergies must be encrypted string on disk');
    assert.ok(diskRecord.allergies.startsWith('$AES256GCM$'), 'Must use $AES256GCM$ envelope format');
    assert.ok(diskRecord.chronicDiseases.startsWith('$AES256GCM$'), 'Chronic diseases must use $AES256GCM$ envelope format');

    // Query via GET /api/patient/profile to ensure transparent in-memory decryption
    const getRes = await fetch(`${BASE_URL}/api/patient/profile?patientId=${testPatientId}`);
    assert.strictEqual(getRes.status, 200);
    const getData = await getRes.json();
    assert.deepStrictEqual(getData.data.healthRecord.allergies, testAllergies, 'Transparent decryption failed');
    assert.deepStrictEqual(getData.data.healthRecord.chronicDiseases, testDiseases);
  });

  // 3. Password Complexity Enforcement
  await check('3. Strict Password Policy Enforcement', async () => {
    // Weak password: too short
    const resShort = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `test-${Date.now()}@sahatn.tn`, password: 'short', name: 'Short Test' })
    });
    assert.strictEqual(resShort.status, 400);
    const dataShort = await resShort.json();
    assert.strictEqual(dataShort.error, 'PASSWORD_TOO_WEAK');

    // Weak password: missing special char
    const resNoSpecial = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `test-${Date.now()}@sahatn.tn`, password: 'Password1234', name: 'NoSpecial Test' })
    });
    assert.strictEqual(resNoSpecial.status, 400);
    const dataNoSpecial = await resNoSpecial.json();
    assert.strictEqual(dataNoSpecial.error, 'PASSWORD_TOO_WEAK');

    // Strong password: passes
    const validEmail = `secure.user.${Date.now()}@sahatn.tn`;
    const resValid = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: validEmail, password: 'Saha!TN#2026Safe', name: 'Dr. Secure' })
    });
    assert.strictEqual(resValid.status, 201);
  });

  // 4. Anti-Bruteforce Account Lockout (5 failed attempts -> HTTP 423)
  await check('4. Anti-Bruteforce Account Lockout (HTTP 423 on 5th failure)', async () => {
    const targetEmail = `lockout.target.${Date.now()}@sahatn.tn`;

    // Create user first
    await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: targetEmail, password: 'Strong!Password123', name: 'Lock Target' })
    });

    // 4 failed attempts -> 401
    for (let i = 1; i <= 4; i++) {
      const res = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: targetEmail, password: 'WrongPassword' })
      });
      assert.strictEqual(res.status, 401, `Attempt ${i} should return 401`);
    }

    // 5th attempt -> 423 Locked!
    const res5 = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: targetEmail, password: 'WrongPassword' })
    });
    assert.strictEqual(res5.status, 423, '5th failed attempt must trigger HTTP 423 Locked');
    const data5 = await res5.json();
    assert.strictEqual(data5.error, 'ACCOUNT_LOCKED');

    // 6th attempt (even with correct password) -> Still 423 Locked!
    const res6 = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: targetEmail, password: 'Strong!Password123' })
    });
    assert.strictEqual(res6.status, 423, 'Locked account must reject even valid password during lockout window');
  });

  // 5. JWT Immediate Token Revocation on Logout
  await check('5. Immediate JWT Token Revocation on Logout', async () => {
    const logoutUser = `logout.user.${Date.now()}@sahatn.tn`;
    const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: logoutUser, password: 'Logout!Secret2026', name: 'Logout Patient' })
    });
    const regData = await regRes.json();
    const token = regData.token;
    assert.ok(token, 'Token must be issued');

    // Check token is valid
    const meRes1 = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.strictEqual(meRes1.status, 200, 'Token must be valid before logout');

    // Logout
    const logoutRes = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.strictEqual(logoutRes.status, 200, 'Logout endpoint must succeed');

    // Check token is immediately rejected with 401
    const meRes2 = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.strictEqual(meRes2.status, 401, 'Revoked token must be rejected with 401');
    const meData2 = await meRes2.json();
    assert.strictEqual(meData2.error, 'TOKEN_REVOKED');
  });

  // 6. Anti-CSRF Token Generation & Verification
  await check('6. Anti-CSRF Defense (Token Issuance & Mutation Validation)', async () => {
    // Obtain CSRF token from endpoint
    const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf-token`);
    assert.strictEqual(csrfRes.status, 200);
    const csrfData = await csrfRes.json();
    assert.ok(csrfData.csrfToken, 'CSRF token must be returned');

    // Browser-simulated mutation with forged token should fail 403
    const forgedRes = await fetch(`${BASE_URL}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://malicious-site.com',
        'X-CSRF-Token': 'forged.token.invalid'
      },
      body: JSON.stringify({ doctorId: 'doc-1', patientName: 'Attacker' })
    });
    assert.strictEqual(forgedRes.status, 403, 'Forged CSRF token must return 403 Forbidden');
    const forgedData = await forgedRes.json();
    assert.strictEqual(forgedData.error, 'CSRF_TOKEN_INVALID');

    // Browser-simulated mutation with valid CSRF token should succeed
    const validRes = await fetch(`${BASE_URL}/api/appointments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'http://localhost:4000',
        'X-CSRF-Token': csrfData.csrfToken
      },
      body: JSON.stringify({
        doctorId: 'doc-1',
        patientName: 'CSRF Verified Patient',
        patientPhone: '+216 98 000 111',
        slotTime: '17:30',
        motif: 'CSRF Test'
      })
    });
    assert.strictEqual(validRes.status, 201, 'Valid CSRF token request must succeed');
  });

  // 7. Prototype Pollution Guard
  await check('7. Prototype Pollution Injection Shield', async () => {
    const maliciousPayload = JSON.parse('{"__proto__": {"admin": true}, "name": "Hacker"}');
    const res = await fetch(`${BASE_URL}/api/patient/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(maliciousPayload)
    });
    assert.strictEqual(res.status, 400, 'Prototype pollution must return 400 Bad Request');
    const data = await res.json();
    assert.strictEqual(data.error, 'PROTOTYPE_POLLUTION_DETECTED');
  });

  // 8. Cryptographic Audit Ledger (Merkle Hash Chain)
  await check('8. Cryptographic Audit Ledger Integrity (SHA-256 Nonce Chain)', async () => {
    // Authenticate as Admin to access protected audit ledger
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@sahatn.tn', password: 'Saha2026!' })
    });
    const loginData = await loginRes.json();
    const adminToken = loginData.token;

    const res = await fetch(`${BASE_URL}/api/admin/audit-logs/verify-chain`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.verified, true, 'Audit chain integrity must be valid');
    assert.strictEqual(data.status, 'INTEGRITY_VERIFIED_100_PERCENT');
    assert.ok(data.totalEntries > 0, 'Audit ledger must have entries');
    assert.ok(data.headHash, 'Ledger head hash must exist');
    console.log(`     ↳ Ledger Entries: ${data.totalEntries}, Head Hash: ${data.headHash.slice(0, 16)}...`);
  });

  console.log('\n======================================================');
  console.log(`🛡️  Phase 2 Security Results: ${passed} passed, ${failed} failed`);
  console.log('======================================================\n');

  if (failed > 0) process.exit(1);
}

runPhase2Tests().catch(err => {
  console.error('Fatal error running Phase 2 security tests:', err);
  process.exit(1);
});
