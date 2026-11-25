/**
 * SahaTN / Maw2idi — Full Migration Script from JSON to PostgreSQL
 * Migrates all 18 relational tables cleanly using concurrent batches.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const postgres = require('../src/config/postgres');

function safeTimestamp(val, fallback) {
  if (!val) return fallback;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? fallback : d.toISOString();
}

async function runBatched(items, batchSize, handler) {
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    await Promise.all(chunk.map(handler));
  }
}

async function migrate() {
  const jsonPath = path.join(__dirname, '..', 'data', 'database.json');
  if (!fs.existsSync(jsonPath)) {
    console.warn('[Migration] database.json not found at:', jsonPath);
    return false;
  }

  const raw = fs.readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(raw);
  const nowIso = new Date().toISOString();

  console.log('🚀 [Migration] Starting full migration to PostgreSQL...');
  await postgres.initSchema();

  // 1. Users
  if (Array.isArray(data.users) && data.users.length) {
    console.log(`👤 Migrating ${data.users.length} users...`);
    await runBatched(data.users, 25, (u) => postgres.query(
      `INSERT INTO users (uuid, email, password_hash, name, role, doctor_id, phone, avatar, cv_file_name, cv_file_data, signature, signature_data, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (uuid) DO UPDATE SET
         email = EXCLUDED.email,
         password_hash = EXCLUDED.password_hash,
         name = EXCLUDED.name,
         role = EXCLUDED.role,
         doctor_id = EXCLUDED.doctor_id,
         phone = EXCLUDED.phone,
         avatar = EXCLUDED.avatar;`,
      [u.uuid, u.email, u.passwordHash || '', u.name || '', u.role || 'PATIENT', u.doctorId || null, u.phone || null, u.avatar || null, u.cvFileName || null, u.cvFileData || null, u.signature || null, u.signatureData || null, u.createdAt || nowIso]
    ));
  }

  // 2. Doctors
  if (Array.isArray(data.doctors) && data.doctors.length) {
    console.log(`🩺 Migrating ${data.doctors.length} doctors...`);
    await runBatched(data.doctors, 25, (d) => postgres.query(
      `INSERT INTO doctors (id, uuid, name, title, specialty, specialty_fr, specialty_ar, specialty_id, city, delegation, address, phone, email, fee, cnam, reviews_count, rating, avatar, active, account_finalized, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         specialty = EXCLUDED.specialty,
         city = EXCLUDED.city,
         fee = EXCLUDED.fee,
         avatar = EXCLUDED.avatar,
         active = EXCLUDED.active;`,
      [
        d.id, d.uuid || d.id, d.name || '', d.title || 'Dr.',
        d.specialty || d.spec || null, d.specialtyFr || d.specialty || null, d.specialtyAr || null, d.specialtyId || null,
        d.city || null, d.delegation || null, d.address || null, d.phone || null, d.email || null,
        d.fee || '70 TND', d.cnam !== false, d.reviewsCount || d.reviewCount || 0, d.rating || 5.0,
        d.avatar || null, d.active !== false, d.accountFinalized !== false, d.createdAt || nowIso
      ]
    ));
  }

  // 3. Appointments
  if (Array.isArray(data.appointments) && data.appointments.length) {
    console.log(`📅 Migrating ${data.appointments.length} appointments...`);
    await runBatched(data.appointments, 25, (a) => postgres.query(
      `INSERT INTO appointments (id, patient_id, patient_name, patient_phone, doctor_id, doctor_name, specialty, date, time, type, fee, ticket_number, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, time = EXCLUDED.time;`,
      [a.id, a.patientId || null, a.patientName || null, a.patientPhone || null, a.doctorId || null, a.doctorName || null, a.specialty || null, a.date || null, a.time || null, a.type || 'PRESENTIEL', a.fee || '70 TND', a.ticketNumber || null, a.status || 'CONFIRMED', a.createdAt || nowIso]
    ));
  }

  // 4. Praticien Requests
  if (Array.isArray(data.praticienRequests) && data.praticienRequests.length) {
    console.log(`📋 Migrating ${data.praticienRequests.length} praticien requests...`);
    await runBatched(data.praticienRequests, 25, (p) => postgres.query(
      `INSERT INTO praticien_requests (id, uuid, name, firstname, lastname, email, phone, postal, objet, spec, specialty_id, city, delegation, address, ordre, cnam, cv_file_name, fee, date, status, doctor_id, account_finalized, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;`,
      [p.id, p.uuid || p.id, p.name || null, p.firstname || null, p.lastname || null, p.email || null, p.phone || null, p.postal || null, p.objet || null, p.spec || null, p.specialtyId || null, p.city || null, p.delegation || null, p.address || null, p.ordre || null, p.cnam === true, p.cvFileName || null, p.fee || '70 TND', p.date || null, p.status || 'PENDING', p.doctorId || null, Boolean(p.accountFinalized), p.createdAt || nowIso]
    ));
  }

  // 5. Queue
  if (Array.isArray(data.queue) && data.queue.length) {
    console.log(`⏳ Migrating ${data.queue.length} queue items...`);
    await runBatched(data.queue, 30, (q, idx) => postgres.query(
      `INSERT INTO queue (id, doctor_id, ticket_number, patient_name, status, position, estimated_wait_minutes, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, position = EXCLUDED.position, payload = EXCLUDED.payload;`,
      [String(q.id || `q-${idx}`), q.doctorId || null, q.ticketNumber || q.ticket || null, q.patientName || q.patient || null, q.status || 'WAITING', Number(q.position) || 1, Number(q.estimatedWaitMinutes || q.estimatedWait) || 15, JSON.stringify(q), q.createdAt || nowIso]
    ));
  }

  // 6. Patient Health Records
  if (Array.isArray(data.patientHealthRecords) && data.patientHealthRecords.length) {
    console.log(`🩺 Migrating ${data.patientHealthRecords.length} patient health records...`);
    await runBatched(data.patientHealthRecords, 25, (r, idx) => postgres.query(
      `INSERT INTO patient_health_records (id, patient_id, blood_type, allergies, chronic_conditions, emergency_contact, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (patient_id) DO UPDATE SET
         blood_type = EXCLUDED.blood_type,
         allergies = EXCLUDED.allergies,
         chronic_conditions = EXCLUDED.chronic_conditions,
         emergency_contact = EXCLUDED.emergency_contact,
         payload = EXCLUDED.payload;`,
      [String(r.id || `ehr-${r.patientId || idx}`), r.patientId || `pat-${idx}`, r.bloodType || null, typeof r.allergies === 'string' ? r.allergies : JSON.stringify(r.allergies || ''), typeof r.chronicConditions === 'string' ? r.chronicConditions : JSON.stringify(r.chronicConditions || ''), r.emergencyContact ? JSON.stringify(r.emergencyContact) : null, JSON.stringify(r), r.createdAt || nowIso]
    ));
  }

  // 7. Medical Documents
  if (Array.isArray(data.medicalDocuments) && data.medicalDocuments.length) {
    console.log(`📄 Migrating ${data.medicalDocuments.length} medical documents...`);
    await runBatched(data.medicalDocuments, 25, (m, idx) => postgres.query(
      `INSERT INTO medical_documents (id, patient_id, doctor_id, title, document_type, file_url, file_name, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, payload = EXCLUDED.payload;`,
      [String(m.id || `doc-${idx}`), m.patientId || null, m.doctorId || null, m.title || m.name || null, m.documentType || m.type || null, m.fileUrl || m.url || null, m.fileName || null, JSON.stringify(m), m.createdAt || nowIso]
    ));
  }

  // 8. Dependents
  if (Array.isArray(data.dependents) && data.dependents.length) {
    console.log(`👨‍👩‍👧 Migrating ${data.dependents.length} dependents...`);
    await runBatched(data.dependents, 25, (dep, idx) => postgres.query(
      `INSERT INTO dependents (id, user_id, name, relationship, date_of_birth, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, payload = EXCLUDED.payload;`,
      [String(dep.id || `dep-${idx}`), dep.userId || dep.patientId || null, dep.name || null, dep.relationship || dep.relation || null, dep.dateOfBirth || dep.dob || null, JSON.stringify(dep), dep.createdAt || nowIso]
    ));
  }

  // 9. Prescriptions
  if (Array.isArray(data.prescriptions) && data.prescriptions.length) {
    console.log(`💊 Migrating ${data.prescriptions.length} prescriptions...`);
    await runBatched(data.prescriptions, 25, (pr, idx) => postgres.query(
      `INSERT INTO prescriptions (id, appointment_id, patient_id, doctor_id, medications, notes, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET medications = EXCLUDED.medications, notes = EXCLUDED.notes, payload = EXCLUDED.payload;`,
      [String(pr.id || `rx-${idx}`), pr.appointmentId || null, pr.patientId || null, pr.doctorId || null, JSON.stringify(pr.medications || []), pr.notes || '', JSON.stringify(pr), pr.createdAt || nowIso]
    ));
  }

  // 10. Reviews
  if (Array.isArray(data.reviews) && data.reviews.length) {
    console.log(`⭐ Migrating ${data.reviews.length} reviews...`);
    await runBatched(data.reviews, 30, (rv, idx) => postgres.query(
      `INSERT INTO reviews (id, doctor_id, patient_id, patient_name, rating, comment, status, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, status = EXCLUDED.status, payload = EXCLUDED.payload;`,
      [String(rv.id || `rev-${idx}`), rv.doctorId || null, rv.patientId || null, rv.patientName || null, Number(rv.rating) || 5.0, rv.comment || '', rv.status || 'PUBLIÉ', JSON.stringify(rv), rv.createdAt || nowIso]
    ));
  }

  // 11. Claims
  if (Array.isArray(data.claims) && data.claims.length) {
    console.log(`🧾 Migrating ${data.claims.length} claims...`);
    await runBatched(data.claims, 25, (c, idx) => postgres.query(
      `INSERT INTO claims (id, patient_id, doctor_id, appointment_id, amount, cnam_code, status, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, payload = EXCLUDED.payload;`,
      [String(c.id || `clm-${idx}`), c.patientId || null, c.doctorId || null, c.appointmentId || null, String(c.amount || ''), c.cnamCode || null, c.status || 'PENDING', JSON.stringify(c), c.createdAt || nowIso]
    ));
  }

  // 12. Revoked Tokens
  if (Array.isArray(data.revokedTokens) && data.revokedTokens.length) {
    console.log(`🔒 Migrating ${data.revokedTokens.length} revoked tokens...`);
    await runBatched(data.revokedTokens, 25, (rt, idx) => {
      const tokenStr = typeof rt === 'string' ? rt : (rt.token || '');
      const id = (typeof rt === 'object' && rt.id) ? String(rt.id) : `rt-${idx}`;
      return postgres.query(
        `INSERT INTO revoked_tokens (id, token, expires_at, revoked_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO NOTHING;`,
        [id, tokenStr, (typeof rt === 'object' && rt.expiresAt) ? rt.expiresAt : null, (typeof rt === 'object' && rt.revokedAt) ? rt.revokedAt : nowIso]
      );
    });
  }

  // 13. Audit Logs
  if (Array.isArray(data.auditLogs) && data.auditLogs.length) {
    console.log(`🛡️ Migrating ${data.auditLogs.length} audit logs...`);
    await runBatched(data.auditLogs, 40, (log, idx) => postgres.query(
      `INSERT INTO audit_logs (id, timestamp, tunis_time, prev_hash, hash, action, actor, resource, client_ip, status, details, compliance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO NOTHING;`,
      [String(log.id || `aud-${idx}`), log.timestamp || nowIso, log.tunisTime || null, log.prevHash || null, log.hash || null, log.action || null, JSON.stringify(log.actor || {}), typeof log.resource === 'string' ? log.resource : JSON.stringify(log.resource || ''), log.clientIp || log.ip || null, log.status || 'SUCCESS', typeof log.details === 'string' ? log.details : JSON.stringify(log.details || ''), log.compliance || 'INPDP_TUNISIE_2004_63']
    ));
  }

  // 14. Notifications
  if (Array.isArray(data.notifications) && data.notifications.length) {
    console.log(`🔔 Migrating ${data.notifications.length} notifications...`);
    await runBatched(data.notifications, 40, (n, idx) => postgres.query(
      `INSERT INTO notifications (id, space, category, title, message, read, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET read = EXCLUDED.read, payload = EXCLUDED.payload;`,
      [String(n.id || `notif-${idx}`), n.space || 'admin', n.category || null, n.title || null, n.message || n.body || null, Boolean(n.read), JSON.stringify(n), safeTimestamp(n.createdAt || n.timestamp, nowIso)]
    ));
  }

  // 15. Doctor Schedules
  if (data.doctorSchedules && typeof data.doctorSchedules === 'object') {
    const entries = Object.entries(data.doctorSchedules);
    console.log(`🗓️ Migrating ${entries.length} doctor schedules...`);
    await runBatched(entries, 10, ([docId, sched]) => postgres.query(
      `INSERT INTO doctor_schedules (doctor_id, schedule, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (doctor_id) DO UPDATE SET schedule = EXCLUDED.schedule, updated_at = EXCLUDED.updated_at;`,
      [docId, JSON.stringify(sched), safeTimestamp(sched?.updatedAt, nowIso)]
    ));
  }

  // 16. Referral Letters
  if (Array.isArray(data.referralLetters) && data.referralLetters.length) {
    console.log(`✉️ Migrating ${data.referralLetters.length} referral letters...`);
    await runBatched(data.referralLetters, 20, (rl, idx) => postgres.query(
      `INSERT INTO referral_letters (id, from_doctor_id, to_doctor_id, patient_id, patient_name, status, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, payload = EXCLUDED.payload;`,
      [String(rl.id || `ref-${idx}`), rl.fromDoctorId || null, rl.toDoctorId || null, rl.patientId || null, rl.patientName || null, rl.status || 'UNREAD', JSON.stringify(rl), safeTimestamp(rl.createdAt, nowIso)]
    ));
  }

  // 17. Doctor Subscriptions
  if (Array.isArray(data.doctorSubscriptions) && data.doctorSubscriptions.length) {
    console.log(`💳 Migrating ${data.doctorSubscriptions.length} doctor subscriptions...`);
    await runBatched(data.doctorSubscriptions, 20, (sub, idx) => postgres.query(
      `INSERT INTO doctor_subscriptions (id, doctor_id, plan_id, plan_name, billing_cycle, status, starts_at, expires_at, last_payment_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (doctor_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = EXCLUDED.status, expires_at = EXCLUDED.expires_at, updated_at = EXCLUDED.updated_at;`,
      [String(sub.id || `sub-${idx}`), sub.doctorId, sub.planId || 'free', sub.planName || null, sub.billingCycle || 'monthly', sub.status || 'pending', safeTimestamp(sub.startsAt, null), safeTimestamp(sub.expiresAt, null), sub.lastPaymentId || null, safeTimestamp(sub.updatedAt, nowIso)]
    ));
  }

  // 18. Offline Payments
  if (Array.isArray(data.offlinePayments) && data.offlinePayments.length) {
    console.log(`🏦 Migrating ${data.offlinePayments.length} offline payments...`);
    await runBatched(data.offlinePayments, 20, (pay, idx) => postgres.query(
      `INSERT INTO offline_payments (id, reference_code, doctor_id, doctor_name, doctor_email, plan_id, plan_name, billing_cycle, amount_tnd, method, transaction_ref, receipt_url, notes, status, reviewed_by, reviewed_at, rejection_reason, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, reviewed_by = EXCLUDED.reviewed_by, reviewed_at = EXCLUDED.reviewed_at;`,
      [String(pay.id || `pay-${idx}`), pay.referenceCode || `REF-${idx}`, pay.doctorId, pay.doctorName || null, pay.doctorEmail || null, pay.planId || 'pro', pay.planName || null, pay.billingCycle || 'monthly', Number(pay.amountTnd) || 0, pay.method || 'RIB', pay.transactionRef || null, pay.receiptUrl || null, pay.notes || null, pay.status || 'pending', pay.reviewedBy || null, safeTimestamp(pay.reviewedAt, null), pay.rejectionReason || null, safeTimestamp(pay.createdAt, nowIso)]
    ));
  }

  console.log('✅ [Migration] All 18 tables migrated successfully!');
  return true;
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
