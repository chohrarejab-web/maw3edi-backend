const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../config/database');
const { recordAuditLog } = require('../middleware/security.middleware');
const { broadcastNotification } = require('./notifications.routes');
const EmailService = require('../services/email.service');
const { generateToken, verifyToken, requireRole } = require('../middleware/auth');
const { fuzzyMatch, matchDoctor } = require('../utils/fuzzySearch');
const { persistDataUri } = require('../utils/fileStorage');

function safePersistAsset(value, category) {
  if (!value || typeof value !== 'string') return value || null;
  if (!value.startsWith('data:')) return value;
  return persistDataUri(value, category);
}

const router = express.Router();

// Multilingual Symptom Taxonomy Mapping (Tunisian Derja + French)
const SYMPTOM_MAP = {
  '9alb': 'cardio',
  'wji3a fel 9alb': 'cardio',
  'cardiaque': 'cardio',
  'coeur': 'cardio',
  'tension': 'cardio',
  's5ana': 'pediatrie',
  'bebe': 'pediatrie',
  'sghir': 'pediatrie',
  'dharsa': 'dentiste',
  'senik': 'dentiste',
  'dents': 'dentiste',
  'dent': 'dentiste',
  'rasyouja3': 'generaliste',
  'raski': 'generaliste',
  'ras': 'generaliste',
  'grippe': 'generaliste',
  '7bela': 'gyneco',
  'grossesse': 'gyneco',
  'wleda': 'gyneco',
  '3iniya': 'ophtalmo',
  'yeux': 'ophtalmo',
  'chouf': 'ophtalmo',
  '7abb': 'dermato',
  'jeldia': 'dermato',
  'peau': 'dermato'
};

function resolveSpecialtyFromQuery(keyword = '') {
  const norm = keyword.toLowerCase().trim();
  for (const [trigger, specCode] of Object.entries(SYMPTOM_MAP)) {
    if (norm.includes(trigger)) return specCode;
  }
  return null;
}

// GET /api/doctors - Fetch doctors with advanced search & filters
router.get('/', (req, res) => {
  try {
    const { specialty, city, keyword, cnam, telehealth, includeUnfinalized } = req.query;
    let doctors = db.get('doctors');

    // Public directory & search bar: Exclude unfinalized / unactivated practitioner accounts
    if (includeUnfinalized !== 'true') {
      doctors = doctors.filter(doc => {
        // If explicitly flagged as unfinalized or inactive, exclude from public results
        if (doc.accountFinalized === false || doc.active === false) {
          return false;
        }

        // If doctor has an associated unfinalized registration request in praticienRequests, exclude
        const normEmail = (doc.email || '').toLowerCase().trim();
        const linkedReq = db.findOne('praticienRequests', r => 
          (r.doctorId && (r.doctorId === doc.id || r.doctorId === doc.uuid)) ||
          (normEmail && r.email && r.email.toLowerCase().trim() === normEmail)
        );

        if (linkedReq && linkedReq.accountFinalized !== true) {
          return false;
        }

        return true;
      });
    }

    // Detect symptom intent in keyword if specialty not directly specified
    const inferredSpec = (!specialty || specialty === 'all') ? resolveSpecialtyFromQuery(keyword) : null;
    const targetSpec = (specialty && specialty !== 'all') ? specialty.toLowerCase() : inferredSpec;

    if (targetSpec) {
      doctors = doctors.filter(doc => {
        const specFields = `${doc.specialtyId || ''} ${doc.specialtyFr || ''} ${doc.specialty || ''} ${doc.specialtyCode || ''}`;
        return fuzzyMatch(targetSpec, specFields);
      });
    }

    if (city && city !== 'all') {
      doctors = doctors.filter(doc => {
        const cityFields = `${doc.city || ''} ${doc.delegation || ''} ${doc.address || ''}`;
        return fuzzyMatch(city, cityFields);
      });
    }

    if (cnam === 'true' || cnam === true) {
      doctors = doctors.filter(doc => doc.cnam === true || doc.conventionneCNAM === true);
    }

    if (telehealth === 'true' || telehealth === true) {
      doctors = doctors.filter(doc => doc.telehealth === true || doc.teleconsultation === true);
    }

    if (keyword && !inferredSpec) {
      doctors = doctors.filter(doc => matchDoctor(doc, keyword));
    }

    res.json({
      success: true,
      count: doctors.length,
      inferredSpecialty: inferredSpec,
      data: doctors
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur recherche médecins: ' + err.message });
  }
});

// GET /api/doctors/request-status - Check if doctor registration request is APPROVED, PENDING, or REJECTED
router.get(['/request-status', '/request/:id/status'], (req, res) => {
  try {
    const reqId = req.params.id || req.query.id || req.query.requestId;
    const email = (req.query.email || '').toLowerCase().trim();
    const token = req.query.token;

    let reqItem = null;
    if (reqId) {
      reqItem = db.findOne('praticienRequests', r => r.id === reqId || r.uuid === reqId);
    }
    if (!reqItem && email) {
      reqItem = db.findOne('praticienRequests', r => r.email && r.email.toLowerCase().trim() === email);
    }

    if (!reqItem) {
      const doctor = db.findOne('doctors', d => (email && d.email === email) || (reqId && (d.id === reqId || d.uuid === reqId)));
      if (doctor) {
        const isDocFinalized = Boolean(doctor.accountFinalized);
        return res.json({
          success: true,
          status: isDocFinalized ? 'ALREADY_FINALIZED' : 'APPROVED',
          name: doctor.name,
          email: doctor.email,
          spec: doctor.specialtyFr || doctor.spec || '',
          city: doctor.city || 'Tunis',
          accountFinalized: isDocFinalized,
          isAlreadyFinalized: isDocFinalized,
          message: isDocFinalized
            ? "Ce compte praticien a déjà été finalisé et activé. Ce lien à usage unique n'est plus actif."
            : "Accès autorisé."
        });
      }
      return res.json({
        success: true,
        status: 'APPROVED',
        message: 'Accès autorisé.'
      });
    }

    const isAlreadyFinalized = Boolean(reqItem.accountFinalized);
    const isApproved = reqItem.status === 'APPROVED';
    const isPending = reqItem.status === 'PENDING' || !reqItem.status;
    const isPendingDocs = reqItem.status === 'PENDING_DOCUMENTS';
    const isRejected = reqItem.status === 'REJECTED';
    const isReactivationRequested = reqItem.status === 'REACTIVATION_REQUESTED' || Boolean(reqItem.reactivationRequested);

    let isOnboardingExpired = Boolean(reqItem.onboardingExpired);
    let sessionStartTime = reqItem.sessionStartTime || reqItem.sessionStartedAt || null;

    if (!sessionStartTime && isApproved && !isAlreadyFinalized) {
      sessionStartTime = new Date().toISOString();
      db.update('praticienRequests', r => (r.id === reqItem.id || r.uuid === reqItem.id), {
        sessionStartTime: sessionStartTime,
        sessionStartedAt: sessionStartTime
      });
    }

    if (!isOnboardingExpired && sessionStartTime && !isAlreadyFinalized) {
      const elapsedMs = Date.now() - new Date(sessionStartTime).getTime();
      if (elapsedMs >= 15 * 60 * 1000) {
        isOnboardingExpired = true;
        db.update('praticienRequests', r => (r.id === reqItem.id || r.uuid === reqItem.id), {
          onboardingExpired: true,
          expiredAt: new Date().toISOString()
        });
      }
    }

    return res.json({
      success: true,
      id: reqItem.id || reqItem.uuid,
      name: reqItem.name,
      email: reqItem.email,
      spec: reqItem.spec || '',
      city: reqItem.city || '',
      status: isAlreadyFinalized ? 'ALREADY_FINALIZED' : (reqItem.status || 'PENDING'),
      isAlreadyFinalized,
      isApproved,
      isPending,
      isPendingDocs,
      isRejected,
      isReactivationRequested,
      onboardingExpired: isOnboardingExpired,
      isExpired: isOnboardingExpired,
      sessionStartTime: sessionStartTime,
      missingDocuments: reqItem.missingDocuments || [],
      rejectionReason: reqItem.rejectionReason || '',
      accountFinalized: isAlreadyFinalized,
      message: isAlreadyFinalized
        ? "Ce compte praticien a déjà été finalisé et activé. Ce lien d'activation à usage unique n'est plus actif."
        : isPending
        ? "Votre demande d'inscription est actuellement en cours d'examen par l'administration. Dès validation, vous recevrez un email contenant votre lien d'activation."
        : isPendingDocs
        ? "Votre dossier est suspendu en attente de pièces justificatives complémentaires."
        : isRejected
        ? "Votre demande n'a pas été retenue par l'administration."
        : "Votre dossier a été validé ! Vous pouvez maintenant finaliser l'activation de votre compte."
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// REFERRAL LETTERS & MEDICAL LIAISON (ÉCHANGE MÉDICAL CONFRÈRES)
// ══════════════════════════════════════════════════════════════════════════

function ensureInitialReferralLetters(doctorId = 'doc-1') {
  if (!Array.isArray(db.data.referralLetters)) {
    db.data.referralLetters = [];
  }

  const existingForDoc = db.data.referralLetters.filter(
    l => l.recipientDoctorId === doctorId || l.senderDoctorId === doctorId
  );

  if (existingForDoc.length === 0 && (doctorId === 'doc-1' || !doctorId)) {
    const now = Date.now();
    const seedLetters = [
      {
        id: 'ref-seed-1',
        senderDoctorId: 'doc-khemir',
        senderDoctorName: 'Dr. Moncef Khemir',
        senderDoctorSpecialty: 'Chirurgie Cardiovasculaire & Thoracique',
        senderDoctorCity: 'Tunis',
        senderDoctorDelegation: 'Les Berges du Lac 2',
        senderDoctorAvatar: '/images/doctor-m.png',
        senderDoctorPhone: '+216 71 860 220',
        recipientDoctorId: 'doc-1',
        recipientDoctorName: 'Dr. Selim Ben Ali',
        recipientDoctorSpecialty: 'Cardiologie & Maladies Vasculaires',
        recipientDoctorCity: 'Tunis',
        patientName: 'Sami Mansour',
        patientAge: '48 ans',
        patientPhone: '+216 22 456 789',
        priority: 'URGENT',
        motif: "Cher Confrère,\n\nJe vous adresse en consultation spécialisée M. Sami Mansour (48 ans), présentant des épisodes récents d'angor d'effort atypique avec dyspnée stade II NYHA.\nL'électrocardiogramme de repos objective un discret sous-décalage du segment ST en antéro-latéral (V4-V6) sans nécrose constituée.\n\nJe sollicite votre avis confraternel pour la réalisation d'une échocardiographie d'effort / coronarographie diagnostique et la prise en charge thérapeutique optimale.\n\nBien confraternellement,\nDr. Moncef Khemir\nClinique Internationale Hannibal - Lac 2",
        status: 'UNREAD',
        createdAt: new Date(now - 2 * 3600 * 1000).toISOString(),
        readAt: null
      },
      {
        id: 'ref-seed-2',
        senderDoctorId: 'doc-triki',
        senderDoctorName: 'Dr. Yassine Triki',
        senderDoctorSpecialty: 'Médecine Interne & Diabétologie',
        senderDoctorCity: 'Ariana',
        senderDoctorDelegation: 'Ennasr 2',
        senderDoctorAvatar: '/images/doctor-m.png',
        senderDoctorPhone: '+216 71 820 900',
        recipientDoctorId: 'doc-1',
        recipientDoctorName: 'Dr. Selim Ben Ali',
        recipientDoctorSpecialty: 'Cardiologie & Maladies Vasculaires',
        recipientDoctorCity: 'Tunis',
        patientName: 'Fatma Benali',
        patientAge: '56 ans',
        patientPhone: '+216 98 123 456',
        priority: 'NORMAL',
        motif: "Cher Ami,\n\nJe vous confie Mme Fatma Benali (56 ans), suivie dans mon cabinet pour un diabète de type 2 évoluant depuis 8 ans, associé à une hypertension artérielle résistante sous bithérapie (IEC + IC).\nLe bilan de dépistage met en évidence une microalbuminurie positive ainsi qu'une claudication intermittente débutante aux membres inférieurs.\n\nMerci de bien vouloir effectuer une exploration cardio-vasculaire globale (écho-Doppler des TSA et des artères des membres inférieurs) et de réévaluer le traitement anti-hypertenseur.\n\nAvec mes remerciements confraternels,\nDr. Yassine Triki",
        status: 'UNREAD',
        createdAt: new Date(now - 26 * 3600 * 1000).toISOString(),
        readAt: null
      },
      {
        id: 'ref-seed-3',
        senderDoctorId: 'doc-louati',
        senderDoctorName: 'Dr. Amira Louati',
        senderDoctorSpecialty: 'Pédiatrie & Néonatalogie',
        senderDoctorCity: 'Tunis',
        senderDoctorDelegation: 'El Menzah 6',
        senderDoctorAvatar: '/images/doctor-f.png',
        senderDoctorPhone: '+216 71 750 330',
        recipientDoctorId: 'doc-1',
        recipientDoctorName: 'Dr. Selim Ben Ali',
        recipientDoctorSpecialty: 'Cardiologie & Maladies Vasculaires',
        recipientDoctorCity: 'Tunis',
        patientName: 'Youssef Trabelsi',
        patientAge: '8 ans',
        patientPhone: '+216 20 111 222',
        priority: 'NORMAL',
        motif: "Chère consœur, cher confrère,\n\nJe vous adresse l'enfant Youssef Trabelsi (8 ans), chez qui j'ai ausculté lors d'un examen systématique un souffle protosystolique 3/6 râpeux au foyer aortique avec irradiation latéro-sternale droite.\nL'enfant est asymptomatique, courbe de croissance normale. Aucun antécédent de RAA ni fièvre récente.\n\nJe vous remercie de bien vouloir pratiquer une échocardiographie transthoracique pédiatrique pour éliminer une bicuspidie aortique ou une sténose sous-valvulaire.\n\nConfraternellement,\nDr. Amira Louati",
        status: 'READ',
        createdAt: new Date(now - 72 * 3600 * 1000).toISOString(),
        readAt: new Date(now - 48 * 3600 * 1000).toISOString()
      }
    ];

    db.data.referralLetters.push(...seedLetters);
    db.save();
  }
}

// GET /api/doctors/referral-letters - Retrieve received, sent or all referral letters
router.get('/referral-letters', verifyToken, requireRole('DOCTOR', 'PRATICIEN', 'ADMIN', 'SUPER_ADMIN'), (req, res) => {
  try {
    const { doctorId = 'doc-1', type = 'all' } = req.query;
    ensureInitialReferralLetters(doctorId);

    let letters = Array.isArray(db.data.referralLetters) ? db.data.referralLetters : [];

    if (type === 'received') {
      letters = letters.filter(l => l.recipientDoctorId === doctorId || (!l.recipientDoctorId && doctorId === 'doc-1'));
    } else if (type === 'sent') {
      letters = letters.filter(l => l.senderDoctorId === doctorId || (!l.senderDoctorId && doctorId === 'doc-1'));
    } else if (doctorId) {
      letters = letters.filter(l => l.recipientDoctorId === doctorId || l.senderDoctorId === doctorId || doctorId === 'doc-1');
    }

    // Sort newest first
    letters.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const unreadCount = letters.filter(l => (l.recipientDoctorId === doctorId || doctorId === 'doc-1') && l.status === 'UNREAD').length;

    return res.json({
      success: true,
      data: letters,
      unreadCount,
      total: letters.length
    });
  } catch (err) {
    console.error('[ReferralLetters] Get error:', err);
    return res.status(500).json({ success: false, message: 'Erreur lors de la récupération des lettres d\'orientation.' });
  }
});

// POST /api/doctors/referral-letters - Transmit a formal referral letter to a verified colleague
router.post('/referral-letters', verifyToken, requireRole('DOCTOR', 'PRATICIEN', 'ADMIN', 'SUPER_ADMIN'), (req, res) => {
  try {
    const {
      senderDoctorId = 'doc-1',
      senderDoctorName = 'Dr. Selim Ben Ali',
      senderDoctorSpecialty = 'Cardiologie & Maladies Vasculaires',
      recipientDoctorId,
      recipientDoctorName,
      patientName,
      patientPhone = '',
      patientAge = '',
      motif,
      priority = 'NORMAL'
    } = req.body;

    if (!patientName || !patientName.trim()) {
      return res.status(400).json({
        success: false,
        field: 'patientName',
        message: 'Le nom du patient concerné est obligatoire.'
      });
    }

    if (!motif || !motif.trim()) {
      return res.status(400).json({
        success: false,
        field: 'motif',
        message: 'Le motif médical de la transmission et les données cliniques sont obligatoires.'
      });
    }

    // CRITICAL USER REQUIREMENT:
    // The recipient doctor MUST be registered / verified on the platform
    const allDoctors = db.get('doctors') || [];
    
    let matchedDoc = null;
    if (recipientDoctorId) {
      matchedDoc = allDoctors.find(d => String(d.id) === String(recipientDoctorId) || String(d.uuid) === String(recipientDoctorId));
    }
    
    if (!matchedDoc && recipientDoctorName) {
      const cleanTarget = recipientDoctorName.toLowerCase().replace(/^(dr\.?|docteur)\s*/i, '').trim();
      matchedDoc = allDoctors.find(d => {
        const cleanName = (d.name || '').toLowerCase().replace(/^(dr\.?|docteur)\s*/i, '').trim();
        return cleanName === cleanTarget || (d.name && d.name.toLowerCase() === recipientDoctorName.toLowerCase());
      });
    }

    if (!matchedDoc) {
      return res.status(400).json({
        success: false,
        code: 'DOCTOR_NOT_FOUND',
        field: 'recipientDoctor',
        message: 'Le confrère destinataire n\'est pas inscrit sur la plateforme Maw2idi. Vous devez sélectionner un médecin inscrit et vérifié sur la plateforme.'
      });
    }

    if (!Array.isArray(db.data.referralLetters)) {
      db.data.referralLetters = [];
    }

    const newLetter = {
      id: 'ref-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      senderDoctorId: senderDoctorId || 'doc-1',
      senderDoctorName: senderDoctorName || 'Dr. Selim Ben Ali',
      senderDoctorSpecialty: senderDoctorSpecialty || 'Médecin Praticien',
      recipientDoctorId: matchedDoc.id,
      recipientDoctorName: matchedDoc.name,
      recipientDoctorSpecialty: matchedDoc.specialtyFr || matchedDoc.specialty || matchedDoc.spec || 'Médecin Spécialiste',
      recipientDoctorCity: matchedDoc.city || 'Tunis',
      recipientDoctorDelegation: matchedDoc.delegation || '',
      recipientDoctorAvatar: matchedDoc.avatar || '/images/doctor-m.png',
      patientName: patientName.trim(),
      patientPhone: patientPhone.trim(),
      patientAge: patientAge.trim(),
      motif: motif.trim(),
      priority: priority || 'NORMAL',
      status: 'UNREAD',
      createdAt: new Date().toISOString(),
      readAt: null
    };

    db.data.referralLetters.unshift(newLetter);
    db.save();

    // Trigger Real-Time Notification & WebSocket Broadcast
    const io = req.app.get('io');
    if (io) {
      io.to(`doctor:${matchedDoc.id}`).emit('referral:new', newLetter);
      io.emit('referral:sync', { recipientDoctorId: matchedDoc.id, letter: newLetter });
    }

    try {
      broadcastNotification(io, {
        space: 'doctor',
        icon: '📨',
        title: 'Nouveau Courrier de Liaison Reçu',
        message: `Le ${senderDoctorName} vous a adressé le patient ${patientName} (${newLetter.recipientDoctorSpecialty}).`,
        category: 'liaison',
        doctorId: matchedDoc.id,
        doctorName: matchedDoc.name,
        patientName: patientName,
        actionUrl: '/doctor/dashboard?tab=liaison'
      });
    } catch (notifErr) {
      console.warn('[ReferralLetters] Notification error:', notifErr.message);
    }

    return res.status(201).json({
      success: true,
      message: `Lettre d'orientation transmise avec succès au ${matchedDoc.name}.`,
      data: newLetter
    });
  } catch (err) {
    console.error('[ReferralLetters] Post error:', err);
    return res.status(500).json({ success: false, message: 'Erreur lors de l\'envoi de la lettre d\'orientation.' });
  }
});

// PATCH /api/doctors/referral-letters/:id/read - Mark referral letter as read
router.patch('/referral-letters/:id/read', verifyToken, requireRole('DOCTOR', 'PRATICIEN', 'ADMIN', 'SUPER_ADMIN'), (req, res) => {
  try {
    const { id } = req.params;
    if (!Array.isArray(db.data.referralLetters)) {
      return res.status(404).json({ success: false, message: 'Lettre non trouvée.' });
    }

    const letter = db.data.referralLetters.find(l => l.id === id);
    if (!letter) {
      return res.status(404).json({ success: false, message: 'Lettre d\'orientation non trouvée.' });
    }

    letter.status = 'READ';
    letter.readAt = new Date().toISOString();
    db.save();

    const io = req.app.get('io');
    if (io) {
      io.emit('referral:read', { id, readAt: letter.readAt });
    }

    return res.json({
      success: true,
      message: 'Lettre marquée comme consultée.',
      data: letter
    });
  } catch (err) {
    console.error('[ReferralLetters] Read error:', err);
    return res.status(500).json({ success: false, message: 'Erreur lors de la mise à jour.' });
  }
});

// GET /api/doctors/:id - Single Doctor Details
router.get('/:id', (req, res) => {
  const targetId = req.params.id;
  let doc = db.findOne('doctors', d => d.id === targetId || d.uuid === targetId);
  const detail = db.findOne('doctor_detail', d => d.id === targetId || d.doctorId === targetId || d.uuid === targetId);

  // If not found directly, check if targetId is a user UUID/id or email associated with a doctor
  if (!doc) {
    const user = db.findOne('users', u => u.uuid === targetId || u.id === targetId);
    if (user) {
      if (user.doctorId) {
        doc = db.findOne('doctors', d => d.id === user.doctorId || d.uuid === user.doctorId);
      }
      if (!doc && user.email) {
        doc = db.findOne('doctors', d => d.email && d.email.toLowerCase() === user.email.toLowerCase());
      }
      if (!doc && user.role === 'DOCTOR') {
        doc = {
          id: user.doctorId || 'doc-' + user.uuid,
          uuid: user.uuid,
          name: user.name,
          email: user.email,
          title: 'Médecin Praticien Agréé',
          specialty: user.specialty || 'Médecine Générale',
          city: user.city || 'Tunis',
          fee: user.fee !== undefined ? user.fee : '70 TND',
          cnam: true
        };
      }
    }
  }

  // Also check doctors by email if targetId contains @
  if (!doc && targetId.includes('@')) {
    doc = db.findOne('doctors', d => d.email && d.email.toLowerCase() === targetId.toLowerCase());
  }

  if (!doc && !detail) {
    return res.status(404).json({ success: false, message: 'Médecin introuvable.' });
  }
  doc = { ...(doc || {}), ...(detail || {}) };
  if (!doc) {
    return res.status(404).json({ success: false, message: 'Médecin introuvable.' });
  }

  const reviews = db.filter('reviews', r => {
    const isDoc = r.doctorId === doc.id || r.doctorId === doc.uuid;
    const status = (r.status || 'PUBLIÉ').toUpperCase();
    return isDoc && status !== 'MODÉRÉ' && status !== 'MASQUÉ';
  });

  res.json({
    success: true,
    data: {
      ...doc,
      reviews
    }
  });
});

// GET /api/doctors/:id/schedule - Get doctor weekly schedule
router.get('/:id/schedule', (req, res) => {
  const docId = req.params.id || 'doc-1';
  const schedule = db.getDoctorSchedule(docId);
  res.json({ success: true, doctorId: docId, schedule });
});

// PUT /api/doctors/:id/schedule - Update doctor weekly schedule (Authenticated staff + ownership)
router.put('/:id/schedule', verifyToken, requireRole('DOCTOR', 'PRATICIEN', 'SECRETAIRE', 'SECRETARY', 'ADMIN', 'SUPER_ADMIN'), (req, res) => {
  const docId = req.params.id || 'doc-1';
  const role = (req.user?.role || '').toUpperCase();
  if (role !== 'ADMIN' && role !== 'SUPER_ADMIN' && req.user?.doctorId && req.user.doctorId !== docId) {
    return res.status(403).json({ success: false, message: 'Accès interdit : vous ne pouvez modifier que vos propres horaires.' });
  }
  const updatedSchedule = db.saveDoctorSchedule(docId, req.body);
  const io = req.app.get('io');
  if (io) {
    io.emit('schedule:updated', { doctorId: docId, schedule: updatedSchedule });
  }
  res.json({ success: true, message: 'Horaires du médecin enregistrés.', schedule: updatedSchedule });
});

// GET /api/doctors/:id/slots - Dynamic Slots Calculation (Anti-Conflict)
router.get('/:id/slots', (req, res) => {
  const docId = req.params.id;
  const doc = db.findOne('doctors', d => d.id === docId || d.uuid === docId);
  if (!doc) {
    return res.status(404).json({ success: false, message: 'Médecin introuvable.' });
  }

  // Base slot templates for morning and afternoon
  const baseSlots = ['08:30', '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '14:30', '15:00', '15:30', '16:00', '16:30'];

  // Query already booked appointments for this doctor
  const booked = db.filter('appointments', a =>
    (a.doctorId === docId || a.doctorId === doc.id || a.doctorId === doc.uuid) &&
    a.status !== 'CANCELLED'
  );

  const bookedMap = new Set(booked.map(b => `${b.date || 'Aujourd\'hui'}_${b.time}`));

  const days = ['Aujourd\'hui', 'Demain', 'Après-demain'];
  const availability = {};

  days.forEach(day => {
    availability[day] = baseSlots.map(time => ({
      time,
      available: !bookedMap.has(`${day}_${time}`)
    }));
  });

  res.json({
    success: true,
    doctorId: doc.id,
    doctorName: doc.name,
    availability
  });
});

// POST /api/doctors/request (or /api/praticiens/request) - Public Practitioner Onboarding & Consultation Request
router.post('/request', (req, res) => {
  try {
    const {
      firstname,
      lastname,
      name: rawName,
      email,
      phone,
      postal,
      objet,
      specId,
      spec,
      specialtyId,
      city,
      delegation,
      address,
      ordre,
      cnam,
      cnamType,
      fee,
      cvFileName
    } = req.body;

    let cleanName = (rawName || `${firstname || ''} ${lastname || ''}`).trim();
    while (/^(dr\.?|docteur|doctor|د\.?|طبيب)\s+/i.test(cleanName)) {
      cleanName = cleanName.replace(/^(dr\.?|docteur|doctor|د\.?|طبيب)\s+/i, '').trim();
    }
    const isArName = /[\u0600-\u06FF]/.test(cleanName);
    const formattedDoctorName = cleanName ? (isArName ? `د. ${cleanName}` : `Dr. ${cleanName}`) : '';

    if (!formattedDoctorName) {
      return res.status(400).json({ success: false, message: 'Le nom du praticien est requis.' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Une adresse email valide est requise.' });
    }
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Un numéro de téléphone valide est requis.' });
    }

    let cleanFee = 70;
    if (fee !== undefined && fee !== null && String(fee).trim() !== '') {
      const digits = String(fee).replace(/\D/g, '');
      if (digits !== '') {
        cleanFee = Math.min(200, Math.max(0, parseInt(digits, 10)));
      }
    }

    const resolvedSpec = spec || (specId === 'cardio' ? 'Cardiologie & Maladies Vasculaires' : 'Médecine Générale');
    const resolvedSpecId = specialtyId || specId || (resolvedSpec.toLowerCase().includes('cardio') ? 'cardio' : 'generaliste');
    const reqId = `prat-${Date.now()}`;

    const newRequest = {
      id: reqId,
      uuid: reqId,
      name: formattedDoctorName,
      firstname: firstname || cleanName.split(' ')[0] || '',
      lastname: lastname || cleanName.split(' ').slice(1).join(' ') || '',
      email: email.toLowerCase().trim(),
      phone: phone.trim(),
      postal: postal || '1000',
      objet: objet || 'Demande de conseiller',
      spec: resolvedSpec,
      specialtyId: resolvedSpecId,
      city: city || 'Tunis',
      delegation: delegation || 'Centre-Ville',
      address: address || `Cabinet ${postal || ''}, ${city || 'Tunis'}`.trim(),
      ordre: ordre || 'Aucun numéro détecté',
      cnam: cnam || cnamType || 'Aucune mention CNAM détectée',
      ocrResult: req.body.ocrResult || null,
      documents: req.body.documents || null,
      cvFileName: cvFileName || req.body.cv_file_name || 'cv_praticien.pdf',
      cvFileData: safePersistAsset(req.body.cvFileData || req.body.cv_file_data || req.body.cvData || null, 'cv'),
      avatar: safePersistAsset(req.body.avatar || req.body.photo || null, 'avatars'),
      fee: cleanFee,
      date: new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
      status: 'PENDING',
      createdAt: new Date().toISOString()
    };

    const normEmail = email.toLowerCase().trim();
    const existing = db.findOne('praticienRequests', r => (r.email && r.email.toLowerCase().trim() === normEmail));
    if (existing && existing.status === 'PENDING') {
      db.update('praticienRequests', r => (r.id === existing.id || r.uuid === existing.uuid), {
        ...newRequest,
        id: existing.id || reqId,
        uuid: existing.uuid || reqId,
        updatedAt: new Date().toISOString()
      });
      return res.json({
        success: true,
        message: 'Votre demande d\'adhésion praticien a été mise à jour.',
        request: { ...existing, ...newRequest }
      });
    }

    db.insert('praticienRequests', newRequest);

    // Automated Doctor Registration Confirmation Email
    try {
      EmailService.sendDoctorRegistrationConfirmationEmail({
        doctorName: newRequest.name,
        email: newRequest.email,
        specialty: newRequest.spec,
        city: `${newRequest.delegation ? newRequest.delegation + ', ' : ''}${newRequest.city} (${newRequest.postal})`,
        phone: newRequest.phone,
        requestId: newRequest.id || newRequest.uuid,
        hostUrl: `${req.protocol}://${req.get('host')}`
      }).then(resEmail => {
        console.log(`[Doctors] ✉️ Doctor registration confirmation email automatically dispatched to ${newRequest.email} (Status: ${resEmail?.emailRecord?.status || 'SENT'})`);
      }).catch(err => {
        console.error('[Doctors] ❌ Error sending doctor registration email:', err.message);
      });
    } catch (e) {
      console.warn('[Doctors] ⚠️ Doctor registration email exception:', e.message);
    }

    const io = req.app.get('io');
    if (io) {
      io.emit('praticien:new', newRequest);
    }
    broadcastNotification(io, {
      space: 'admin',
      icon: '👨‍⚕️',
      title: 'Nouvelle Demande Praticien',
      message: `${newRequest.name} (${newRequest.spec})`,
      category: 'system',
      actionUrl: '../Admin_pages/admin-db.html?tab=praticiens'
    });

    recordAuditLog({
      action: 'PRATICIEN_REQUEST_SUBMITTED',
      status: 'SUCCESS',
      details: `Demande praticien reçue: ${newRequest.name} (${newRequest.email}) - Spécialité: ${newRequest.spec}`,
      ip: req.ip || '127.0.0.1',
      role: 'GUEST'
    });

    res.status(201).json({
      success: true,
      message: `Votre demande d'inscription ${newRequest.name} a bien été enregistrée et transmise à l'administration Maw2idi.`,
      request: newRequest
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur lors de la soumission de la demande: ' + err.message });
  }
});

// POST /api/praticiens/request/:id/ocr - Persist automatic OCR extraction results
router.post('/request/:id/ocr', (req, res) => {
  try {
    const reqId = req.params.id;
    const { ordre, cnam, ocrResult, documents } = req.body;
    const existing = db.findOne('praticienRequests', r => (r.id === reqId || r.uuid === reqId));
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Demande introuvable.' });
    }
    const updates = {
      ordre: ordre || existing.ordre,
      cnam: cnam || existing.cnam,
      ocrResult: ocrResult || existing.ocrResult || null,
      documents: documents || existing.documents || null,
      updatedAt: new Date().toISOString()
    };
    db.update('praticienRequests', r => (r.id === reqId || r.uuid === reqId), updates);
    res.json({ success: true, request: { ...existing, ...updates } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/doctors/finalize-account - Doctor Sets Password & Exact Map Location from Email Link
router.post(['/finalize-account', '/finalize'], (req, res) => {
  try {
    const {
      id,
      email,
      name,
      token,
      password,
      cabName,
      city,
      address,
      lat,
      lng,
      fee,
      cnam,
      phone,
      taxId,
      offer,
      billingCycle,
      title,
      specialty,
      specialtyFr,
      specialtyAr,
      bio,
      bioAr,
      diplomas,
      cvFileName
    } = req.body;
    const avatar = safePersistAsset(req.body.avatar, 'avatars');
    const cvFileData = safePersistAsset(req.body.cvFileData, 'cv');
    const signature = safePersistAsset(req.body.signature || req.body.signatureData, 'signatures');
    const signatureData = signature;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'Adresse email valide requise pour finaliser le compte.' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Le mot de passe doit comporter au moins 6 caractères.' });
    }

    const normEmail = email.toLowerCase().trim();

    // Verify request approval status: Doctor cannot activate if already finalized, still PENDING or REJECTED
    const reqItem = db.findOne('praticienRequests', r => (r.email === normEmail || (id && (r.id === id || r.uuid === id))));
    if (reqItem) {
      if (reqItem.accountFinalized) {
        return res.status(409).json({
          success: false,
          code: 'ALREADY_FINALIZED',
          message: "Ce compte praticien a déjà été finalisé et activé. Ce lien à usage unique n'est plus actif."
        });
      }
      if (reqItem.status === 'PENDING') {
        return res.status(403).json({
          success: false,
          code: 'PENDING_REVIEW',
          message: "Votre demande d'inscription est actuellement en cours d'examen par l'administration. Dès validation de votre dossier, vous recevrez votre lien d'activation."
        });
      }
      if (reqItem.status === 'PENDING_DOCUMENTS') {
        return res.status(403).json({
          success: false,
          code: 'PENDING_DOCUMENTS',
          message: "Votre dossier est suspendu en attente de pièces justificatives complémentaires. Veuillez consulter l'e-mail officiel reçu."
        });
      }
      if (reqItem.status === 'REJECTED') {
        return res.status(403).json({
          success: false,
          code: 'REJECTED',
          message: "Votre demande n'a pas été retenue par l'administration."
        });
      }
    }

    const existingDoctorCheck = db.findOne('doctors', d => (d.email === normEmail || (id && (d.id === id || d.uuid === id))));
    if (existingDoctorCheck && existingDoctorCheck.accountFinalized) {
      return res.status(409).json({
        success: false,
        code: 'ALREADY_FINALIZED',
        message: "Ce compte praticien a déjà été finalisé et activé. Ce lien à usage unique n'est plus actif."
      });
    }
    const latNum = (lat !== undefined && lat !== null && lat !== '') ? parseFloat(lat) : 36.8065;
    const lngNum = (lng !== undefined && lng !== null && lng !== '') ? parseFloat(lng) : 10.1815;

    // Hash doctor confidential password with bcrypt
    const salt = bcrypt.genSaltSync(10);
    const passwordHash = bcrypt.hashSync(password, salt);

    // Pricing configuration for 15% discount
    const resolvedOffer = (offer || 'pro').toLowerCase();
    const resolvedCycle = (billingCycle || 'monthly').toLowerCase();
    const isAnnual = resolvedCycle === 'annual';
    const planMeta = {
      essentiel: { name: 'Essentiel', base: 59, annualMonth: 50.15, annualTotal: 601.8, savings: 106.2 },
      pro: { name: 'Pro Cabinet', base: 99, annualMonth: 84.15, annualTotal: 1009.8, savings: 178.2 },
      clinique: { name: 'Clinique & Groupe', base: 189, annualMonth: 160.65, annualTotal: 1927.8, savings: 340.2 }
    };
    const pInfo = planMeta[resolvedOffer] || planMeta.pro;
    const subscriptionRecord = req.body.subscription || {
      plan: resolvedOffer,
      planName: pInfo.name,
      billingCycle: resolvedCycle,
      monthlyPrice: isAnnual ? pInfo.annualMonth : pInfo.base,
      annualTotal: isAnnual ? pInfo.annualTotal : pInfo.base * 12,
      discountPercent: isAnnual ? 15 : 0,
      savings: isAnnual ? pInfo.savings : 0,
      status: 'ACTIVE',
      trialDays: 30,
      activatedAt: new Date().toISOString()
    };

    // Sanitize doctor name & fee bounds
    let cleanDoctorName = String(name || cabName || 'Praticien').trim();
    while (/^(dr\.?|docteur|doctor|د\.?|طبيب)\s+/i.test(cleanDoctorName)) {
      cleanDoctorName = cleanDoctorName.replace(/^(dr\.?|docteur|doctor|د\.?|طبيب)\s+/i, '').trim();
    }
    const isArDoctor = /[\u0600-\u06FF]/.test(cleanDoctorName);
    const finalDoctorName = cleanDoctorName ? (isArDoctor ? `د. ${cleanDoctorName}` : `Dr. ${cleanDoctorName}`) : 'Dr. Praticien';

    const rawFeeDigits = (fee !== undefined && fee !== null && String(fee).trim() !== '')
      ? String(fee).replace(/\D/g, '')
      : '';
    let resolvedFee = rawFeeDigits !== '' ? parseInt(rawFeeDigits, 10) : 70;
    if (resolvedFee > 200) resolvedFee = 200;
    if (resolvedFee < 0) resolvedFee = 0;

    // 1. Update or Create User Account
    let user = db.findOne('users', u => u.email === normEmail);
    if (user) {
      db.update('users', u => u.email === normEmail, {
        passwordHash,
        name: finalDoctorName,
        phone: phone || user.phone,
        role: 'DOCTOR',
        offer: resolvedOffer,
        billingCycle: resolvedCycle,
        subscriptionPlan: resolvedOffer,
        subscription: subscriptionRecord,
        fee: `${resolvedFee} TND`
      });
      user = db.findOne('users', u => u.email === normEmail);
    } else {
      user = {
        uuid: `usr-${Date.now()}`,
        email: normEmail,
        passwordHash,
        name: finalDoctorName,
        role: 'DOCTOR',
        offer: resolvedOffer,
        billingCycle: resolvedCycle,
        subscriptionPlan: resolvedOffer,
        subscription: subscriptionRecord,
        fee: `${resolvedFee} TND`,
        phone: phone || '',
        createdAt: new Date().toISOString()
      };
      db.insert('users', user);
    }

    // 2. Update or Create Doctor Record with GPS Location & Map Coordinates
    let doctor = db.findOne('doctors', d => (d.email === normEmail || (id && (d.id === id || d.uuid === id))));

    if (doctor) {
      db.update('doctors', d => (d.email === normEmail || (id && (d.id === id || d.uuid === id))), {
        lat: latNum,
        lng: lngNum,
        name: finalDoctorName,
        title: title || doctor.title || 'Médecin Praticien Agréé',
        specialty: specialty || specialtyFr || doctor.specialty,
        specialtyFr: specialtyFr || specialty || doctor.specialtyFr,
        specialtyAr: specialtyAr || doctor.specialtyAr || 'طبيب أخصائي',
        avatar: avatar || doctor.avatar || '../../images/doctor_selim.jpg',
        bio: bio !== undefined ? bio : doctor.bio,
        bioAr: bioAr !== undefined ? bioAr : doctor.bioAr,
        diplomas: Array.isArray(diplomas) ? diplomas : doctor.diplomas,
        cvFileName: cvFileName || doctor.cvFileName || '',
        cvFileData: cvFileData || doctor.cvFileData || '',
        signature: signature || signatureData || req.body.signature || req.body.signatureData || doctor.signature || doctor.signatureData || '',
        signatureData: signatureData || signature || req.body.signatureData || req.body.signature || doctor.signatureData || doctor.signature || '',
        address: address || doctor.address,
        city: city || doctor.city,
        phone: phone || doctor.phone,
        fee: `${resolvedFee} TND`,
        cnamReimbursement: Math.round(resolvedFee * 0.7),
        cnam: cnam ? (cnam !== 'NON') : doctor.cnam,
        cnamType: cnam || doctor.cnamType,
        taxId: taxId || doctor.taxId,
        cabName: cabName || doctor.cabName || doctor.name,
        offer: resolvedOffer,
        billingCycle: resolvedCycle,
        subscriptionPlan: resolvedOffer,
        subscriptionCycle: resolvedCycle,
        subscription: subscriptionRecord,
        subscriptionStatus: 'ACTIVE',
        verified: true,
        active: true,
        accountFinalized: true,
        finalizedAt: new Date().toISOString()
      });
      doctor = db.findOne('doctors', d => (d.email === normEmail || (id && (d.id === id || d.uuid === id))));
    } else {
      const reqItem = db.findOne('praticienRequests', r => (r.email === normEmail || (id && (r.id === id || r.uuid === id))));
      const doctorId = id && id.startsWith('doc-') ? id : `doc-${Date.now()}`;
      doctor = {
        id: doctorId,
        uuid: doctorId,
        name: name || reqItem?.name || cabName || 'Dr. Praticien Agréé',
        title: title || 'Médecin Praticien Agréé',
        ordreId: reqItem?.ordre || 'N° 20194',
        specialtyId: reqItem?.specialtyId || 'generaliste',
        specialtyFr: specialtyFr || specialty || reqItem?.spec || 'Médecine Générale',
        specialtyAr: specialtyAr || 'طبيب أخصائي',
        spec: specialty || reqItem?.spec || 'Médecine Générale',
        specialty: specialty || specialtyFr || reqItem?.spec || 'Médecine Générale',
        avatar: avatar || '../../images/doctor_selim.jpg',
        bio: bio || '',
        bioAr: bioAr || '',
        diplomas: Array.isArray(diplomas) ? diplomas : [
          "Diplôme d'État de Docteur en Médecine",
          "Diplôme d'Études Spécialisées",
          "Membre de l'Ordre des Médecins de Tunisie"
        ],
        cvFileName: cvFileName || '',
        cvFileData: cvFileData || '',
        city: city || 'Tunis',
        address: address || `Cabinet Médical, ${city || 'Tunis'}`,
        lat: latNum,
        lng: lngNum,
        phone: phone || '+216 71 000 000',
        email: normEmail,
        fee: `${resolvedFee} TND`,
        cnamReimbursement: Math.round(resolvedFee * 0.7),
        cnam: cnam ? (cnam !== 'NON') : true,
        cnamType: cnam || 'Filière Privée',
        taxId: taxId || '',
        offer: resolvedOffer,
        billingCycle: resolvedCycle,
        subscriptionPlan: resolvedOffer,
        subscriptionCycle: resolvedCycle,
        subscription: subscriptionRecord,
        subscriptionStatus: 'ACTIVE',
        verified: true,
        active: true,
        accountFinalized: true,
        slots: {
          'Aujourd\'hui': ['09:00', '10:00', '11:00', '14:30', '15:30'],
          'Demain': ['08:30', '09:30', '10:30', '14:00', '15:00'],
          'Mercredi': ['09:00', '10:00', '14:00', '15:00'],
          'Jeudi': ['09:30', '10:30', '14:30', '15:30']
        },
        createdAt: new Date().toISOString(),
        finalizedAt: new Date().toISOString()
      };
      db.insert('doctors', doctor);
    }

    // 3. Mark Praticien Request As Finalized
    db.update('praticienRequests', r => (r.email === normEmail || (id && (r.id === id || r.uuid === id))), {
      status: 'APPROVED',
      accountFinalized: true,
      offer: resolvedOffer,
      billingCycle: resolvedCycle,
      subscriptionPlan: resolvedOffer,
      subscriptionCycle: resolvedCycle,
      subscription: subscriptionRecord,
      lat: latNum,
      lng: lngNum,
      finalizedAt: new Date().toISOString()
    });

    // 4. Ensure User Account is strictly bound to Doctor ID and Specialty
    db.update('users', u => u.email === normEmail || (user && u.uuid === user.uuid), {
      doctorId: doctor.id,
      name: doctor.name,
      specialty: doctor.specialtyFr || doctor.specialty || 'Médecine Générale',
      avatar: doctor.avatar || '/images/3ila_doctor.jpeg',
      role: 'DOCTOR',
      phone: doctor.phone || user.phone,
      city: doctor.city || user.city,
      address: doctor.address || user.address
    });
    user = db.findOne('users', u => u.email === normEmail || (user && u.uuid === user.uuid));

    recordAuditLog({
      action: 'DOCTOR_ACCOUNT_FINALIZED',
      status: 'SUCCESS',
      details: `Compte finalisé pour Dr. ${doctor.name} (${normEmail}) - Coordonnées GPS: [${latNum}, ${lngNum}] - Ajouté à la carte publique`,
      ip: req.ip || '127.0.0.1',
      role: 'DOCTOR'
    });

    const io = req.app.get('io');
    if (io) {
      io.emit('doctor:map-updated', {
        doctorId: doctor.id,
        name: doctor.name,
        specialtyFr: doctor.specialtyFr,
        lat: latNum,
        lng: lngNum,
        address: doctor.address,
        city: doctor.city
      });
      io.emit('doctor:updated', doctor);
    }

    broadcastNotification(io, {
      space: 'admin',
      icon: '🗺️',
      title: 'Cabinet Praticien Positionné sur la Carte',
      message: `${doctor.name} a défini son mot de passe et son emplacement GPS [${latNum.toFixed(4)}, ${lngNum.toFixed(4)}].`,
      category: 'praticien',
      actionUrl: '../Admin_pages/admin-db.html?tab=praticiens'
    });

    broadcastNotification(io, {
      space: 'doctor',
      doctorId: doctor.id || doctor.uuid,
      doctorName: doctor.name,
      icon: '🚀',
      title: 'Cabinet Opérationnel',
      message: `Votre compte et emplacement géographique sont enregistrés. Vous êtes désormais visible des patients !`,
      category: 'system',
      actionUrl: '../Doctors_pages/doctor-dashboard.html'
    });

    const sessionToken = generateToken ? generateToken({
      uuid: user.uuid,
      id: user.uuid,
      email: user.email,
      role: 'DOCTOR',
      name: doctor.name,
      doctorId: doctor.id
    }) : null;

    // Dispatch official completion emails to doctor and admin asynchronously
    EmailService.sendOnboardingCompletedEmails({
      doctorName: doctor.name,
      email: doctor.email,
      specialty: doctor.specialtyFr || doctor.specialty,
      city: doctor.city,
      fee: resolvedFee,
      offer: resolvedOffer,
      billingCycle: resolvedCycle,
      doctorId: doctor.id,
      address: doctor.address
    }).catch(err => {
      console.warn('[Doctor] Error sending onboarding completion emails:', err.message);
    });

    res.json({
      success: true,
      token: sessionToken,
      message: `Félicitations Dr. ${doctor.name} ! Votre mot de passe est enregistré, votre cabinet est positionné sur la carte et votre offre ${offer || 'PRO'} est activée.`,
      doctor: doctor,
      user: {
        id: user.uuid,
        uuid: user.uuid,
        email: user.email,
        name: doctor.name,
        role: 'DOCTOR',
        doctorId: doctor.id,
        specialty: doctor.specialtyFr || doctor.specialty || 'Médecine Générale',
        phone: doctor.phone || user.phone,
        avatar: doctor.avatar || user.avatar || '/images/3ila_doctor.jpeg',
        address: doctor.address || user.address,
        city: doctor.city || user.city,
        fee: doctor.fee || `${resolvedFee} TND`
      },
      mapCoordinates: {
        lat: latNum,
        lng: lngNum
      }
    });
  } catch (err) {
    console.error('[Doctor] Finalize account error:', err);
    res.status(500).json({ success: false, message: 'Erreur lors de la finalisation du compte : ' + err.message });
  }
});

// POST /api/doctors/onboarding-incomplete - Consigne l'expiration du temps d'onboarding (30 min) et notifie admin + médecin
router.post('/onboarding-incomplete', async (req, res) => {
  try {
    const { id, email, name, lastStepReached } = req.body;
    const normEmail = (email || '').toLowerCase().trim();

    if (id || normEmail) {
      db.update('praticienRequests', r => (r.id === id || r.uuid === id || (normEmail && r.email && r.email.toLowerCase().trim() === normEmail)), {
        onboardingExpired: true,
        lastStepReached: lastStepReached || 1,
        expiredAt: new Date().toISOString()
      });
    }

    const io = req.app.get('io');
    if (io) {
      broadcastNotification(io, {
        space: 'admin',
        icon: '⏱️',
        title: 'Session d\'activation expirée',
        message: `La session d'activation pour Dr. ${name || email || 'Praticien'} a expiré (30 minutes écoulées à l'étape ${lastStepReached || 1}).`,
        category: 'praticien',
        actionUrl: '../Admin_pages/admin-db.html?tab=praticiens'
      });
    }

    // Dispatch expiration emails asynchronously
    if (normEmail) {
      EmailService.sendOnboardingExpiredEmails({
        doctorName: name || 'Praticien',
        email: normEmail,
        requestId: id,
        lastStepReached: lastStepReached || 1
      }).catch(e => console.warn('[Doctor] Error sending onboarding expired emails:', e.message));
    }

    res.json({
      success: true,
      message: 'Expiration de la session enregistrée avec succès.'
    });
  } catch (err) {
    console.error('[Doctor] Onboarding incomplete notification error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/doctors/request-reactivation - Demande de réactivation soumise par le médecin après expiration
router.post('/request-reactivation', async (req, res) => {
  try {
    const { id, email, name, reason } = req.body;
    const normEmail = (email || '').toLowerCase().trim();

    if (!normEmail && !id) {
      return res.status(400).json({ success: false, message: 'Identifiant ou email requis pour la réactivation.' });
    }

    // Update request state
    db.update('praticienRequests', r => (r.id === id || r.uuid === id || (normEmail && r.email && r.email.toLowerCase().trim() === normEmail)), {
      status: 'REACTIVATION_REQUESTED',
      reactivationRequested: true,
      reactivationReason: reason || '',
      reactivationRequestedAt: new Date().toISOString()
    });

    const targetReq = db.findOne('praticienRequests', r => (r.id === id || r.uuid === id || (normEmail && r.email && r.email.toLowerCase().trim() === normEmail)));
    const docName = name || targetReq?.name || 'Praticien';

    const io = req.app.get('io');
    if (io) {
      broadcastNotification(io, {
        space: 'admin',
        icon: '🔄',
        title: 'Demande de Réactivation Praticien',
        message: `Dr. ${docName} (${normEmail || targetReq?.email}) demande la réactivation de son lien d'activation.${reason ? ` Motif: "${reason}"` : ''}`,
        category: 'praticien',
        actionUrl: '../Admin_pages/admin-db.html?tab=praticiens'
      });
    }

    recordAuditLog({
      action: 'DOCTOR_REACTIVATION_REQUESTED',
      status: 'SUCCESS',
      details: `Dr. ${docName} (${normEmail || targetReq?.email}) a sollicité la réactivation de son lien d'activation`,
      ip: req.ip || '127.0.0.1',
      role: 'DOCTOR'
    });

    // Dispatch emails to admin and doctor
    EmailService.sendReactivationRequestedEmails({
      doctorName: docName,
      email: normEmail || targetReq?.email,
      requestId: id || targetReq?.id,
      reason: reason || ''
    }).catch(e => console.warn('[Doctor] Error sending reactivation requested emails:', e.message));

    res.json({
      success: true,
      message: 'Votre demande de réactivation a été transmise à l\'administrateur. Vous recevrez un nouvel e-mail dès validation.'
    });
  } catch (err) {
    console.error('[Doctor] Request reactivation error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});


// PUT /api/doctors/:id - Update doctor profile details & sync linked user (Authenticated staff + ownership)
router.put('/:id', verifyToken, requireRole('DOCTOR', 'PRATICIEN', 'SECRETAIRE', 'SECRETARY', 'ADMIN', 'SUPER_ADMIN'), (req, res) => {
  try {
    const docId = req.params.id;
    const role = (req.user?.role || '').toUpperCase();
    if (role !== 'ADMIN' && role !== 'SUPER_ADMIN' && req.user?.doctorId && req.user.doctorId !== docId) {
      return res.status(403).json({ success: false, message: 'Accès interdit : vous ne pouvez modifier que votre propre profil praticien.' });
    }
    const doc = db.findOne('doctors', d => d.id === docId || d.uuid === docId);
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Médecin introuvable.' });
    }

    const {
      name,
      title,
      specialty,
      specialty_fr,
      specialty_ar,
      city,
      delegation,
      address,
      phone,
      email,
      fee,
      cnam,
      telehealth,
      avatar,
      image,
      bio,
      presentation,
      diplomas,
      diplomasAr,
      equipment,
      equipmentAr,
      languages,
      languagesAr,
      accessibility,
      accessibilityAr
    } = req.body;

    const updates = {
      updatedAt: new Date().toISOString()
    };

    if (name && typeof name === 'string' && name.trim()) {
      let clean = name.trim();
      while (/^(dr\.?|docteur|doctor|د\.?|طبيب)\s+/i.test(clean)) {
        clean = clean.replace(/^(dr\.?|docteur|doctor|د\.?|طبيب)\s+/i, '').trim();
      }
      const isArName = /[\u0600-\u06FF]/.test(clean);
      updates.name = clean ? (isArName ? `د. ${clean}` : `Dr. ${clean}`) : name.trim();
    }
    if (title !== undefined) updates.title = String(title).trim();
    if (specialty !== undefined) {
      updates.specialty = String(specialty).trim();
      updates.specialty_fr = specialty_fr || String(specialty).trim();
      updates.specialtyFr = specialty_fr || String(specialty).trim();
    }
    if (specialty_ar !== undefined) {
      updates.specialty_ar = specialty_ar;
      updates.specialtyAr = specialty_ar;
    }
    if (city !== undefined) updates.city = String(city).trim();
    if (delegation !== undefined) updates.delegation = String(delegation).trim();
    if (address !== undefined) updates.address = String(address).trim();
    if (phone !== undefined) updates.phone = String(phone).trim();
    if (email !== undefined) updates.email = String(email).trim();
    if (fee !== undefined && fee !== null && String(fee).trim() !== '') {
      const digits = String(fee).replace(/\D/g, '');
      if (digits !== '') {
        let feeNum = parseInt(digits, 10);
        if (feeNum > 200) feeNum = 200;
        if (feeNum < 0) feeNum = 0;
        updates.fee = `${feeNum} TND`;
      } else {
        updates.fee = '70 TND';
      }
    }
    if (cnam !== undefined) updates.cnam = Boolean(cnam);
    if (telehealth !== undefined) updates.telehealth = Boolean(telehealth);
    if (avatar !== undefined) {
      const persistedAvatar = safePersistAsset(avatar, 'avatars');
      updates.avatar = persistedAvatar;
      updates.image = persistedAvatar;
    }
    if (image !== undefined) {
      const persistedImg = safePersistAsset(image, 'avatars');
      updates.image = persistedImg;
      if (!updates.avatar) updates.avatar = persistedImg;
    }
    if (req.body.cvFileName !== undefined || req.body.cv_file_name !== undefined) {
      updates.cvFileName = req.body.cvFileName || req.body.cv_file_name || null;
    }
    if (req.body.cvFileData !== undefined || req.body.cv_file_data !== undefined) {
      updates.cvFileData = safePersistAsset(req.body.cvFileData || req.body.cv_file_data || null, 'cv');
    }
    if (req.body.signature !== undefined || req.body.signatureData !== undefined) {
      const sigVal = safePersistAsset(req.body.signature || req.body.signatureData || null, 'signatures');
      updates.signature = sigVal;
      updates.signatureData = sigVal;
    }
    if (presentation !== undefined) {
      updates.presentation = String(presentation).trim();
      updates.bio = String(presentation).trim();
    } else if (bio !== undefined) {
      updates.bio = String(bio).trim();
      updates.presentation = String(bio).trim();
    }
    if (diplomas !== undefined) {
      updates.diplomas = Array.isArray(diplomas) ? diplomas : [diplomas];
    }
    if (diplomasAr !== undefined) {
      updates.diplomasAr = Array.isArray(diplomasAr) ? diplomasAr : [diplomasAr];
    }
    if (equipment !== undefined) {
      updates.equipment = Array.isArray(equipment) ? equipment : [equipment];
    }
    if (equipmentAr !== undefined) {
      updates.equipmentAr = Array.isArray(equipmentAr) ? equipmentAr : [equipmentAr];
    }
    if (languages !== undefined) {
      updates.languages = String(languages).trim();
    }
    if (languagesAr !== undefined) {
      updates.languagesAr = String(languagesAr).trim();
    }
    if (accessibility !== undefined) {
      updates.accessibility = String(accessibility).trim();
    }
    if (accessibilityAr !== undefined) {
      updates.accessibilityAr = String(accessibilityAr).trim();
    }
    if (req.body.lat !== undefined && req.body.lat !== null && req.body.lat !== '') {
      updates.lat = parseFloat(req.body.lat);
    }
    if (req.body.lng !== undefined && req.body.lng !== null && req.body.lng !== '') {
      updates.lng = parseFloat(req.body.lng);
    }

    const updatedDoc = db.update('doctors', d => d.id === doc.id, updates);

    // Sync linked user account in users table
    const linkedUser = db.findOne('users', u => u.doctorId === doc.id || u.doctor_id === doc.id || (u.email && doc.email && u.email.toLowerCase() === doc.email.toLowerCase()));
    if (linkedUser) {
      const userUpdates = { updatedAt: new Date().toISOString() };
      if (updates.name) userUpdates.name = updates.name;
      if (updates.phone) userUpdates.phone = updates.phone;
      if (updates.avatar) userUpdates.avatar = updates.avatar;
      if (updates.city) userUpdates.city = updates.city;
      if (updates.address) userUpdates.address = updates.address;
      db.update('users', u => u.uuid === linkedUser.uuid, userUpdates);
    }

    const io = req.app.get('io');
    if (io) {
      io.emit('doctor:updated', { doctor: updatedDoc });
      if (updatedDoc.lat && updatedDoc.lng) {
        io.emit('doctor:map-updated', {
          doctorId: updatedDoc.id,
          name: updatedDoc.name,
          lat: updatedDoc.lat,
          lng: updatedDoc.lng,
          address: updatedDoc.address,
          city: updatedDoc.city,
          delegation: updatedDoc.delegation
        });
      }
    }

    return res.json({
      success: true,
      message: 'Profil du médecin mis à jour avec succès.',
      doctor: updatedDoc
    });
  } catch (err) {
    console.error('[Doctor] Update error:', err);
    return res.status(500).json({ success: false, message: 'Erreur lors de la mise à jour du profil médecin.' });
  }
});

module.exports = router;



