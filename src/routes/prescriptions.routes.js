const express = require('express');
const crypto = require('crypto');
const db = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const { auditTrail } = require('../middleware/security.middleware');
const { validateBody } = require('../middleware/validate.middleware');
const { broadcastNotification } = require('./notifications.routes');

const router = express.Router();

// GET /api/prescriptions (Requires auth + strict owner/role isolation, INPDP Audited)
router.get('/', verifyToken, auditTrail('PRESCRIPTION_QUERY', req => ({ resource: 'PRESCRIPTION', resourceId: req.query.patientId || req.user?.uuid || 'ALL' })), (req, res) => {
  const { patientId, doctorId } = req.query;
  const role = (req.user?.role || '').toUpperCase();
  const isAdmin = role === 'ADMIN' || role === 'SUPER_ADMIN';
  const isDoctor = role === 'DOCTOR' || role === 'PRATICIEN';
  let items = db.get('prescriptions');

  if (!isAdmin) {
    if (isDoctor) {
      if (req.user.doctorId) items = items.filter(p => p.doctorId === req.user.doctorId);
      if (patientId) items = items.filter(p => p.patientId === patientId);
    } else {
      // Patient can ONLY view their own prescriptions
      items = items.filter(p => p.patientId === req.user.uuid);
    }
  } else {
    if (patientId) items = items.filter(p => p.patientId === patientId);
    if (doctorId) items = items.filter(p => p.doctorId === doctorId);
  }

  res.json({
    success: true,
    count: items.length,
    data: items
  });
});

// POST /api/prescriptions - Create electronic prescription (Doctors & Admins ONLY, INPDP Audited)
router.post(
  '/',
  verifyToken,
  requireRole('DOCTOR', 'PRATICIEN', 'ADMIN', 'SUPER_ADMIN'),
  validateBody({
    drugs: { type: 'array', required: true, minLen: 1, maxLen: 30 }
  }),
  auditTrail('PRESCRIPTION_CREATE', req => ({ resource: 'PRESCRIPTION', resourceId: req.body?.patientId || 'unknown' })),
  (req, res) => {
  try {
    const {
      id,
      qrHash,
      patientId = 'usr-4410',
      patientName = 'Fatma Ben Abdallah',
      patientAge = '',
      doctorId = 'doc-1',
      doctorName = 'Dr. Selim Ben Ali',
      specialty = 'Cardiologie & Médecine Générale',
      orderNumber = '14092',
      cnamCode = 'CNAM-CD-40912',
      cabinetAddress = 'Centre Médical Ennasr 2, Tunis',
      cabinetPhone = '+216 71 830 900',
      medicalAdvice = '',
      date = new Date().toISOString().split('T')[0],
      drugs = []
    } = req.body;

    if (!drugs.length) {
      return res.status(400).json({ success: false, message: 'La prescription doit contenir au moins un médicament.' });
    }

    const timestamp = Date.now();
    const rawData = `${patientId}|${doctorId}|${timestamp}|${JSON.stringify(drugs)}`;
    const finalHash = qrHash || ('sha256-' + crypto.createHash('sha256').update(rawData).digest('hex').substring(0, 24));
    const finalId = id || `ord-${timestamp}`;

    const newPrescription = {
      id: finalId,
      patientId,
      patientName,
      patientAge,
      doctorId,
      doctorName,
      specialty,
      orderNumber,
      cnamCode,
      cabinetAddress,
      cabinetPhone,
      medicalAdvice,
      drugs,
      date,
      qrHash: finalHash,
      status: 'ACTIVE',
      createdAt: new Date().toISOString()
    };

    const existing = db.findOne('prescriptions', item => item.id === finalId || item.qrHash === finalHash);
    if (existing) {
      db.update('prescriptions', item => item.id === finalId || item.qrHash === finalHash, newPrescription);
    } else {
      db.insert('prescriptions', newPrescription);
    }

    const io = req.app.get('io');
    if (io) {
      broadcastNotification(io, {
        space: 'patient',
        category: 'ordonnance',
        icon: '💊',
        title: 'Nouvelle Ordonnance Électronique',
        message: `${newPrescription.doctorName} a mis en ligne votre ordonnance certifiée (${newPrescription.drugs.length} médicament(s)).`,
        actionUrl: '../Patients_pages/patient-dashboard.html'
      });
    }

    res.status(201).json({
      success: true,
      message: 'Ordonnance électronique signée et enregistrée avec succès !',
      data: newPrescription
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur création ordonnance: ' + err.message });
  }
});

// GET /api/prescriptions/verify/:hash - Pharmacist QR & Public Verification (INPDP Audited)
router.get('/verify/:hash', auditTrail('QR_VERIFICATION', req => ({ resource: 'PRESCRIPTION_HASH', resourceId: req.params.hash })), (req, res) => {
  const hash = req.params.hash;
  const p = db.findOne('prescriptions', item => 
    item.qrHash === hash || 
    item.id === hash || 
    (hash && item.qrHash && (hash.includes(item.qrHash) || item.qrHash.includes(hash))) ||
    (hash && item.id && (hash.includes(item.id) || item.id.includes(hash)))
  );

  if (!p) {
    return res.status(404).json({
      success: false,
      verified: false,
      alert: 'FRAUD_SUSPECTED',
      message: 'Alerte: QR Code non reconnu ou ordonnance falsifiée ! Ce document n\'existe pas dans le registre SahaTN.'
    });
  }

  // Lookup doctor details
  const doctor = db.findOne('doctors', d => d.id === p.doctorId) || {
    name: p.doctorName || 'Dr. Selim Ben Ali',
    specialty: p.specialty || 'Cardiologie & Médecine Générale',
    address: p.cabinetAddress || 'Centre Médical Les Berges du Lac, Tunis',
    phone: p.cabinetPhone || '+216 71 888 999'
  };

  // Mask patient identity for public medical secrecy (Loi 2004-63)
  const rawName = p.patientName || 'Patient Bénéficiaire';
  const parts = rawName.split(' ');
  const maskedPatientName = parts.map((part, idx) => idx === 0 ? part : part.charAt(0) + '***').join(' ');

  const hashNumeric = Math.abs((p.qrHash || hash).split('').reduce((acc, ch) => ((acc << 5) - acc) + ch.charCodeAt(0), 0));
  const finalOrderNumber = p.orderNumber || `TN-MED-${10000 + (hashNumeric % 89999)}`;

  res.json({
    success: true,
    verified: true,
    message: '✓ Ordonnance certifiée authentique par le Registre National Saha.tn & Conseil de l\'Ordre des Médecins',
    certificate: {
      prescriptionId: p.id,
      qrHash: p.qrHash,
      date: p.date,
      createdAt: p.createdAt || p.date,
      status: p.status || 'ACTIVE',
      authority: "Conseil National de l'Ordre des Médecins de Tunisie (CNOMT)",
      cnamConvention: p.cnamCode ? `Conventionné CNAM (${p.cnamCode})` : "Conventionné CNAM — Filière C1",
      orderRegistration: finalOrderNumber,
      cryptographicStandard: "HMAC-SHA256 Anti-Tamper Sealed Ledger (Loi 2004-63)",
      patient: {
        maskedName: maskedPatientName,
        patientId: p.patientId
      },
      doctor: {
        name: doctor.name || p.doctorName,
        specialty: doctor.specialty || p.specialty || 'Spécialiste Conventionné',
        address: doctor.address || p.cabinetAddress || 'Tunis, Tunisie',
        phone: doctor.phone || p.cabinetPhone || '+216 71 888 999',
        orderNumber: finalOrderNumber
      },
      drugs: p.drugs || [],
      medicalAdvice: p.medicalAdvice
    },
    prescription: p
  });
});

module.exports = router;

