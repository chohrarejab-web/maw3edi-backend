/**
 * Automated Backend API Test Suite for SahaTN / Maw2idi (Node.js)
 * Run with: npm test  or  node test_api.js
 */

const assert = require('assert');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';

async function runTests() {
  console.log('\n======================================================');
  console.log('🧪 RUNNING SAHATN / MAW2IDI BACKEND API TEST SUITE');
  console.log(`🌐 Base URL: ${BASE_URL}`);
  console.log('======================================================\n');

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name}: ${err.message}`);
      failed++;
    }
  }

  // 1. Healthcheck
  await test('GET /api/health (Server health & status)', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    assert.strictEqual(res.status, 200, `Expected status 200, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.status, 'HEALTHY');
  });

  // 2. Authentication Login
  let authToken = null;
  await test('POST /api/auth/login (Doctor demo login)', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'dr.selim@sahatn.tn',
        password: 'Saha2026!'
      })
    });
    assert.strictEqual(res.status, 200, `Expected status 200, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.token, 'Token should be returned');
    authToken = data.token;
  });

  // 3. Authenticated profile endpoint
  await test('GET /api/auth/me (Verify JWT Token)', async () => {
    assert.ok(authToken, 'Auth token is required');
    const res = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    assert.strictEqual(res.status, 200, `Expected status 200, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.user.email, 'dr.selim@sahatn.tn');
  });

  // 4. Doctors list
  await test('GET /api/doctors (List all practitioners)', async () => {
    const res = await fetch(`${BASE_URL}/api/doctors`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(Array.isArray(data.data) && data.data.length > 0, 'Should return doctors array');
  });

  // 5. Doctors filtered
  await test('GET /api/doctors?specialty=cardio&city=Tunis (Filter search)', async () => {
    const res = await fetch(`${BASE_URL}/api/doctors?specialty=cardio&city=Tunis`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.data.length >= 1, 'Should find at least 1 cardiologist in Tunis');
  });

  // 6. Patient Profile & Digital Health Record (EHR) — must require auth
  await test('GET /api/patient/profile (Unauthenticated blocked with 401)', async () => {
    const res = await fetch(`${BASE_URL}/api/patient/profile?patientId=usr-4410`);
    assert.strictEqual(res.status, 401);
  });

  await test('GET /api/patient/profile (Authenticated access to EHR)', async () => {
    const res = await fetch(`${BASE_URL}/api/patient/profile?patientId=usr-4410`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.data.healthRecord, 'Should return health record');
  });

  await test('POST /api/patient/payment (Unauthenticated blocked with 401)', async () => {
    const res = await fetch(`${BASE_URL}/api/patient/payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'FLOUCI', amount: '1 TND' })
    });
    assert.strictEqual(res.status, 401);
  });

  await test('POST /api/patient/payment (Authenticated server-verified fee)', async () => {
    const res = await fetch(`${BASE_URL}/api/patient/payment`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        method: 'FLOUCI',
        amount: '1 TND'
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.data.transactionId.startsWith('FLOUCI-TN-'));
    assert.strictEqual(data.data.amount, '70 TND', 'Server must ignore client-supplied tampered amount');
  });

  // 7. Virtual Queue
  await test('GET /api/queue (Real-time virtual waiting room queue)', async () => {
    const res = await fetch(`${BASE_URL}/api/queue`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
  });

  // 8. Book Appointment (dynamic future date to avoid collisions across runs)
  let createdAptId = null;
  await test('POST /api/appointments (Book consultation)', async () => {
    const futureYear = 2028 + Math.floor(Math.random() * 5);
    const futureMonth = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
    const futureDay = String(1 + Math.floor(Math.random() * 27)).padStart(2, '0');
    const randMin = String(Math.floor(Math.random() * 59)).padStart(2, '0');
    const res = await fetch(`${BASE_URL}/api/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        doctorId: 'doc-1',
        patientName: 'Test Patient Node',
        patientPhone: '+216 98 111 222',
        date: `${futureYear}-${futureMonth}-${futureDay}`,
        dateIso: `${futureYear}-${futureMonth}-${futureDay}`,
        slotTime: `15:${randMin}`,
        motif: 'Checkup test'
      })
    });
    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    createdAptId = data.data.id;
    // Cleanup test booking (authenticated doctor token)
    await fetch(`${BASE_URL}/api/appointments/${createdAptId}/cancel`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${authToken}` }
    }).catch(() => {});
  });

  // 9. Queue delay announcement (Requires doctor/staff auth)
  await test('POST /api/queue/delay (Broadcast waiting delay)', async () => {
    const unauth = await fetch(`${BASE_URL}/api/queue/delay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minutes: 15 })
    });
    assert.strictEqual(unauth.status, 401);

    const res = await fetch(`${BASE_URL}/api/queue/delay`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ minutes: 15 })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
  });

  // 10. Reviews GET & POST (Requires auth)
  let createdRevId = null;
  await test('POST /api/reviews (Create patient review)', async () => {
    const res = await fetch(`${BASE_URL}/api/reviews`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        doctorId: 'doc-1',
        patientName: 'Yassine M.',
        rating: 5,
        criteria: { punctuality: 5, bedsideManner: 5, hygiene: 5, careQuality: 5 },
        tags: ['Ponctuel', 'À l\'écoute'],
        comment: 'Très bon service et prise en charge rapide.'
      })
    });
    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    createdRevId = data.data.id;
  });

  await test('POST /api/reviews/reply (Doctor replies to review)', async () => {
    assert.ok(createdRevId, 'Review ID required');
    const res = await fetch(`${BASE_URL}/api/reviews/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        reviewId: createdRevId,
        doctorName: 'Dr. Selim Ben Ali',
        text: 'Merci pour votre confiance.'
      })
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
  });

  // 11. Verify sensitive server files & dotfiles are blocked (HTTP 404)
  await test('Blocked exposed files (/server.js, /.env, /uploads/test.pdf -> HTTP 404)', async () => {
    for (const p of ['/server.js', '/.env', '/.git/config', '/src/config/database.js', '/uploads/cv/secret.pdf']) {
      const r = await fetch(`${BASE_URL}${p}`);
      assert.strictEqual(r.status, 404, `Expected 404 for ${p}, got ${r.status}`);
    }
  });

  // 11. Revenue calculation
  await test('GET /api/revenue (Platform SaaS & teleconsultation stats)', async () => {
    const res = await fetch(`${BASE_URL}/api/revenue`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.data.totalGrossRevenue > 0);
  });

  console.log('\n======================================================');
  console.log(`📊 Summary: ${passed} passed, ${failed} failed`);
  console.log('======================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

// Auto-detect or run
runTests().catch(err => {
  console.error('\n❌ Error connecting to server. Is the backend running?');
  console.error('👉 Start backend with: node server.js');
  console.error(`Details: ${err.message}\n`);
  process.exit(1);
});
