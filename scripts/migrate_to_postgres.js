/**
 * SahaTN / Maw2idi — Migration script from JSON to PostgreSQL
 */

const fs = require('fs');
const path = require('path');
const postgres = require('../src/config/postgres');

async function migrate() {
  const jsonPath = path.join(__dirname, '..', '..', 'data', 'database.json');
  if (!fs.existsSync(jsonPath)) {
    console.warn('[Migration] database.json not found at:', jsonPath);
    return false;
  }

  const raw = fs.readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(raw);

  console.log('🚀 [Migration] Starting migration to PostgreSQL...');
  await postgres.initSchema();

  // 1. Users
  if (Array.isArray(data.users)) {
    console.log(`👤 Migrating ${data.users.length} users...`);
    for (const u of data.users) {
      await postgres.query(
        `INSERT INTO users (uuid, email, password_hash, name, role, doctor_id, phone, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (uuid) DO UPDATE SET 
           email = EXCLUDED.email, 
           password_hash = EXCLUDED.password_hash, 
           name = EXCLUDED.name, 
           role = EXCLUDED.role, 
           doctor_id = EXCLUDED.doctor_id, 
           phone = EXCLUDED.phone;`,
        [u.uuid, u.email, u.passwordHash, u.name, u.role || 'PATIENT', u.doctorId || null, u.phone || null, u.createdAt || new Date().toISOString()]
      );
    }
  }

  // 2. Doctors
  if (Array.isArray(data.doctors)) {
    console.log(`🩺 Migrating ${data.doctors.length} doctors...`);
    for (const d of data.doctors) {
      await postgres.query(
        `INSERT INTO doctors (id, uuid, name, title, specialty, specialty_fr, specialty_ar, specialty_id, city, delegation, address, phone, email, fee, cnam, reviews_count, rating, avatar, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
         ON CONFLICT (id) DO UPDATE SET 
           name = EXCLUDED.name, 
           specialty = EXCLUDED.specialty, 
           city = EXCLUDED.city, 
           fee = EXCLUDED.fee, 
           avatar = EXCLUDED.avatar;`,
        [
          d.id,
          d.uuid || d.id,
          d.name,
          d.title || 'Dr.',
          d.specialty || d.spec,
          d.specialtyFr || d.specialty || null,
          d.specialtyAr || null,
          d.specialtyId || null,
          d.city || null,
          d.delegation || null,
          d.address || null,
          d.phone || null,
          d.email || null,
          d.fee || '70 TND',
          d.cnam !== false,
          d.reviewsCount || d.reviewCount || 0,
          d.rating || 5.0,
          d.avatar || null,
          d.createdAt || new Date().toISOString()
        ]
      );
    }
  }

  // 3. Appointments
  if (Array.isArray(data.appointments)) {
    console.log(`📅 Migrating ${data.appointments.length} appointments...`);
    for (const a of data.appointments) {
      await postgres.query(
        `INSERT INTO appointments (id, patient_id, patient_name, patient_phone, doctor_id, doctor_name, specialty, date, time, type, fee, ticket_number, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, time = EXCLUDED.time;`,
        [a.id, a.patientId, a.patientName, a.patientPhone || null, a.doctorId, a.doctorName, a.specialty || null, a.date, a.time, a.type || 'PRESENTIEL', a.fee || '70 TND', a.ticketNumber || null, a.status || 'CONFIRMED', a.createdAt || new Date().toISOString()]
      );
    }
  }

  // 4. Praticien Requests
  if (Array.isArray(data.praticienRequests)) {
    console.log(`📋 Migrating ${data.praticienRequests.length} praticien requests...`);
    for (const p of data.praticienRequests) {
      await postgres.query(
        `INSERT INTO praticien_requests (id, uuid, name, firstname, lastname, email, phone, postal, objet, spec, specialty_id, city, delegation, address, ordre, cnam, cv_file_name, fee, date, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status;`,
        [p.id, p.uuid || p.id, p.name, p.firstname || null, p.lastname || null, p.email, p.phone || null, p.postal || null, p.objet || null, p.spec || null, p.specialtyId || null, p.city || null, p.delegation || null, p.address || null, p.ordre || null, p.cnam === true, p.cvFileName || null, p.fee || '70 TND', p.date || null, p.status || 'PENDING', p.createdAt || new Date().toISOString()]
      );
    }
  }

  console.log('✅ [Migration] Complete successfully!');
  return true;
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
