/**
 * Automated Verification Script for Doctor Email Notification & Map Finalization Flow
 */
const http = require('http');

function request(options, data) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (data) {
      req.write(typeof data === 'string' ? data : JSON.stringify(data));
    }
    req.end();
  });
}

async function run() {
  console.log('====================================================');
  console.log('🚀 Testing Doctor Email Decision & Map Finalization Flow');
  console.log('====================================================\n');

  // Step 1: Login as Admin to get Admin JWT
  console.log('1️⃣ Logging in as Super Admin...');
  const loginRes = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    email: 'admin@sahatn.tn',
    password: 'Saha2026!'
  });

  if (!loginRes.data.success) {
    throw new Error('Admin login failed: ' + JSON.stringify(loginRes.data));
  }

  let adminToken = loginRes.data.token;
  if (loginRes.data.requires2FA) {
    const vRes = await request({
      hostname: 'localhost',
      port: 4000,
      path: '/api/auth/verify-2fa',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, {
      tempToken: loginRes.data.tempToken,
      code: loginRes.data.codePreview || '123456'
    });
    adminToken = vRes.data.token;
  }

  if (!adminToken) {
    throw new Error('Failed to obtain adminToken: ' + JSON.stringify(loginRes.data));
  }
  console.log('   ✅ Super Admin authenticated. Token received.\n');

  // Step 2: Inject a pending practitioner test request
  console.log('2️⃣ Injecting a fresh practitioner request...');
  const testPratEmail = `dr.walid.maptest.${Date.now()}@sahatn.tn`;
  const reqRes = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/praticiens/request',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    name: 'Dr. Walid Ben Salem',
    firstname: 'Walid',
    lastname: 'Ben Salem',
    email: testPratEmail,
    phone: '+216 71 999 888',
    postal: '2037',
    spec: 'Cardiologie & Maladies Vasculaires',
    city: 'Ariana',
    address: 'Avenue Hédi Nouira, Ennasr 2',
    ordre: 'N° 22910',
    fee: 80
  });

  if (!reqRes.data.success || !reqRes.data.request) {
    throw new Error('Praticien request failed: ' + JSON.stringify(reqRes.data));
  }
  const pratReqId = reqRes.data.request.id;
  console.log(`   ✅ Request created for Dr. Walid Ben Salem (ID: ${pratReqId}, Email: ${testPratEmail})\n`);

  // Step 3: Admin Approves the request -> triggers Approval & Map Onboarding Email
  console.log('3️⃣ Admin approving request & generating validation email...');
  const approveRes = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/admin/praticiens/approve',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    }
  }, { id: pratReqId });

  if (!approveRes.data.success || !approveRes.data.emailSent) {
    throw new Error('Approve failed: ' + JSON.stringify(approveRes.data));
  }

  console.log('   ✅ Request approved!');
  console.log(`   📧 Email Sent: ${approveRes.data.emailSent}`);
  console.log(`   🔗 Activation & Map URL: ${approveRes.data.activationUrl}`);
  console.log(`   📋 Subject: ${approveRes.data.emailRecord?.subject}\n`);

  const activationUrl = approveRes.data.activationUrl;
  if (!activationUrl || !activationUrl.includes('/pages/Doctors_pages/onboarding.html')) {
    throw new Error('Activation URL is missing or invalid: ' + activationUrl);
  }

  // Step 4: Verify Email Logs in Database
  console.log('4️⃣ Verifying emailLogs via /api/admin/emails/logs...');
  const emailLogsRes = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/admin/emails/logs',
    method: 'GET',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });

  const matchingApprovalEmail = (emailLogsRes.data.data || []).find(e => e.recipientEmail === testPratEmail && e.type === 'APPROVAL_VALIDATION');
  if (!matchingApprovalEmail) {
    throw new Error('Approval email not found in emailLogs!');
  }
  console.log(`   ✅ Found approval email record: ${matchingApprovalEmail.id} (Status: ${matchingApprovalEmail.status})`);

  // Step 5: Doctor follows link in email and finalizes account (password + map coordinates)
  console.log('5️⃣ Doctor finalizes account via POST /api/doctors/finalize-account...');
  const testLat = 36.8582;
  const testLng = 10.1594;
  const doctorPassword = 'DoctorPass2026!';

  const finalizeRes = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/doctors/finalize-account',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    id: approveRes.data.doctor.id,
    email: testPratEmail,
    name: 'Dr. Walid Ben Salem',
    password: doctorPassword,
    cabName: 'Cabinet de Cardiologie Dr. Walid Ben Salem',
    city: 'Ariana',
    address: 'Résidence Ennasr Médical, Avenue Hédi Nouira, Ariana',
    lat: testLat,
    lng: testLng,
    fee: 80,
    cnam: 'C1',
    phone: '+216 71 999 888',
    taxId: '1984210/A/M/000'
  });

  if (!finalizeRes.data.success || !finalizeRes.data.doctor) {
    throw new Error('Doctor finalization failed: ' + JSON.stringify(finalizeRes.data));
  }

  console.log('   ✅ Doctor account successfully finalized!');
  console.log(`   📍 Coords saved in DB: [${finalizeRes.data.doctor.lat}, ${finalizeRes.data.doctor.lng}]`);
  console.log(`   🏥 Address: ${finalizeRes.data.doctor.address}\n`);

  if (finalizeRes.data.doctor.lat !== testLat || finalizeRes.data.doctor.lng !== testLng) {
    throw new Error(`Coordinates mismatch! Expected [${testLat}, ${testLng}], got [${finalizeRes.data.doctor.lat}, ${finalizeRes.data.doctor.lng}]`);
  }

  // Step 6: Verify doctor can log in with new password
  console.log('6️⃣ Testing doctor login with newly created password...');
  const docLoginRes = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    email: testPratEmail,
    password: doctorPassword
  });

  if (!docLoginRes.data.success || docLoginRes.data.user.role !== 'DOCTOR') {
    throw new Error('Doctor login with new password failed: ' + JSON.stringify(docLoginRes.data));
  }
  console.log(`   ✅ Doctor authenticated successfully! Role: ${docLoginRes.data.user.role}\n`);

  // Step 7: Verify doctor appears on public /api/doctors endpoint with coordinates
  console.log('7️⃣ Verifying doctor on public /api/doctors list for map plotting...');
  const publicDocsRes = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/doctors',
    method: 'GET'
  });

  const plottedDoc = (publicDocsRes.data.data || []).find(d => d.email === testPratEmail);
  if (!plottedDoc) {
    throw new Error('Doctor not found on public /api/doctors list!');
  }
  console.log(`   ✅ Doctor visible on public directory with GPS [${plottedDoc.lat}, ${plottedDoc.lng}]\n`);

  // Step 8: Test Rejection / Denied Email Flow
  console.log('8️⃣ Testing Rejection Flow with Refusal Reason & Denied Email...');
  const rejectTestEmail = `dr.refused.test.${Date.now()}@sahatn.tn`;
  const req2Res = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/praticiens/request',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    name: 'Dr. Test Refusal',
    email: rejectTestEmail,
    phone: '+216 71 111 222',
    spec: 'Pédiatrie'
  });

  const rejectReqId = req2Res.data.request.id;
  const refusalReason = 'Absence de copie certifiée conforme du diplôme de spécialité pédiatrique.';

  const rejectRes = await request({
    hostname: 'localhost',
    port: 4000,
    path: '/api/admin/praticiens/reject',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    }
  }, {
    id: rejectReqId,
    reason: refusalReason
  });

  if (!rejectRes.data.success || !rejectRes.data.emailSent) {
    throw new Error('Rejection failed: ' + JSON.stringify(rejectRes.data));
  }

  console.log('   ✅ Request rejected!');
  console.log(`   📧 Denied Email Sent: ${rejectRes.data.emailSent}`);
  console.log(`   📋 Reason: "${rejectRes.data.reason}"`);
  console.log(`   ✉️ Subject: ${rejectRes.data.emailRecord?.subject}\n`);

  // Step 9: Verify Email Preview HTML endpoint
  console.log('9️⃣ Testing Email Preview Endpoint /api/admin/emails/preview/:id...');
  const previewRes = await request({
    hostname: 'localhost',
    port: 4000,
    path: `/api/admin/emails/preview/${rejectRes.data.emailRecord.id}`,
    method: 'GET',
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });

  if (!previewRes.data.success || !previewRes.data.data.htmlBody.includes(refusalReason)) {
    throw new Error('Email preview does not contain refusal reason: ' + JSON.stringify(previewRes.data));
  }
  console.log('   ✅ Email preview verified! HTML body contains exact refusal reason.\n');

  console.log('====================================================');
  console.log('🎉 ALL 9 TEST STEPS PASSED SUCCESSFULLY!');
  console.log('====================================================');
}

run().catch(err => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
