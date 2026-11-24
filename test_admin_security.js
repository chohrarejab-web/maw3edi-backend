/**
 * SahaTN / Maw2idi — Admin Console Route & Zero-Vulnerability Security Test Suite
 * 
 * Verifies:
 * 1. Typing /pages/Admin_pages/admin-db.html without admin cookie is BLOCKED (Redirects to landing.html, 302)
 * 2. Typing /admin without admin cookie is BLOCKED (Redirects to landing.html, 302)
 * 3. Second login page (admin-login.html) is blocked & removed (302 unauth / 404 auth)
 * 4. Unauthenticated access to /api/admin/* returns 401
 * 5. Patient role token returns 403 Forbidden on /api/admin/*
 * 6. Patient role cookie trying to access /pages/Admin_pages/admin-db.html is BLOCKED (Redirects to landing.html)
 * 7. Super Admin credentials issue valid JWT token & cookie via /api/auth/login
 * 8. Authenticated Super Admin WITH cookie can access /pages/Admin_pages/admin-db.html (HTTP 200)
 * 9. Authenticated Super Admin WITH cookie can access /admin (redirects to admin-db.html)
 * 10. Authenticated Super Admin can verify session via /api/admin/verify-session
 * 11. Authenticated Super Admin can query /api/admin/stats (HTTP 200)
 * 12. Admin Logout immediately revokes token, blocking further access to both API and admin-db.html
 */

const assert = require('assert');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';

async function runAdminSecurityTests() {
  console.log('\n======================================================');
  console.log('🔒 TESTING ZERO-VULNERABILITY ADMIN ROUTE PROTECTION');
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

  // 1. Direct URL typing to admin-db.html without cookie is BLOCKED
  await check('1. Direct typing to admin-db.html is BLOCKED without cookie (HTTP 302 -> landing.html)', async () => {
    const res = await fetch(`${BASE_URL}/pages/Admin_pages/admin-db.html`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302, `Expected 302 redirect, got ${res.status}`);
    const location = res.headers.get('location') || '';
    assert.ok(location.includes('landing.html'), `Expected redirect to landing.html, got: ${location}`);
    assert.ok(location.includes('login=admin'), `Expected redirect query param login=admin, got: ${location}`);
  });

  // 2. Direct URL typing to /admin without cookie is BLOCKED
  await check('2. Direct typing to /admin is BLOCKED without cookie (HTTP 302 -> landing.html)', async () => {
    const res = await fetch(`${BASE_URL}/admin`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302, `Expected 302 redirect, got ${res.status}`);
    const location = res.headers.get('location') || '';
    assert.ok(location.includes('landing.html'), `Expected redirect to landing.html, got: ${location}`);
  });

  // 3. Second login page (admin-login.html) is completely removed and blocked
  await check('3. Second Login Page (admin-login.html) is Blocked (HTTP 302 -> landing.html)', async () => {
    const res = await fetch(`${BASE_URL}/pages/Admin_pages/admin-login.html`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302, 'admin-login.html route must be intercepted and redirected');
    const location = res.headers.get('location') || '';
    assert.ok(location.includes('landing.html'));
  });

  // 4. Admin API endpoints reject unauthenticated access (HTTP 401)
  await check('4. Unauthenticated Access to /api/admin/* is Blocked (HTTP 401)', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/stats`);
    assert.strictEqual(res.status, 401, `Expected 401, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.success, false);
  });

  // 5. Patient role receives HTTP 403 Forbidden on Admin API
  let patientToken = null;
  await check('5. Patient Role is Forbidden from Admin API (HTTP 403)', async () => {
    const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `patient.test.${Date.now()}@sahatn.tn`,
        password: 'Patient!Secure2026',
        name: 'Patient Tester'
      })
    });
    const regData = await regRes.json();
    patientToken = regData.token;
    assert.ok(patientToken, 'Patient token required');

    const res = await fetch(`${BASE_URL}/api/admin/stats`, {
      headers: { 'Authorization': `Bearer ${patientToken}` }
    });
    assert.strictEqual(res.status, 403, `Expected 403 Forbidden, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.success, false);
  });

  // 6. Patient role cookie cannot access admin-db.html (BLOCKED)
  await check('6. Patient Cookie cannot access admin-db.html (HTTP 302 -> landing.html)', async () => {
    const res = await fetch(`${BASE_URL}/pages/Admin_pages/admin-db.html`, {
      headers: { 'Cookie': `sahatn_admin_token=${patientToken}` },
      redirect: 'manual'
    });
    assert.strictEqual(res.status, 302, 'Patient role must not access admin page');
    const location = res.headers.get('location') || '';
    assert.ok(location.includes('landing.html'));
  });

  // 7. Super Admin Login Issues Valid Token & Cookie
  let adminToken = null;
  await check('7. Super Admin Login Issues Valid Token & Cookie', async () => {
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@sahatn.tn',
        password: 'Saha2026!'
      })
    });
    assert.strictEqual(loginRes.status, 200);
    const loginData = await loginRes.json();
    assert.strictEqual(loginData.success, true);
    assert.strictEqual(loginData.user.role, 'SUPER_ADMIN');
    assert.ok(loginData.token, 'Token must be returned');
    adminToken = loginData.token;
  });

  // 8. Authenticated Super Admin WITH Cookie can access admin-db.html (HTTP 200)
  await check('8. Authenticated Super Admin with Cookie Accesses admin-db.html (HTTP 200)', async () => {
    assert.ok(adminToken, 'Admin token required');
    const res = await fetch(`${BASE_URL}/pages/Admin_pages/admin-db.html`, {
      headers: { 'Cookie': `sahatn_admin_token=${adminToken}` }
    });
    assert.strictEqual(res.status, 200, `Expected 200 with valid cookie, got ${res.status}`);
    const html = await res.text();
    assert.ok(html.includes('<!DOCTYPE html>') || html.includes('<!doctype html>'), 'Should serve valid HTML document');
  });

  // 8a. Backdoor routes /admin/demo and /admin?demo=1 MUST BE BLOCKED (HTTP 302)
  await check('8a. Legacy demo backdoors (/admin/demo, /admin?demo=1) are BLOCKED', async () => {
    const r1 = await fetch(`${BASE_URL}/admin/demo`, { redirect: 'manual' });
    assert.strictEqual(r1.status, 302, 'Expected 302 redirect for /admin/demo');
    assert.ok(!(r1.headers.get('set-cookie') || '').includes('sahatn_admin_token'), 'Must NOT issue admin cookie');

    const r2 = await fetch(`${BASE_URL}/admin?demo=1`, { redirect: 'manual' });
    assert.strictEqual(r2.status, 302, 'Expected 302 redirect for /admin?demo=1');
    assert.ok(!(r2.headers.get('set-cookie') || '').includes('sahatn_admin_token'), 'Must NOT issue admin cookie');
  });

  // 8b. Authenticated Super Admin verifies deleted admin-login.html is 404 (file gone)
  await check('8b. Deleted admin-login.html returns HTTP 404 for Authenticated Admin', async () => {
    assert.ok(adminToken, 'Admin token required');
    const res = await fetch(`${BASE_URL}/pages/Admin_pages/admin-login.html`, {
      headers: { 'Cookie': `sahatn_admin_token=${adminToken}` }
    });
    assert.strictEqual(res.status, 404, 'admin-login.html must not exist');
  });

  // 9. Authenticated Super Admin WITH Cookie can access clean alias /admin
  await check('9. Authenticated Super Admin with Cookie Accesses /admin (Redirects to admin-db.html)', async () => {
    assert.ok(adminToken, 'Admin token required');
    const res = await fetch(`${BASE_URL}/admin`, {
      headers: { 'Cookie': `sahatn_admin_token=${adminToken}` },
      redirect: 'manual'
    });
    assert.strictEqual(res.status, 302);
    const location = res.headers.get('location') || '';
    assert.ok(location.includes('admin-db.html'), `Expected redirect to admin-db.html, got ${location}`);
  });

  // 10. Verify Admin Session Endpoint
  await check('10. GET /api/admin/verify-session Validates Super Admin', async () => {
    assert.ok(adminToken, 'Admin token required');
    const res = await fetch(`${BASE_URL}/api/admin/verify-session`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.user.role, 'SUPER_ADMIN');
  });

  // 11. Authenticated Admin can fetch admin stats
  await check('11. Authenticated Super Admin Fetches Stats (HTTP 200)', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/stats`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.stats.totalUsers > 0);
  });

  // 12. Admin Logout Revokes Token and Immediately Blocks Access
  await check('12. Admin Logout Immediately Revokes Token & Blocks Access (HTTP 401 & 302)', async () => {
    const logoutRes = await fetch(`${BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.strictEqual(logoutRes.status, 200);

    // API blocked with 401
    const apiRes = await fetch(`${BASE_URL}/api/admin/stats`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.strictEqual(apiRes.status, 401);
    const apiData = await apiRes.json();
    assert.strictEqual(apiData.error, 'TOKEN_REVOKED');

    // Page access blocked with 302 redirect
    const pageRes = await fetch(`${BASE_URL}/pages/Admin_pages/admin-db.html`, {
      headers: { 'Cookie': `sahatn_admin_token=${adminToken}` },
      redirect: 'manual'
    });
    assert.strictEqual(pageRes.status, 302, 'Revoked token cookie must be blocked from accessing admin-db.html');
  });

  console.log('\n======================================================');
  console.log(`🔒 Zero-Vulnerability Admin Security Results: ${passed} passed, ${failed} failed`);
  console.log('======================================================\n');

  if (failed > 0) process.exit(1);
}

runAdminSecurityTests().catch(err => {
  console.error('Fatal error running admin security tests:', err);
  process.exit(1);
});
