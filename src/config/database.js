const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const postgres = require('./postgres');

const DB_FILE = path.join(__dirname, '..', '..', 'data', 'database.json');

// Helper to safely load JSON
function loadJson(filePath, fallback = null) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    console.error(`[DB] Error loading ${filePath}:`, err.message);
  }
  return fallback;
}

// Default doctor schedule template
function getDefaultDoctorSchedule(doctorId = 'doc-1') {
  return {
    doctorId,
    slotDuration: 20,
    bufferTime: 0,
    maxDailyPatients: 25,
    emergencySlots: '2',
    modes: { cabinet: true, teleconsult: true, domicile: false },
    leave: { start: '', end: '', reason: '' },
    leaves: [],
    days: {
      lundi: { isOpen: true, matinStart: '08:30', matinEnd: '13:00', pauseStart: '13:00', pauseEnd: '14:00', apremStart: '14:00', apremEnd: '18:30', walkin: true },
      mardi: { isOpen: true, matinStart: '08:30', matinEnd: '13:00', pauseStart: '13:00', pauseEnd: '14:00', apremStart: '14:00', apremEnd: '18:30', walkin: true },
      mercredi: { isOpen: true, matinStart: '08:30', matinEnd: '13:00', pauseStart: '13:00', pauseEnd: '14:00', apremStart: '14:00', apremEnd: '18:30', walkin: true },
      jeudi: { isOpen: true, matinStart: '08:30', matinEnd: '13:00', pauseStart: '13:00', pauseEnd: '14:00', apremStart: '14:00', apremEnd: '18:30', walkin: true },
      vendredi: { isOpen: true, matinStart: '08:30', matinEnd: '13:00', pauseStart: '13:00', pauseEnd: '14:00', apremStart: '14:00', apremEnd: '18:30', walkin: true },
      samedi: { isOpen: true, matinStart: '08:30', matinEnd: '13:30', pauseStart: '', pauseEnd: '', apremStart: '', apremEnd: '', walkin: true },
      dimanche: { isOpen: false, matinStart: '09:00', matinEnd: '13:00', pauseStart: '', pauseEnd: '', apremStart: '', apremEnd: '', walkin: false }
    },
    updatedAt: new Date().toISOString()
  };
}

// Initial Seeding Logic
function getSeedData() {
  const doctorsData = loadJson(path.join(__dirname, '..', '..', 'pages', 'Doctors_pages', 'doctors.json'), []);
  const adminData = loadJson(path.join(__dirname, '..', '..', 'pages', 'Admin_pages', 'admin-db.json'), {});
  const patientsData = loadJson(path.join(__dirname, '..', '..', 'pages', 'Patients_pages', 'patients-queue.json'), {});

  // Default hashed password for demo accounts: "Saha2026!"
  const salt = bcrypt.genSaltSync(10);
  const defaultHash = bcrypt.hashSync('Saha2026!', salt);

  const initialUsers = [
    {
      uuid: 'usr-admin',
      email: 'admin@sahatn.tn',
      passwordHash: defaultHash,
      name: 'Super Administrateur',
      role: 'SUPER_ADMIN',
      createdAt: new Date().toISOString()
    },
    {
      uuid: 'usr-8812',
      email: 'dr.selim@sahatn.tn',
      passwordHash: defaultHash,
      name: 'Dr. Selim Ben Ali',
      role: 'DOCTOR',
      doctorId: 'doc-1',
      createdAt: new Date().toISOString()
    },
    {
      uuid: 'usr-9014',
      email: 'dr.meriem@sahatn.tn',
      passwordHash: defaultHash,
      name: 'Dr. Meriem Karray',
      role: 'DOCTOR',
      doctorId: 'doc-2',
      createdAt: new Date().toISOString()
    },
    {
      uuid: 'usr-4410',
      email: 'fatma.benabdallah@gmail.com',
      passwordHash: defaultHash,
      name: 'Fatma Ben Abdallah',
      role: 'PATIENT',
      phone: '+216 20 999 123',
      createdAt: new Date().toISOString()
    },
    {
      uuid: 'usr-4411',
      email: 'fatma.benali@gmail.com',
      passwordHash: defaultHash,
      name: 'Fatma Benali',
      role: 'PATIENT',
      phone: '+216 98 123 456',
      createdAt: new Date().toISOString()
    },
    {
      uuid: 'usr-sec-1',
      email: 'secretaire.selim@sahatn.tn',
      passwordHash: defaultHash,
      name: 'Secrétaire Cabinet Dr. Ben Ali',
      role: 'SECRETARY',
      doctorId: 'doc-1',
      createdAt: new Date().toISOString()
    },
    {
      uuid: 'usr-sec-2',
      email: 'secretaire@sahatn.tn',
      passwordHash: defaultHash,
      name: 'Secrétaire Médicale',
      role: 'SECRETARY',
      doctorId: 'doc-1',
      createdAt: new Date().toISOString()
    },
    {
      uuid: 'usr-test-pat',
      email: 'test.patient@sahatn.tn',
      passwordHash: defaultHash,
      name: 'Yassine Mansour',
      role: 'PATIENT',
      phone: '+216 55 123 789',
      createdAt: new Date().toISOString()
    },
    {
      uuid: 'usr-wassim-pinky',
      email: 'wassim.pinky@gmail.com',
      passwordHash: defaultHash,
      name: 'Wassim Pinky',
      role: 'PATIENT',
      phone: '+216 22 123 456',
      createdAt: new Date().toISOString()
    }
  ];

  return {
    users: initialUsers,
    doctors: doctorsData.length ? doctorsData : [
      {
        id: 'doc-1',
        uuid: 'doc-1',
        name: 'Dr. Selim Ben Ali',
        specialty: 'Cardiologie & Maladies Vasculaires',
        specialtyCode: 'cardio',
        city: 'Tunis',
        delegation: 'Ennasr 2',
        address: 'Centre Médical Ennasr 2, Avenue Hédi Nouira, 2037',
        phone: '+216 71 830 100',
        email: 'dr.selim@sahatn.tn',
        fee: '70 TND',
        cnam: true,
        telehealth: true,
        rating: 4.95,
        reviewCount: 42,
        consultationMinutes: 20
      }
    ],
    appointments: [
      {
        id: 'apt-101',
        patientId: 'usr-4410',
        patientName: 'Fatma Ben Abdallah',
        patientPhone: '+216 20 999 123',
        doctorId: 'doc-1',
        doctorName: 'Dr. Selim Ben Ali',
        specialty: 'Cardiologie',
        date: 'Aujourd\'hui',
        time: '11:00',
        type: 'PRESENTIEL',
        fee: '70 TND',
        status: 'CONFIRMED',
        ticketNumber: 'N° 04',
        createdAt: new Date().toISOString()
      }
    ],
    queue: patientsData.queueEntries || [
      { uuid: 'q-101', patient: 'Fatma Ben Abdallah', doctor: 'Dr. Selim Ben Ali', doctorId: 'doc-1', rank: 1, stage: 'SALLE_D_ATTENTE', ticket: 'N° 04' },
      { uuid: 'q-102', patient: 'Kais Saied', doctor: 'Dr. Selim Ben Ali', doctorId: 'doc-1', rank: 2, stage: 'SALLE_D_ATTENTE', ticket: 'N° 05' },
      { uuid: 'q-103', patient: 'Sami Mansour', doctor: 'Dr. Meriem Karray', doctorId: 'doc-2', rank: 1, stage: 'ARRIVE', ticket: 'N° 02' }
    ],
    delayMinutes: patientsData.delayMinutes || 0,
    patientHealthRecords: [
      {
        id: 'ehr-4410',
        patientId: 'usr-4410',
        patientName: 'Fatma Ben Abdallah',
        bloodType: 'O+',
        allergies: ['Pénicilline (Urticaire sévère)'],
        chronicDiseases: ['Hypertension Artérielle (HTA)', 'Diabète Type 2'],
        height: 168,
        weight: 64,
        emergencyContact: {
          name: 'Moncef Ben Abdallah',
          relation: 'Époux',
          phone: '+216 98 220 330'
        },
        vaccines: [
          { name: 'Tétanos / Polio', date: '2023-04-12', validUntil: '2033-04-12' },
          { name: 'COVID-19 (Pfizer Bivalent)', date: '2022-11-05', dose: 'Rappel 3' },
          { name: 'Grippe Saisonnière', date: '2025-10-15', dose: 'Annuel' }
        ]
      }
    ],
    medicalDocuments: [
      {
        id: 'doc-401',
        patientId: 'usr-4410',
        title: 'Bilan Biologique Complet & NFS Glycémie',
        category: 'BIOLOGIE',
        doctorName: 'Laboratoire d\'Analyses Médicales Ennasr',
        date: '2026-08-25',
        notes: 'Glycémie à jeun 1.05 g/L. Cholestérol HDL/LDL normal.',
        fileUrl: 'bilan_biologique_aout2026.pdf'
      },
      {
        id: 'doc-402',
        patientId: 'usr-4410',
        title: 'Échocardiographie Doppler Cardiaque',
        category: 'RADIOLOGIE',
        doctorName: 'Dr. Selim Ben Ali',
        date: '2026-08-10',
        notes: 'Fraction d\'éjection ventriculaire gauche normale (62%). Pas de valvulopathie significative.',
        fileUrl: 'echo_doppler_selim.pdf'
      }
    ],
    dependents: [
      {
        id: 'dep-501',
        patientId: 'usr-4410',
        name: 'Youssef Ben Abdallah',
        relation: 'ENFANT',
        birthDate: '2018-09-14',
        gender: 'M',
        bloodType: 'O+'
      },
      {
        id: 'dep-502',
        patientId: 'usr-4410',
        name: 'Khedija Mansour',
        relation: 'PARENT',
        birthDate: '1954-03-22',
        gender: 'F',
        bloodType: 'A+'
      }
    ],
    prescriptions: [
      {
        id: 'ord-301',
        patientId: 'usr-4410',
        patientName: 'Fatma Ben Abdallah',
        doctorId: 'doc-1',
        doctorName: 'Dr. Selim Ben Ali',
        drugs: [
          { name: 'Doliprane 1000mg', codePct: 'PCT-DOL-01', posology: '1 cp toutes les 8h si douleur', duration: '5 jours' },
          { name: 'Inexium 40mg', codePct: 'PCT-INX-04', posology: '1 cp le matin à jeun', duration: '14 jours' }
        ],
        date: '2026-08-31',
        qrHash: 'sha256-7fa981e4b3c2098d5f1a6c4b9e',
        status: 'ACTIVE'
      }
    ],
    reviews: [
      {
        id: 'rev-1',
        doctorId: 'doc-1',
        patientName: 'Mourad Trabelsi',
        displayInitial: 'Mourad T.',
        date: '28 Août 2026',
        rating: 5.0,
        criteria: { punctuality: 5.0, bedsideManner: 5.0, hygiene: 5.0, careQuality: 5.0 },
        tags: ['Très à l\'écoute', 'Explications claires', 'Ponctuel', 'Cabinet moderne'],
        comment: 'Excellente consultation de cardiologie. Le Dr. Ben Ali a pris le temps d\'expliquer mon bilan avec beaucoup de pédagogie.',
        verified: true,
        reply: {
          doctorName: 'Dr. Selim Ben Ali',
          date: '29 Août 2026',
          text: 'Merci beaucoup pour votre retour bienveillant Mourad. Ravi d\'avoir pu vous rassurer.'
        }
      }
    ],
    praticienRequests: [
      {
        id: 'prat-demo-1',
        name: 'Dr. Amine Ben Romdhane',
        email: 'dr.amine@sahatn.tn',
        phone: '+216 98 445 566',
        postal: '2037',
        spec: 'Cardiologie & Maladies Vasculaires',
        city: 'Ariana',
        delegation: 'Ennasr 2',
        ordre: 'N° 20194',
        status: 'PENDING',
        date: '14/08/2026 08:25'
      }
    ],
    auditLogs: [
      { id: 'cmp-101', time: '14/08/2026 07:45', title: 'Rappel Rendez-Vous Cabinet (SMS Batch)', role: 'PATIENT', tenant: 'ARIANA', channels: ['PUSH', 'SMS'], delivered: '412 / 415', status: 'DELIVERED' },
      { id: 'cmp-102', time: '13/08/2026 18:20', title: 'Alerte Canicule & Hydratation Patients', role: 'PATIENT', tenant: 'GLOBAL', channels: ['PUSH', 'EMAIL'], delivered: '2,890 / 2,900', status: 'DELIVERED' }
    ],
    notifications: [
      // ════ PATIENT NOTIFICATIONS ════
      {
        id: 'notif-p1',
        space: 'patient',
        category: 'rdv',
        icon: '📅',
        title: 'Rendez-vous Confirmé',
        message: 'Votre consultation chez Dr. Selim Ben Ali (Cardiologie) est confirmée aujourd\'hui à 14:30.',
        timestamp: 'Il y a 10 min',
        timeMs: Date.now() - 600000,
        read: false,
        actionUrl: '../Patients_pages/patient-dashboard.html'
      },
      {
        id: 'notif-p2',
        space: 'patient',
        category: 'ordonnance',
        icon: '💊',
        title: 'Ordonnance Électronique Prête',
        message: 'Dr. Selim Ben Ali a émis votre ordonnance électronique certifiée (Doliprane 1000mg, Inexium 40mg).',
        timestamp: 'Il y a 20 min',
        timeMs: Date.now() - 1200000,
        read: false,
        actionUrl: '../Patients_pages/patient-dashboard.html'
      },
      {
        id: 'notif-p3',
        space: 'patient',
        category: 'cabinet',
        icon: '⏱️',
        title: 'Avis de Retard Cabinet',
        message: 'Le cabinet médical Dr. Selim Ben Ali signale un décalage temporaire de +15 minutes.',
        timestamp: 'Il y a 30 min',
        timeMs: Date.now() - 1800000,
        read: false,
        actionUrl: '../Patients_pages/patient-dashboard.html'
      },
      {
        id: 'notif-p4',
        space: 'patient',
        category: 'sante',
        icon: '🩺',
        title: 'Alerte Canicule & Hydratation',
        message: 'Conseil prévention SahaTN : maintenez une hydratation régulière et protégez-vous des fortes chaleurs.',
        timestamp: 'Hier',
        timeMs: Date.now() - 86400000,
        read: true,
        actionUrl: '../Patients_pages/patients.html'
      },

      // ════ DOCTOR NOTIFICATIONS ════
      {
        id: 'notif-d1',
        space: 'doctor',
        category: 'patient',
        icon: '⚡',
        title: 'Nouveau RDV Urgence',
        doctorId: 'doc-1',
        doctorName: 'Dr. Selim Ben Ali',
        message: 'Fatma Ben Abdallah a réservé une consultation prioritaire aujourd\'hui à 10:30.',
        timestamp: 'Il y a 15 min',
        timeMs: Date.now() - 900000,
        read: false,
        actionUrl: '../Doctors_pages/doctor-dashboard.html'
      },
      {
        id: 'notif-d2',
        space: 'doctor',
        category: 'patient',
        icon: '👤',
        title: 'Arrivée en Salle d\'Attente',
        doctorId: 'doc-1',
        doctorName: 'Dr. Selim Ben Ali',
        message: 'Sami Mansour (Ticket N° 01) vient de pointer son arrivée à l\'accueil.',
        timestamp: 'Il y a 25 min',
        timeMs: Date.now() - 1500000,
        read: false,
        actionUrl: '../Doctors_pages/doctor-dashboard.html'
      },
      {
        id: 'notif-d3',
        space: 'doctor',
        category: 'avis',
        icon: '⭐',
        title: 'Nouvel Avis Certifié 5★',
        doctorId: 'doc-1',
        doctorName: 'Dr. Selim Ben Ali',
        message: 'Mourad Trabelsi : « Excellente consultation de cardiologie. Médecin très pédagogue. »',
        timestamp: 'Il y a 40 min',
        timeMs: Date.now() - 2400000,
        read: true,
        actionUrl: '../Doctors_pages/doctor-dashboard.html'
      },

      // ════ SECRETAIRE NOTIFICATIONS ════
      {
        id: 'notif-s1',
        space: 'secretaire',
        category: 'patient',
        icon: '👤',
        title: 'Arrivée Accueil Cabinet',
        message: 'Sami Mansour vient de pointer son arrivée pour Dr. Selim Ben Ali.',
        timestamp: 'Il y a 25 min',
        timeMs: Date.now() - 1500000,
        read: true,
        actionUrl: '../Doctors_pages/doctor-dashboard.html?tab=agenda'
      },

      // ════ ADMIN NOTIFICATIONS ════
      {
        id: 'notif-a1',
        space: 'admin',
        category: 'praticien',
        icon: '👨‍⚕️',
        title: 'Nouvelle Demande Praticien',
        message: 'Dr. τηƪ TOKYO (Cardiologie) a soumis son dossier et attend votre validation.',
        timestamp: 'Il y a 5 min',
        timeMs: Date.now() - 300000,
        read: false,
        actionUrl: '../Admin_pages/admin-db.html?tab=praticiens'
      },
      {
        id: 'notif-a2',
        space: 'admin',
        category: 'system',
        icon: '💾',
        title: 'Sauvegarde Automatique Réussie',
        message: 'Dump BDD PostgreSQL (2.4 MB) généré et synchronisé avec succès.',
        timestamp: 'Il y a 50 min',
        timeMs: Date.now() - 3000000,
        read: true,
        actionUrl: '../Admin_pages/admin-db.html?tab=sql'
      }
    ]
  };
}

class Database {
  constructor() {
    this.data = null;
    this.postgres = postgres;
    this.init();
    this.initPostgres();
  }

  async initPostgres() {
    try {
      const conn = await postgres.testConnection();
      if (conn.ok) {
        console.log(`🐘 [PostgreSQL] Connected to "${conn.database}" at ${conn.timestamp}`);
        try {
          await postgres.initSchema();
          await this.loadFromPostgres();
        } catch (e) {
          console.warn('[PostgreSQL] Schema/hydration note:', e.message);
        }
      } else {
        if (process.env.NODE_ENV === 'production' && process.env.USE_POSTGRES === 'true') {
          console.error(`🚨 [CRITICAL DB] PostgreSQL connection failed in PRODUCTION (${conn.error}). Running on local JSON fallback is unsafe for multi-instance production deployments!`);
        } else {
          console.log(`ℹ️  [DB] PostgreSQL not connected (${conn.error}). Using relational JSON persistence (data/database.json).`);
        }
      }
    } catch (e) {
      console.log(`ℹ️  [DB] PostgreSQL connection check: ${e.message}`);
    }
  }

  async loadFromPostgres() {
    if (!postgres.isPostgresConnected()) return false;
    try {
      const dRes = await postgres.query('SELECT * FROM doctors;');
      if (dRes.rows && dRes.rows.length) {
        this.data.doctors = dRes.rows.map(d => ({
          ...d,
          cvFileName: d.cv_file_name || d.cvFileName || null,
          cvFileData: d.cv_file_data || d.cvFileData || null,
          signature: d.signature || d.signature_data || d.signatureData || null,
          signatureData: d.signature_data || d.signature || d.signatureData || null,
          specialtyFr: d.specialty_fr || d.specialty,
          specialtyAr: d.specialty_ar,
          specialtyId: d.specialty_id,
          reviewsCount: d.reviews_count,
          reviewCount: d.review_count,
          cnamReimbursement: d.cnam_reimbursement,
          cnamType: d.cnam_type,
          cnamCode: d.cnam_code,
          insuranceAccepted: d.insurance_accepted,
          active: d.active !== false && d.account_finalized !== false,
          accountFinalized: d.account_finalized === true || d.accountFinalized === true,
          createdAt: d.created_at
        }));
      }

      const uRes = await postgres.query('SELECT * FROM users;');
      if (uRes.rows && uRes.rows.length) {
        this.data.users = uRes.rows.map(u => ({
          ...u,
          avatar: u.avatar || null,
          passwordHash: u.password_hash,
          doctorId: u.doctor_id,
          createdAt: u.created_at
        }));
      }

      const aRes = await postgres.query('SELECT * FROM appointments;');
      if (aRes.rows && aRes.rows.length) {
        this.data.appointments = aRes.rows.map(a => ({
          ...a,
          patientId: a.patient_id,
          patientName: a.patient_name,
          patientPhone: a.patient_phone,
          doctorId: a.doctor_id,
          doctorName: a.doctor_name,
          ticketNumber: a.ticket_number,
          createdAt: a.created_at,
          dateIso: a.date_iso || a.dateIso || null
        }));
      }

      const qRes = await postgres.query('SELECT * FROM queue;');
      if (qRes.rows && qRes.rows.length) {
        this.data.queue = qRes.rows.map(q => ({
          ...q,
          doctorId: q.doctor_id,
          createdAt: q.created_at
        }));
      }

      const pRes = await postgres.query('SELECT * FROM praticien_requests;');
      if (pRes.rows && pRes.rows.length) {
        this.data.praticienRequests = pRes.rows.map(p => ({
          ...p,
          specialtyId: p.specialty_id,
          cvFileName: p.cv_file_name,
          cvFileData: p.cv_file_data || null,
          signature: p.signature || p.signature_data || p.signatureData || null,
          signatureData: p.signature_data || p.signature || p.signatureData || null,
          avatar: p.avatar || null,
          accountFinalized: Boolean(p.account_finalized || p.accountFinalized),
          createdAt: p.created_at
        }));
      }

      try {
        const subRes = await postgres.query('SELECT * FROM doctor_subscriptions;');
        if (subRes.rows && subRes.rows.length) {
          this.data.doctorSubscriptions = subRes.rows.map(s => ({
            id: s.id,
            doctorId: s.doctor_id,
            planId: s.plan_id,
            planName: s.plan_name,
            billingCycle: s.billing_cycle,
            status: s.status,
            startsAt: s.starts_at,
            expiresAt: s.expires_at,
            lastPaymentId: s.last_payment_id,
            updatedAt: s.updated_at
          }));
        }
      } catch (e) { /* table may not exist yet */ }

      try {
        const payRes = await postgres.query('SELECT * FROM offline_payments ORDER BY created_at DESC;');
        if (payRes.rows && payRes.rows.length) {
          this.data.offlinePayments = payRes.rows.map(p => ({
            id: p.id,
            referenceCode: p.reference_code,
            doctorId: p.doctor_id,
            doctorName: p.doctor_name,
            doctorEmail: p.doctor_email,
            planId: p.plan_id,
            planName: p.plan_name,
            billingCycle: p.billing_cycle,
            amountTnd: Number(p.amount_tnd),
            method: p.method,
            transactionRef: p.transaction_ref,
            receiptUrl: p.receipt_url,
            notes: p.notes,
            status: p.status,
            reviewedBy: p.reviewed_by,
            reviewedAt: p.reviewed_at,
            rejectionReason: p.rejection_reason,
            createdAt: p.created_at
          }));
        }
      } catch (e) { /* table may not exist yet */ }

      const loadJsonBacked = async (sql, targetKey, mapper) => {
        try {
          const r = await postgres.query(sql);
          if (r.rows && r.rows.length) {
            this.data[targetKey] = r.rows.map(mapper);
          }
        } catch (e) { /* ignore if table not ready */ }
      };

      await loadJsonBacked('SELECT * FROM reviews ORDER BY created_at DESC;', 'reviews', r => ({
        ...(r.payload || {}),
        id: r.id,
        doctorId: r.doctor_id,
        patientId: r.patient_id,
        patientName: r.patient_name,
        rating: Number(r.rating) || 5.0,
        comment: r.comment || '',
        status: r.status || 'PUBLIÉ',
        createdAt: r.created_at
      }));

      await loadJsonBacked('SELECT * FROM prescriptions ORDER BY created_at DESC;', 'prescriptions', r => ({
        ...(r.payload || {}),
        id: r.id,
        appointmentId: r.appointment_id,
        patientId: r.patient_id,
        doctorId: r.doctor_id,
        medications: r.medications || r.payload?.medications || [],
        notes: r.notes || r.payload?.notes || '',
        createdAt: r.created_at
      }));

      await loadJsonBacked('SELECT * FROM patient_health_records;', 'patientHealthRecords', r => ({
        ...(r.payload || {}),
        id: r.id,
        patientId: r.patient_id,
        bloodType: r.blood_type || r.payload?.bloodType || null,
        allergies: r.allergies || r.payload?.allergies || '',
        chronicConditions: r.chronic_conditions || r.payload?.chronicConditions || '',
        emergencyContact: r.emergency_contact || r.payload?.emergencyContact || null,
        createdAt: r.created_at
      }));

      await loadJsonBacked('SELECT * FROM medical_documents ORDER BY created_at DESC;', 'medicalDocuments', r => ({
        ...(r.payload || {}),
        id: r.id,
        patientId: r.patient_id,
        doctorId: r.doctor_id,
        title: r.title,
        documentType: r.document_type,
        fileUrl: r.file_url,
        fileName: r.file_name,
        createdAt: r.created_at
      }));

      await loadJsonBacked('SELECT * FROM dependents ORDER BY created_at DESC;', 'dependents', r => ({
        ...(r.payload || {}),
        id: r.id,
        userId: r.user_id,
        name: r.name,
        relationship: r.relationship,
        dateOfBirth: r.date_of_birth,
        createdAt: r.created_at
      }));

      await loadJsonBacked('SELECT * FROM claims ORDER BY created_at DESC;', 'claims', r => ({
        ...(r.payload || {}),
        id: r.id,
        patientId: r.patient_id,
        doctorId: r.doctor_id,
        appointmentId: r.appointment_id,
        amount: r.amount,
        cnamCode: r.cnam_code,
        status: r.status,
        createdAt: r.created_at
      }));

      await loadJsonBacked('SELECT * FROM revoked_tokens;', 'revokedTokens', r => ({
        id: r.id,
        token: r.token,
        expiresAt: r.expires_at,
        revokedAt: r.revoked_at
      }));

      await loadJsonBacked('SELECT * FROM notifications ORDER BY created_at DESC;', 'notifications', r => ({
        ...(r.payload || {}),
        id: r.id,
        space: r.space || r.payload?.space || 'admin',
        category: r.category || r.payload?.category || 'system',
        title: r.title,
        message: r.message,
        read: Boolean(r.read),
        createdAt: r.created_at
      }));

      await loadJsonBacked('SELECT * FROM referral_letters ORDER BY created_at DESC;', 'referralLetters', r => ({
        ...(r.payload || {}),
        id: r.id,
        fromDoctorId: r.from_doctor_id,
        toDoctorId: r.to_doctor_id,
        patientId: r.patient_id,
        patientName: r.patient_name,
        status: r.status,
        createdAt: r.created_at
      }));

      try {
        const schedRes = await postgres.query('SELECT * FROM doctor_schedules;');
        if (schedRes.rows && schedRes.rows.length) {
          const map = { ...(this.data.doctorSchedules || {}) };
          for (const row of schedRes.rows) {
            if (row.doctor_id && row.schedule) map[row.doctor_id] = row.schedule;
          }
          this.data.doctorSchedules = map;
        }
      } catch (e) { /* ignore */ }

      this.save();
      console.log(`✅ [DB] Hydrated ${this.data.doctors.length} doctors and ${this.data.users.length} users directly from PostgreSQL.`);
      return true;
    } catch (e) {
      console.warn('[DB] loadFromPostgres note:', e.message);
      return false;
    }
  }

  isPostgresConnected() {
    return postgres.isPostgresConnected();
  }

  async pgQuery(text, params) {
    return postgres.query(text, params);
  }

  getPostgresStatus() {
    return {
      connected: postgres.isPostgresConnected(),
      lastError: postgres.getLastError(),
      config: postgres.getConfigSummary()
    };
  }

  async syncToPostgres(collection, action, item) {
    if (!postgres.isPostgresConnected()) return;
    try {
      if (collection === 'users') {
        if (action === 'insert' || action === 'update') {
          await postgres.query(
            `INSERT INTO users (uuid, email, password_hash, name, role, doctor_id, phone, avatar, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name, role = EXCLUDED.role, doctor_id = EXCLUDED.doctor_id, phone = EXCLUDED.phone, avatar = EXCLUDED.avatar;`,
            [item.uuid, item.email, item.passwordHash || item.password_hash, item.name, item.role || 'PATIENT', item.doctorId || item.doctor_id || null, item.phone || null, item.avatar || null, item.createdAt || new Date().toISOString()]
          );
        } else if (action === 'remove') {
          await postgres.query(`DELETE FROM users WHERE uuid = $1;`, [item.uuid]);
        }
      } else if (collection === 'doctors') {
        if (action === 'insert' || action === 'update') {
          await postgres.query(
            `INSERT INTO doctors (id, uuid, name, title, specialty, city, delegation, address, phone, email, fee, cnam, telehealth, rating, reviews_count, avatar, cv_file_name, cv_file_data, signature, signature_data, active, account_finalized, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, specialty = EXCLUDED.specialty, city = EXCLUDED.city, fee = EXCLUDED.fee, cnam = EXCLUDED.cnam, avatar = EXCLUDED.avatar, cv_file_name = EXCLUDED.cv_file_name, cv_file_data = EXCLUDED.cv_file_data, signature = EXCLUDED.signature, signature_data = EXCLUDED.signature_data, rating = EXCLUDED.rating, reviews_count = EXCLUDED.reviews_count, active = EXCLUDED.active, account_finalized = EXCLUDED.account_finalized;`,
            [item.id, item.uuid || item.id, item.name, item.title || 'Dr.', item.specialty || item.spec, item.city, item.delegation, item.address, item.phone, item.email, item.fee || '70 TND', item.cnam !== false, item.telehealth === true, item.rating || 5.0, item.reviewsCount || 0, item.avatar || null, item.cvFileName || item.cv_file_name || null, item.cvFileData || item.cv_file_data || null, item.signature || item.signatureData || null, item.signatureData || item.signature || null, item.active !== false && item.accountFinalized !== false, item.accountFinalized === true, item.createdAt || new Date().toISOString()]
          );
        } else if (action === 'remove') {
          await postgres.query(`DELETE FROM doctors WHERE id = $1;`, [item.id]);
        }
      } else if (collection === 'reviews') {
        if (action === 'insert' || action === 'update') {
          await postgres.query(
            `INSERT INTO reviews (id, doctor_id, patient_id, patient_name, rating, comment, status, payload, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, status = EXCLUDED.status, payload = EXCLUDED.payload;`,
            [item.id, item.doctorId, item.patientId || null, item.patientName || item.patient, parseFloat(item.rating) || 5.0, item.comment || '', (item.status || 'PUBLIÉ').toUpperCase(), JSON.stringify(item), item.createdAt || new Date().toISOString()]
          );
        } else if (action === 'remove') {
          await postgres.query(`DELETE FROM reviews WHERE id = $1;`, [item.id]);
        }
      } else if (collection === 'appointments') {
        if (action === 'insert' || action === 'update') {
          await postgres.query(
            `INSERT INTO appointments (id, patient_id, patient_name, patient_phone, doctor_id, doctor_name, specialty, date, time, type, fee, ticket_number, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, time = EXCLUDED.time;`,
            [item.id, item.patientId, item.patientName, item.patientPhone || null, item.doctorId, item.doctorName, item.specialty || null, item.date, item.time, item.type || 'PRESENTIEL', item.fee || '70 TND', item.ticketNumber || null, item.status || 'CONFIRMED', item.createdAt || new Date().toISOString()]
          );
        } else if (action === 'remove') {
          await postgres.query(`DELETE FROM appointments WHERE id = $1;`, [item.id]);
        }
      } else if (collection === 'praticienRequests') {
        if (action === 'insert' || action === 'update') {
          await postgres.query(
            `INSERT INTO praticien_requests (id, uuid, name, firstname, lastname, email, phone, postal, objet, spec, specialty_id, city, delegation, address, ordre, cnam, cv_file_name, cv_file_data, signature, signature_data, avatar, fee, date, status, doctor_id, account_finalized, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
             ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, cv_file_name = EXCLUDED.cv_file_name, cv_file_data = EXCLUDED.cv_file_data, signature = EXCLUDED.signature, signature_data = EXCLUDED.signature_data, avatar = EXCLUDED.avatar, doctor_id = EXCLUDED.doctor_id, account_finalized = EXCLUDED.account_finalized;`,
            [item.id, item.uuid || item.id, item.name, item.firstname || null, item.lastname || null, item.email, item.phone || null, item.postal || null, item.objet || null, item.spec || null, item.specialtyId || null, item.city || null, item.delegation || null, item.address || null, item.ordre || null, item.cnam === true, item.cvFileName || item.cv_file_name || null, item.cvFileData || item.cv_file_data || null, item.signature || item.signatureData || null, item.signatureData || item.signature || null, item.avatar || null, item.fee || '70 TND', item.date || null, item.status || 'PENDING', item.doctorId || null, item.accountFinalized === true, item.createdAt || new Date().toISOString()]
          );
        }
      } else if (collection === 'auditLogs' && action === 'insert') {
        await postgres.query(
          `INSERT INTO audit_logs (id, timestamp, tunis_time, prev_hash, hash, action, actor, resource, client_ip, status, details, compliance)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (id) DO NOTHING;`,
          [item.id, item.timestamp || new Date().toISOString(), item.tunisTime || null, item.prevHash || null, item.hash || 'hash', item.action, JSON.stringify(item.actor || {}), item.resource || null, item.clientIp || null, item.status || null, item.details || null, item.compliance || 'INPDP_TUNISIE_2004_63']
        );
      } else if (collection === 'doctorSubscriptions') {
        if (action === 'insert' || action === 'update') {
          await postgres.query(
            `INSERT INTO doctor_subscriptions (id, doctor_id, plan_id, plan_name, billing_cycle, status, starts_at, expires_at, last_payment_id, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (doctor_id) DO UPDATE SET
               plan_id = EXCLUDED.plan_id,
               plan_name = EXCLUDED.plan_name,
               billing_cycle = EXCLUDED.billing_cycle,
               status = EXCLUDED.status,
               starts_at = EXCLUDED.starts_at,
               expires_at = EXCLUDED.expires_at,
               last_payment_id = EXCLUDED.last_payment_id,
               updated_at = EXCLUDED.updated_at;`,
            [item.id, item.doctorId, item.planId, item.planName || null, item.billingCycle || 'monthly', item.status || 'pending', item.startsAt || null, item.expiresAt || null, item.lastPaymentId || null, item.updatedAt || new Date().toISOString()]
          );
        }
      } else if (collection === 'offlinePayments') {
        if (action === 'insert' || action === 'update') {
          await postgres.query(
            `INSERT INTO offline_payments (id, reference_code, doctor_id, doctor_name, doctor_email, plan_id, plan_name, billing_cycle, amount_tnd, method, transaction_ref, receipt_url, notes, status, reviewed_by, reviewed_at, rejection_reason, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
             ON CONFLICT (id) DO UPDATE SET
               status = EXCLUDED.status,
               reviewed_by = EXCLUDED.reviewed_by,
               reviewed_at = EXCLUDED.reviewed_at,
               rejection_reason = EXCLUDED.rejection_reason;`,
            [item.id, item.referenceCode, item.doctorId, item.doctorName || null, item.doctorEmail || null, item.planId, item.planName || null, item.billingCycle || 'monthly', Number(item.amountTnd) || 0, item.method, item.transactionRef || null, item.receiptUrl || null, item.notes || null, item.status || 'pending', item.reviewedBy || null, item.reviewedAt || null, item.rejectionReason || null, item.createdAt || new Date().toISOString()]
          );
        }
      } else if (collection === 'queue') {
        if (action === 'insert' || action === 'update') {
          await postgres.query(
            `INSERT INTO queue (id, doctor_id, ticket_number, patient_name, status, position, estimated_wait_minutes, payload, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, position = EXCLUDED.position, estimated_wait_minutes = EXCLUDED.estimated_wait_minutes, payload = EXCLUDED.payload;`,
            [item.id, item.doctorId || null, item.ticketNumber || item.ticket || null, item.patientName || item.patient || null, item.status || 'WAITING', Number(item.position) || 1, Number(item.estimatedWaitMinutes) || 15, JSON.stringify(item), item.createdAt || new Date().toISOString()]
          );
        } else if (action === 'remove') {
          await postgres.query(`DELETE FROM queue WHERE id = $1;`, [item.id]);
        }
      } else if (collection === 'prescriptions') {
        if (action === 'insert' || action === 'update') {
          await postgres.query(
            `INSERT INTO prescriptions (id, appointment_id, patient_id, doctor_id, medications, notes, payload, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO UPDATE SET medications = EXCLUDED.medications, notes = EXCLUDED.notes, payload = EXCLUDED.payload;`,
            [item.id, item.appointmentId || null, item.patientId || null, item.doctorId || null, JSON.stringify(item.medications || []), item.notes || '', JSON.stringify(item), item.createdAt || new Date().toISOString()]
          );
        } else if (action === 'remove') {
          await postgres.query(`DELETE FROM prescriptions WHERE id = $1;`, [item.id]);
        }
      } else if (collection === 'patientHealthRecords') {
        if (action === 'insert' || action === 'update') {
          const recId = item.id || `ehr-${item.patientId}`;
          await postgres.query(
            `INSERT INTO patient_health_records (id, patient_id, blood_type, allergies, chronic_conditions, emergency_contact, payload, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (patient_id) DO UPDATE SET blood_type = EXCLUDED.blood_type, allergies = EXCLUDED.allergies, chronic_conditions = EXCLUDED.chronic_conditions, emergency_contact = EXCLUDED.emergency_contact, payload = EXCLUDED.payload;`,
            [recId, item.patientId, item.bloodType || null, typeof item.allergies === 'string' ? item.allergies : JSON.stringify(item.allergies || ''), typeof item.chronicConditions === 'string' ? item.chronicConditions : JSON.stringify(item.chronicConditions || ''), JSON.stringify(item.emergencyContact || null), JSON.stringify(item), item.createdAt || new Date().toISOString()]
          );
        } else if (action === 'remove') {
          await postgres.query(`DELETE FROM patient_health_records WHERE id = $1 OR patient_id = $2;`, [item.id || null, item.patientId || null]);
        }
      } else if (collection === 'medicalDocuments') {
        if (action === 'insert' || action === 'update') {
          await postgres.query(
            `INSERT INTO medical_documents (id, patient_id, doctor_id, title, document_type, file_url, file_name, payload, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, document_type = EXCLUDED.document_type, file_url = EXCLUDED.file_url, payload = EXCLUDED.payload;`,
            [item.id, item.patientId || null, item.doctorId || null, item.title || null, item.documentType || item.type || null, item.fileUrl || item.url || null, item.fileName || null, JSON.stringify(item), item.createdAt || new Date().toISOString()]
          );
        } else if (action === 'remove') {
          await postgres.query(`DELETE FROM medical_documents WHERE id = $1;`, [item.id]);
        }
      } else if (collection === 'dependents') {
        if (action === 'insert' || action === 'update') {
          await postgres.query(
            `INSERT INTO dependents (id, user_id, name, relationship, date_of_birth, payload, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, relationship = EXCLUDED.relationship, date_of_birth = EXCLUDED.date_of_birth, payload = EXCLUDED.payload;`,
            [item.id, item.userId || item.patientId || null, item.name || null, item.relationship || item.relation || null, item.dateOfBirth || item.dob || null, JSON.stringify(item), item.createdAt || new Date().toISOString()]
          );
        } else if (action === 'remove') {
          await postgres.query(`DELETE FROM dependents WHERE id = $1;`, [item.id]);
        }
      } else if (collection === 'claims') {
        if (action === 'insert' || action === 'update') {
          await postgres.query(
            `INSERT INTO claims (id, patient_id, doctor_id, appointment_id, amount, cnam_code, status, payload, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, amount = EXCLUDED.amount, payload = EXCLUDED.payload;`,
            [item.id, item.patientId || null, item.doctorId || null, item.appointmentId || null, String(item.amount || ''), item.cnamCode || null, item.status || 'PENDING', JSON.stringify(item), item.createdAt || new Date().toISOString()]
          );
        } else if (action === 'remove') {
          await postgres.query(`DELETE FROM claims WHERE id = $1;`, [item.id]);
        }
      } else if (collection === 'revokedTokens' && action === 'insert') {
        const tokId = item.id || `rev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        await postgres.query(
          `INSERT INTO revoked_tokens (id, token, expires_at, revoked_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO NOTHING;`,
          [tokId, item.token, item.expiresAt || null, item.revokedAt || new Date().toISOString()]
        );
      } else if (collection === 'notifications') {
        if (action === 'insert' || action === 'update') {
          await postgres.query(
            `INSERT INTO notifications (id, space, category, title, message, read, payload, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO UPDATE SET read = EXCLUDED.read, title = EXCLUDED.title, message = EXCLUDED.message, payload = EXCLUDED.payload;`,
            [item.id, item.space || 'admin', item.category || 'system', item.title || '', item.message || '', Boolean(item.read), JSON.stringify(item), item.createdAt || new Date().toISOString()]
          );
        } else if (action === 'remove') {
          await postgres.query(`DELETE FROM notifications WHERE id = $1;`, [item.id]);
        }
      } else if (collection === 'referralLetters') {
        if (action === 'insert' || action === 'update') {
          await postgres.query(
            `INSERT INTO referral_letters (id, from_doctor_id, to_doctor_id, patient_id, patient_name, status, payload, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, payload = EXCLUDED.payload;`,
            [item.id, item.fromDoctorId || null, item.toDoctorId || null, item.patientId || null, item.patientName || null, item.status || 'UNREAD', JSON.stringify(item), item.createdAt || new Date().toISOString()]
          );
        } else if (action === 'remove') {
          await postgres.query(`DELETE FROM referral_letters WHERE id = $1;`, [item.id]);
        }
      }
    } catch (err) {
      console.warn(`[PostgreSQL Sync Error] ${collection} ${action}:`, err.message);
    }
  }

  init() {
    const isProd = process.env.NODE_ENV === 'production';
    const allowDemoSeed = !isProd || process.env.ENABLE_DEMO_SEED === 'true';
    const existing = loadJson(DB_FILE);
    if (existing && existing.doctors && existing.users) {
      this.data = existing;
      if (allowDemoSeed) {
        const adminUser = this.data.users.find(u => u.email === 'admin@sahatn.tn');
        if (!adminUser) {
          const salt = bcrypt.genSaltSync(10);
          const defaultHash = bcrypt.hashSync(process.env.INITIAL_ADMIN_PASSWORD || 'Saha2026!', salt);
          this.data.users.unshift({
            uuid: 'usr-admin',
            email: 'admin@sahatn.tn',
            passwordHash: defaultHash,
            name: 'Super Administrateur',
            role: 'SUPER_ADMIN',
            createdAt: new Date().toISOString()
          });
          this.save();
        }
      }
      if (!Array.isArray(this.data.notifications) || (allowDemoSeed && this.data.notifications.length === 0)) {
        this.data.notifications = allowDemoSeed ? getSeedData().notifications : [];
        this.save();
      }
      if (!this.data.doctorSchedules || typeof this.data.doctorSchedules !== 'object') {
        this.data.doctorSchedules = allowDemoSeed ? { 'doc-1': getDefaultDoctorSchedule('doc-1') } : {};
        this.save();
      }
      if (!Array.isArray(this.data.referralLetters)) {
        this.data.referralLetters = [];
        this.save();
      }
      if (!Array.isArray(this.data.doctorSubscriptions)) {
        this.data.doctorSubscriptions = [];
        this.save();
      }
      if (!Array.isArray(this.data.offlinePayments)) {
        this.data.offlinePayments = [];
        this.save();
      }
    } else if (allowDemoSeed) {
      console.log('🔄 Initializing fresh database with seeds...');
      this.data = getSeedData();
      if (!this.data.doctorSchedules) {
        this.data.doctorSchedules = {
          'doc-1': getDefaultDoctorSchedule('doc-1')
        };
      }
      if (!Array.isArray(this.data.doctorSubscriptions)) this.data.doctorSubscriptions = [];
      if (!Array.isArray(this.data.offlinePayments)) this.data.offlinePayments = [];
      this.save();
    } else {
      console.log('🔒 Production mode: Initializing clean empty collections (demo seeds disabled).');
      this.data = {
        users: [],
        doctors: [],
        appointments: [],
        queue: [],
        prescriptions: [],
        claims: [],
        reviews: [],
        praticienRequests: [],
        patientHealthRecords: [],
        medicalDocuments: [],
        dependents: [],
        auditLogs: [],
        revokedTokens: [],
        notifications: [],
        doctorSchedules: {},
        referralLetters: [],
        doctorSubscriptions: [],
        offlinePayments: []
      };
      this.save();
    }
  }

  save(immediate = false) {
    if (immediate) {
      if (this._saveTimer) {
        clearTimeout(this._saveTimer);
        this._saveTimer = null;
      }
      this._flush();
      return;
    }
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._flushAsync();
    }, 1000);
  }

  async _flushAsync() {
    if (this._isSaving) {
      this._pendingSave = true;
      return;
    }
    this._isSaving = true;
    try {
      const dir = path.dirname(DB_FILE);
      if (!fs.existsSync(dir)) await fs.promises.mkdir(dir, { recursive: true });
      const payload = JSON.stringify(this.data);
      const tmpFile = `${DB_FILE}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmpFile, payload, 'utf8');
      await fs.promises.rename(tmpFile, DB_FILE);
    } catch (err) {
      console.error('[DB] Failed to persist data async:', err.message);
    } finally {
      this._isSaving = false;
      if (this._pendingSave) {
        this._pendingSave = false;
        this.save();
      }
    }
  }

  _flush() {
    try {
      const dir = path.dirname(DB_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpFile = `${DB_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmpFile, DB_FILE);
    } catch (err) {
      console.error('[DB] Failed to persist data:', err.message);
    }
  }

  get(collection) {
    return this.data[collection] !== undefined ? this.data[collection] : [];
  }

  set(collection, items) {
    this.data[collection] = items;
    this.save();
    if (collection === 'doctorSchedules' && items && typeof items === 'object' && postgres.isPostgresConnected()) {
      const entries = Object.entries(items);
      if (entries.length > 0) {
        const nowIso = new Date().toISOString();
        const docIds = entries.map(([docId]) => docId);
        const schedulesJson = entries.map(([, sched]) => JSON.stringify(sched));
        const updatedAts = entries.map(([, sched]) => sched?.updatedAt || nowIso);
        // Single batched UNNEST upsert instead of N separate queries
        postgres.query(
          `INSERT INTO doctor_schedules (doctor_id, schedule, updated_at)
           SELECT * FROM UNNEST($1::text[], $2::jsonb[], $3::timestamptz[])
           ON CONFLICT (doctor_id) DO UPDATE SET schedule = EXCLUDED.schedule, updated_at = EXCLUDED.updated_at;`,
          [docIds, schedulesJson, updatedAts]
        ).catch(err => console.warn('[PostgreSQL Sync Error] doctorSchedules batch:', err.message));
      }
    }
  }

  findOne(collection, predicate) {
    return (this.data[collection] || []).find(predicate);
  }

  filter(collection, predicate) {
    return (this.data[collection] || []).filter(predicate);
  }

  insert(collection, item) {
    if (!this.data[collection]) this.data[collection] = [];
    this.data[collection].unshift(item);
    // Keep up to 5000 audit entries in memory cache (PostgreSQL retains full immutable INPDP ledger)
    if (collection === 'auditLogs' && this.data[collection].length > 5000) {
      this.data[collection] = this.data[collection].slice(0, 5000);
    }
    this.save();
    this.syncToPostgres(collection, 'insert', item);
    return item;
  }

  update(collection, predicate, updates) {
    const items = this.data[collection] || [];
    const index = items.findIndex(predicate);
    if (index !== -1) {
      this.data[collection][index] = { ...this.data[collection][index], ...updates };
      this.save();
      this.syncToPostgres(collection, 'update', this.data[collection][index]);
      return this.data[collection][index];
    }
    return null;
  }

  remove(collection, predicate) {
    const items = this.data[collection] || [];
    const before = items.length;
    const removedItem = items.find(predicate);
    this.data[collection] = items.filter(x => !predicate(x));
    const removed = before !== this.data[collection].length;
    if (removed) {
      this.save();
      if (removedItem) this.syncToPostgres(collection, 'remove', removedItem);
    }
    return removed;
  }

  getDoctorSchedule(doctorId = 'doc-1') {
    if (!this.data.doctorSchedules || typeof this.data.doctorSchedules !== 'object') {
      this.data.doctorSchedules = { 'doc-1': getDefaultDoctorSchedule('doc-1') };
    }
    if (this.data.doctorSchedules[doctorId]) {
      return this.data.doctorSchedules[doctorId];
    }
    // If doc-1 default exists, return it tailored for requested doctorId
    if (this.data.doctorSchedules['doc-1']) {
      return { ...this.data.doctorSchedules['doc-1'], doctorId };
    }
    return getDefaultDoctorSchedule(doctorId);
  }

  saveDoctorSchedule(doctorId = 'doc-1', scheduleData = {}) {
    if (!this.data.doctorSchedules || typeof this.data.doctorSchedules !== 'object') {
      this.data.doctorSchedules = {};
    }
    const current = this.getDoctorSchedule(doctorId);
    const updated = {
      ...current,
      ...scheduleData,
      doctorId,
      days: {
        ...(current.days || {}),
        ...(scheduleData.days || {})
      },
      leave: scheduleData.leave !== undefined ? {
        ...(scheduleData.leave.start !== undefined ? {} : (current.leave || {})),
        ...scheduleData.leave
      } : (current.leave || { start: '', end: '', reason: '' }),
      leaves: Array.isArray(scheduleData.leaves) ? scheduleData.leaves : (current.leaves || []),
      modes: {
        ...(current.modes || {}),
        ...(scheduleData.modes || {})
      },
      updatedAt: new Date().toISOString()
    };
    this.data.doctorSchedules[doctorId] = updated;
    this.save();
    if (postgres.isPostgresConnected()) {
      postgres.query(
        `INSERT INTO doctor_schedules (doctor_id, schedule, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (doctor_id) DO UPDATE SET schedule = EXCLUDED.schedule, updated_at = EXCLUDED.updated_at;`,
        [doctorId, JSON.stringify(updated), updated.updatedAt]
      ).catch(err => console.warn('[PostgreSQL Sync Error] saveDoctorSchedule:', err.message));
    }
    return updated;
  }
}

const db = new Database();
module.exports = db;
