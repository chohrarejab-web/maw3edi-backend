/**
 * Automated Verification Test Suite for Practitioner Onboarding & Admin Approval Flow
 * SahaTN / Maw2idi
 */

const assert = require('assert');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';

async function runPraticienFlowTests() {
  console.log('\n======================================================');
  console.log('👨‍⚕️ TESTING PRACTITIONER ONBOARDING & ADMIN APPROVAL');
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

  // Obtain Super Admin token
  let adminToken = null;
  await check('1. Authenticate as Super Admin', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@sahatn.tn',
        password: 'Saha2026!'
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    
    // If 2FA challenge is returned, verify it
    if (data.requires2FA) {
      const vRes = await fetch(`${BASE_URL}/api/auth/verify-2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tempToken: data.tempToken,
          code: data.codePreview || '123456'
        })
      });
      const vData = await vRes.json();
      assert.strictEqual(vData.success, true);
      adminToken = vData.token;
    } else {
      adminToken = data.token;
    }
    assert.ok(adminToken, 'Admin token required');
  });

  // Check initial doctor count
  let initialDoctorCount = 0;
  await check('2. Check initial doctors count in database', async () => {
    const res = await fetch(`${BASE_URL}/api/doctors`);
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    initialDoctorCount = data.count || data.data.length;
    console.log(`     ℹ️  Initial doctors count: ${initialDoctorCount}`);
  });

  // 3. Practitioner submits onboarding request via public API
  const testDoctorEmail = `dr.test.${Date.now()}@sahatn.tn`;
  let createdRequestId = null;

  await check('3. Submit practitioner onboarding request (POST /api/praticiens/request)', async () => {
    const payload = {
      firstname: 'Tarak',
      lastname: 'Ben Mahmoud',
      name: 'Dr. Tarak Ben Mahmoud',
      email: testDoctorEmail,
      phone: '+216 98 776 543',
      postal: '2000',
      objet: 'Digitalisation d\'un cabinet de cardiologie',
      spec: 'Cardiologie & Maladies Vasculaires',
      specialtyId: 'cardio',
      city: 'Le Bardo',
      delegation: 'Bardo Centre',
      address: 'Avenue Habib Bourguiba, Le Bardo',
      ordre: 'N° 25890',
      cnam: 'Filière Privée (CNAM C1)',
      fee: 75,
      cvFileName: 'cv_dr_tarak.pdf'
    };

    const res = await fetch(`${BASE_URL}/api/praticiens/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    assert.strictEqual(res.status, 201, `Expected status 201, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.request, 'Request object should be returned');
    assert.strictEqual(data.request.status, 'PENDING');
    createdRequestId = data.request.id;
    console.log(`     ℹ️  Created practitioner request ID: ${createdRequestId}`);
  });

  // 4. Admin inspects pending requests
  await check('4. Admin queries pending practitioner requests (GET /api/admin/praticiens/requests)', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/praticiens/requests`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    const target = data.data.find(r => r.id === createdRequestId || r.email === testDoctorEmail);
    assert.ok(target, 'Submitted request must be present in admin requests list');
    assert.strictEqual(target.status, 'PENDING');
  });

  // 5. Admin approves practitioner request
  let approvedDoctorId = null;
  await check('5. Admin approves practitioner (POST /api/admin/praticiens/approve)', async () => {
    const res = await fetch(`${BASE_URL}/api/admin/praticiens/approve`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ id: createdRequestId })
    });
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.doctor, 'Doctor object should be returned');
    assert.ok(data.user, 'User credentials should be returned');
    assert.strictEqual(data.user.role, 'DOCTOR');
    approvedDoctorId = data.doctor.id;
    console.log(`     ℹ️  Approved doctor ID: ${approvedDoctorId}`);
  });

  // 6. Verify doctors table in database has been incremented
  await check('6. Verify doctor count incremented in data/database.json', async () => {
    const res = await fetch(`${BASE_URL}/api/doctors`);
    const data = await res.json();
    assert.strictEqual(res.status, 200);
    const newCount = data.count || data.data.length;
    assert.strictEqual(newCount, initialDoctorCount + 1, `Expected ${initialDoctorCount + 1} doctors, got ${newCount}`);
    
    const found = data.data.find(d => d.email === testDoctorEmail || d.id === approvedDoctorId);
    assert.ok(found, 'Newly approved doctor must be returned by /api/doctors');
    assert.strictEqual(found.city, 'Le Bardo');
    assert.ok(found.specialtyFr.includes('Cardiologie'));
    console.log(`     ℹ️  Verified: Doctors count increased to ${newCount}`);
  });

  // 7. Verify newly approved doctor can log in
  await check('7. Verify approved doctor can authenticate via /api/auth/login', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: testDoctorEmail,
        password: 'Doctor2026!'
      })
    });
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    if (data.requires2FA) {
      assert.strictEqual(data.user.role, 'DOCTOR');
    } else {
      assert.strictEqual(data.user.role, 'DOCTOR');
      assert.ok(data.token, 'Doctor token returned');
    }
  });

  // 8. Admin rejects a practitioner request
  await check('8. Practitioner request rejection flow (POST /api/admin/praticiens/reject)', async () => {
    // Submit a dummy request to reject
    const rejectEmail = `dr.reject.${Date.now()}@sahatn.tn`;
    const subRes = await fetch(`${BASE_URL}/api/praticiens/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Dr. Reject Tester',
        email: rejectEmail,
        phone: '+216 55 999 888',
        spec: 'Médecine Générale',
        city: 'Sousse'
      })
    });
    const subData = await subRes.json();
    const rejReqId = subData.request.id;

    // Reject it
    const rejRes = await fetch(`${BASE_URL}/api/admin/praticiens/reject`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ id: rejReqId })
    });
    assert.strictEqual(rejRes.status, 200);
    const rejData = await rejRes.json();
    assert.strictEqual(rejData.success, true);

    // Verify request status is REJECTED
    const listRes = await fetch(`${BASE_URL}/api/admin/praticiens/requests`, {
      headers: { 'Authorization': `Bearer ${adminToken}` }
    });
    const listData = await listRes.json();
    const item = listData.data.find(r => r.id === rejReqId);
    assert.ok(item);
    assert.strictEqual(item.status, 'REJECTED');
  });

  console.log('\n======================================================');
  console.log(`📊 PRACTITIONER FLOW RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runPraticienFlowTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
