const express = require('express');
const db = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { auditTrail } = require('../middleware/security.middleware');
const { validateBody } = require('../middleware/validate.middleware');
const { encryptMedicalField, decryptMedicalField } = require('../utils/crypto.security');

const router = express.Router();

// Helper: Resolve target patientId with strict IDOR enforcement
function resolveAuthorizedPatientId(req, requestedId) {
  const role = req.user?.role;
  const isStaff = role === 'DOCTOR' || role === 'PRATICIEN' || role === 'ADMIN' || role === 'SUPER_ADMIN';
  if (requestedId && requestedId !== req.user.uuid && !isStaff) {
    return { denied: true };
  }
  return { denied: false, patientId: (isStaff && requestedId) ? requestedId : req.user.uuid };
}

// GET /api/patient/profile - Get full patient health record, lab docs, and dependents (INPDP Audited)
router.get('/profile', verifyToken, auditTrail('EHR_READ', req => ({ resource: 'PATIENT_EHR', resourceId: req.query?.patientId || req.user?.uuid })), (req, res) => {
  const access = resolveAuthorizedPatientId(req, req.query.patientId);
  if (access.denied) {
    return res.status(403).json({
      success: false,
      error: 'IDOR_ACCESS_DENIED',
      message: 'Accès non autorisé: Vous ne pouvez consulter que votre propre dossier médical.'
    });
  }

  const patientId = access.patientId;
  const targetUser = db.findOne('users', u => u.uuid === patientId) || req.user;
  const patientPhone = targetUser?.phone || null;
  const patientName = targetUser?.name || null;
  const cleanPhone = patientPhone ? patientPhone.replace(/[\s+]/g, '') : '';
  const cleanName = patientName ? patientName.toLowerCase().trim() : '';

  const existingRecord = db.findOne('patientHealthRecords', r => r.patientId === patientId);

  const emptyDossier = {
    patientId,
    bloodType: '',
    allergies: [],
    chronicDiseases: [],
    height: null,
    weight: null,
    emergencyContact: { name: '', relation: '', phone: '' },
    vaccines: []
  };

  const rawHealthRecord = existingRecord ? {
    ...emptyDossier,
    ...existingRecord,
    bloodType: existingRecord.bloodType || '',
    height: existingRecord.height ? Number(existingRecord.height) : null,
    weight: existingRecord.weight ? Number(existingRecord.weight) : null,
    allergies: existingRecord.allergies || [],
    chronicDiseases: existingRecord.chronicDiseases || [],
    emergencyContact: existingRecord.emergencyContact || emptyDossier.emergencyContact,
    vaccines: Array.isArray(existingRecord.vaccines) ? existingRecord.vaccines : []
  } : emptyDossier;

  // Decrypt confidential medical fields in memory for authorized access
  const healthRecord = {
    ...rawHealthRecord,
    allergies: decryptMedicalField(rawHealthRecord.allergies),
    chronicDiseases: decryptMedicalField(rawHealthRecord.chronicDiseases),
    encryptedAtRest: typeof rawHealthRecord.allergies === 'string' && rawHealthRecord.allergies.startsWith('$AES256GCM$')
  };

  const documents = db.filter('medicalDocuments', d => d.patientId === patientId);
  const dependents = db.filter('dependents', d => d.patientId === patientId);

  const appointments = db.filter('appointments', a => {
    if (a.patientId && a.patientId === patientId) return true;
    if (cleanPhone && a.patientPhone && a.patientPhone.replace(/[\s+]/g, '').includes(cleanPhone)) return true;
    if (cleanName && a.patientName && a.patientName.toLowerCase() === cleanName) return true;
    return false;
  });
  const prescriptions = db.filter('prescriptions', p => p.patientId && p.patientId === patientId);

  const rawAppointments = appointments;

  // Auto-detect and handle expired appointments (past dates)
  const now = new Date();
  const todayIso = now.toISOString().split('T')[0];
  const resolvedAppointments = rawAppointments.map(a => {
    let dateIso = a.dateIso;
    if (!dateIso && a.date) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(a.date)) {
        dateIso = a.date;
      } else {
        const match = String(a.date).match(/(\d{1,2})\s+([a-zéû.]+)/i);
        if (match) {
          const latinMonths = { 'janv': '01', 'févr': '02', 'fevr': '02', 'mars': '03', 'avr': '04', 'mai': '05', 'juin': '06', 'juil': '07', 'août': '08', 'aout': '08', 'sept': '09', 'oct': '10', 'nov': '11', 'déc': '12', 'dec': '12' };
          const dNum = String(parseInt(match[1], 10)).padStart(2, '0');
          const mStr = match[2].toLowerCase().replace('.', '');
          for (const [k, mNum] of Object.entries(latinMonths)) {
            if (mStr.startsWith(k)) {
              dateIso = `${now.getFullYear()}-${mNum}-${dNum}`;
              break;
            }
          }
        }
      }
    }

    let isPast = false;
    if (dateIso && dateIso < todayIso) {
      isPast = true;
    } else if (dateIso === todayIso && a.time) {
      const [h, m] = a.time.split(/[:h]/).map(Number);
      const aptTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h || 0, m || 0);
      if (aptTime < now) isPast = true;
    }

    if (isPast && (a.status === 'CONFIRMED' || a.status === 'APPROVED' || a.status === 'EN_ATTENTE')) {
      return { ...a, dateIso: dateIso || a.dateIso, status: 'COMPLETED', isExpired: true };
    }
    return { ...a, dateIso: dateIso || a.dateIso, isExpired: isPast };
  });

  const resolvedPrescriptions = prescriptions;
  const resolvedDependents = dependents;

  res.json({
    success: true,
    data: {
      healthRecord,
      documents,
      dependents: resolvedDependents,
      appointments: resolvedAppointments,
      prescriptions: resolvedPrescriptions
    }
  });
});

// PUT /api/patient/health-record - Update health record with AES-256-GCM Encryption (INPDP Audited)
router.put('/health-record', verifyToken, auditTrail('EHR_UPDATE', req => ({ resource: 'PATIENT_EHR', resourceId: req.body?.patientId || req.user?.uuid })), (req, res) => {
  const access = resolveAuthorizedPatientId(req, req.body.patientId);
  if (access.denied) {
    return res.status(403).json({
      success: false,
      error: 'IDOR_ACCESS_DENIED',
      message: 'Accès non autorisé: Vous ne pouvez modifier que votre propre dossier médical.'
    });
  }

  const patientId = access.patientId;
  const { bloodType, allergies, chronicDiseases, height, weight, emergencyContact } = req.body;

  // Encrypt confidential health vectors before persisting
  const encryptedAllergies = allergies ? encryptMedicalField(allergies) : undefined;
  const encryptedDiseases = chronicDiseases ? encryptMedicalField(chronicDiseases) : undefined;

  let record = db.findOne('patientHealthRecords', r => r.patientId === patientId);
  if (record) {
    record = db.update('patientHealthRecords', r => r.patientId === patientId, {
      bloodType: bloodType || record.bloodType,
      allergies: encryptedAllergies !== undefined ? encryptedAllergies : record.allergies,
      chronicDiseases: encryptedDiseases !== undefined ? encryptedDiseases : record.chronicDiseases,
      height: height || record.height,
      weight: weight || record.weight,
      emergencyContact: emergencyContact || record.emergencyContact,
      updatedAt: new Date().toISOString()
    });
  } else {
    record = {
      id: `ehr-${Date.now()}`,
      patientId,
      bloodType: bloodType || 'O+',
      allergies: encryptedAllergies !== undefined ? encryptedAllergies : encryptMedicalField([]),
      chronicDiseases: encryptedDiseases !== undefined ? encryptedDiseases : encryptMedicalField([]),
      height: height || 170,
      weight: weight || 70,
      emergencyContact: emergencyContact || {},
      vaccines: [],
      updatedAt: new Date().toISOString()
    };
    db.insert('patientHealthRecords', record);
  }

  // Return clean decrypted object to client
  const decryptedRecord = {
    ...record,
    allergies: decryptMedicalField(record.allergies),
    chronicDiseases: decryptMedicalField(record.chronicDiseases),
    encryptionStandard: 'AES-256-GCM'
  };

  res.json({
    success: true,
    message: 'Carnet de santé numérique sécurisé (chiffré AES-256-GCM) et mis à jour !',
    data: decryptedRecord
  });
});


// POST /api/patient/documents - Add medical document / lab analysis (INPDP Audited)
router.post('/documents', verifyToken, auditTrail('DOCUMENT_UPLOAD', req => ({ resource: 'MEDICAL_DOCUMENT', resourceId: req.body?.title || 'lab_doc' })), (req, res) => {
  const access = resolveAuthorizedPatientId(req, req.body.patientId);
  if (access.denied) {
    return res.status(403).json({ success: false, error: 'IDOR_ACCESS_DENIED', message: 'Accès non autorisé.' });
  }
  const patientId = access.patientId;
  const { title, category = 'BIOLOGIE', doctorName = 'Laboratoire Central', date, notes = '', fileUrl = '' } = req.body;

  if (!title) {
    return res.status(400).json({ success: false, message: 'Le titre du document est requis.' });
  }

  const newDoc = {
    id: `doc-${Date.now()}`,
    patientId,
    title,
    category, // BIOLOGIE, RADIOLOGIE, COMPTE_RENDU, ORDONNANCE
    doctorName,
    date: date || new Date().toISOString().split('T')[0],
    notes,
    fileUrl: fileUrl || 'bilan_medical_sample.pdf',
    createdAt: new Date().toISOString()
  };

  db.insert('medicalDocuments', newDoc);

  res.status(201).json({
    success: true,
    message: 'Document médical ajouté avec succès au dossier !',
    data: newDoc
  });
});

// POST /api/patient/dependents - Add dependent (family member)
router.post('/dependents', verifyToken, (req, res) => {
  const access = resolveAuthorizedPatientId(req, req.body.patientId);
  if (access.denied) {
    return res.status(403).json({ success: false, error: 'IDOR_ACCESS_DENIED', message: 'Accès non autorisé.' });
  }
  const patientId = access.patientId;
  const { name, relation, birthDate, gender, bloodType } = req.body;

  if (!name || !relation) {
    return res.status(400).json({ success: false, message: 'Le nom et le lien de parenté sont requis.' });
  }

  const newDep = {
    id: `dep-${Date.now()}`,
    patientId,
    name,
    relation, // ENFANT, PARENT, CONJOINT
    birthDate: birthDate || '2016-05-10',
    gender: gender || 'M',
    bloodType: bloodType || 'O+',
    createdAt: new Date().toISOString()
  };

  db.insert('dependents', newDep);

  res.status(201).json({
    success: true,
    message: `Proche "${name}" ajouté avec succès !`,
    data: newDep
  });
});

// POST /api/patient/payment - Server-verified payment processing (requires auth + server-side fee calculation)
router.post(
  '/payment',
  verifyToken,
  validateBody({
    method: { type: 'string', enum: ['FLOUCI', 'KONNECT', 'EDINAR', 'E-DINAR', 'CARD'] },
    appointmentId: { type: 'string', maxLen: 120 }
  }),
  auditTrail('PAYMENT_PROCESSED', req => ({ resource: 'FINANCIAL_TRANSACTION', resourceId: req.body?.appointmentId || req.body?.method || 'PAYMENT' })),
  (req, res) => {
    const { appointmentId, method = 'FLOUCI', gatewayPaymentRef } = req.body;

    // Never allow unverified simulated payments in production without a verified gateway reference
    if (process.env.NODE_ENV === 'production' && !gatewayPaymentRef) {
      return res.status(501).json({
        success: false,
        error: 'PAYMENT_GATEWAY_VERIFICATION_REQUIRED',
        message: 'Le paiement simulé est désactivé en production. Veuillez utiliser une passerelle de paiement vérifiée (Konnect / Flouci).'
      });
    }

    // Authoritative server-side price lookup (NEVER trust req.body.amount)
    let authoritativeFee = '70 TND';
    let targetApt = null;
    if (appointmentId) {
      targetApt = db.findOne('appointments', a => a.id === appointmentId);
      if (!targetApt) {
        return res.status(404).json({ success: false, message: 'Rendez-vous introuvable.' });
      }
      const access = resolveAuthorizedPatientId(req, targetApt.patientId);
      if (access.denied) {
        return res.status(403).json({ success: false, error: 'IDOR_ACCESS_DENIED', message: 'Accès non autorisé à ce rendez-vous.' });
      }
      const doc = db.findOne('doctors', d => d.id === targetApt.doctorId || d.uuid === targetApt.doctorId);
      const rawFee = doc?.fee ?? targetApt.fee ?? 70;
      const numericFee = parseInt(String(rawFee).replace(/\D/g, ''), 10) || 70;
      authoritativeFee = `${numericFee} TND`;
    }

    const txId = `${String(method).toUpperCase()}-TN-${Math.floor(100000 + Math.random() * 900000)}`;

    const paymentRecord = {
      transactionId: txId,
      appointmentId: appointmentId || null,
      amount: authoritativeFee,
      method: String(method).toUpperCase(),
      status: 'PAID',
      patientId: req.user.uuid,
      patientName: req.user.name || 'Patient',
      timestamp: new Date().toISOString(),
      fiscalStamp: '1.000 TND',
      priceVerifiedByServer: true
    };

    if (targetApt) {
      db.update('appointments', a => a.id === targetApt.id, {
        paymentStatus: 'PAID',
        paymentTx: txId,
        paymentMethod: String(method).toUpperCase(),
        fee: authoritativeFee
      });
    }

    res.json({
      success: true,
      message: `Paiement ${method} validé avec succès (${authoritativeFee}) !`,
      data: paymentRecord
    });
  }
);

module.exports = router;
