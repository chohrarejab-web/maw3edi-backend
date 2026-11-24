/**
 * SahaTN / Maw2idi — PostgreSQL Dump Generator
 */

const fs = require('fs');
const path = require('path');

function generateDump() {
  const dumpPath = path.join(__dirname, '..', 'db', 'sahatn_postgres_dump.sql');
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const jsonPath = path.join(__dirname, '..', '..', 'data', 'database.json');

  const dir = path.dirname(dumpPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let ddl = '-- SAHATN POSTGRES DUMP\n';
  if (fs.existsSync(schemaPath)) {
    ddl += fs.readFileSync(schemaPath, 'utf8') + '\n\n';
  }

  if (fs.existsSync(jsonPath)) {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (Array.isArray(data.users)) {
      for (const u of data.users) {
        ddl += `INSERT INTO users (uuid, email, password_hash, name, role, doctor_id, phone, created_at) VALUES ('${u.uuid}', '${(u.email||'').replace(/'/g, "''")}', '${u.passwordHash}', '${(u.name||'').replace(/'/g, "''")}', '${u.role || 'PATIENT'}', ${u.doctorId ? `'${u.doctorId}'` : 'NULL'}, ${u.phone ? `'${u.phone}'` : 'NULL'}, '${u.createdAt || new Date().toISOString()}') ON CONFLICT (uuid) DO NOTHING;\n`;
      }
    }
    if (Array.isArray(data.doctors)) {
      for (const d of data.doctors) {
        ddl += `INSERT INTO doctors (id, uuid, name, title, specialty, specialty_fr, specialty_ar, specialty_id, city, delegation, address, phone, email, fee, cnam, reviews_count, rating, created_at) VALUES ('${d.id}', '${d.uuid || d.id}', '${(d.name||'').replace(/'/g, "''")}', '${(d.title||'Dr.').replace(/'/g, "''")}', '${(d.specialty||d.spec||'').replace(/'/g, "''")}', '${(d.specialtyFr||d.specialty||'').replace(/'/g, "''")}', '${(d.specialtyAr||'').replace(/'/g, "''")}', '${(d.specialtyId||'').replace(/'/g, "''")}', '${(d.city||'').replace(/'/g, "''")}', '${(d.delegation||'').replace(/'/g, "''")}', '${(d.address||'').replace(/'/g, "''")}', '${(d.phone||'').replace(/'/g, "''")}', '${(d.email||'').replace(/'/g, "''")}', '${d.fee || '70 TND'}', ${d.cnam !== false}, ${d.reviewsCount || 0}, ${d.rating || 5.0}, '${d.createdAt || new Date().toISOString()}') ON CONFLICT (id) DO NOTHING;\n`;
      }
    }
    if (Array.isArray(data.appointments)) {
      for (const a of data.appointments) {
        ddl += `INSERT INTO appointments (id, patient_id, patient_name, patient_phone, doctor_id, doctor_name, specialty, date, time, type, fee, ticket_number, status, created_at) VALUES ('${a.id}', '${a.patientId}', '${(a.patientName||'').replace(/'/g, "''")}', ${a.patientPhone ? `'${a.patientPhone}'` : 'NULL'}, '${a.doctorId}', '${(a.doctorName||'').replace(/'/g, "''")}', '${(a.specialty||'').replace(/'/g, "''")}', '${a.date}', '${a.time}', '${a.type || 'PRESENTIEL'}', '${a.fee || '70 TND'}', ${a.ticketNumber ? `'${a.ticketNumber}'` : 'NULL'}, '${a.status || 'CONFIRMED'}', '${a.createdAt || new Date().toISOString()}') ON CONFLICT (id) DO NOTHING;\n`;
      }
    }
  }

  fs.writeFileSync(dumpPath, ddl, 'utf8');
  console.log('✅ Generated dump at:', dumpPath, `(${ddl.length} bytes)`);
  return dumpPath;
}

module.exports = { generateDump };

if (require.main === module) {
  generateDump();
}
