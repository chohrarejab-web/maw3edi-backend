/**
 * SahaTN / Maw2idi — Doctor Offline Payments & Subscription Management Routes
 * Supports Tunisian offline payment methods: Virement Bancaire (RIB), D17 / La Poste, Chèque, Espèces.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../config/database');
const { verifyToken, requireRole } = require('../middleware/auth');
const { persistDataUri, resolveUploadPath } = require('../utils/fileStorage');

const router = express.Router();

// Server-authoritative doctor subscription plans (TND)
const SUBSCRIPTION_PLANS = [
  {
    id: 'essentiel',
    name: 'Essentiel',
    nameAr: 'الأساسية (Essentiel)',
    descriptionFr: 'Pour médecin libéral individuel souhaitant digitaliser ses RDV.',
    descriptionAr: 'للطبيب الممارس المستقل لتنظيم مواعيده رقمياً وبأقل تكلفة.',
    monthlyPrice: 59,
    discountPercentage: 15,
    isRecommended: false,
    featuresFr: [
      'Prise de RDV en ligne 24h/7j',
      'Rappels SMS & WhatsApp',
      'Référencement sur la carte SahaTN'
    ],
    featuresAr: [
      'حجز المواعيد أونلاين 24/7',
      'تذكير آلي عبر SMS والواتساب',
      'الظهور على خريطة ودليل SahaTN'
    ]
  },
  {
    id: 'pro',
    name: 'Pro Cabinet',
    nameAr: 'المحترفة (Pro Cabinet)',
    descriptionFr: "La solution complète : file d'attente, CNAM et ordonnancier.",
    descriptionAr: 'الحل الشامل: قاعة انتظار ذكية، الكنام والوصفات الرقمية.',
    monthlyPrice: 99,
    discountPercentage: 15,
    isRecommended: true,
    featuresFr: [
      'Tout dans Essentiel',
      "File d'attente virtuelle en direct",
      'Télétransmission & Bordereaux CNAM C1',
      'Ordonnancier PCT & Fiches patients',
      'Module Téléconsultation vidéo HD'
    ],
    featuresAr: [
      'كل ميزات الباقة الأساسية',
      'قاعة انتظار ذكية وبث مباشر للدور',
      'استمارات وتصاريح الكنام C1 الرقمية',
      'وصفات طبية مشفرة وملفات المرضى',
      'استشارات طبية بالفيديو عالية الدقة'
    ]
  },
  {
    id: 'clinique',
    name: 'Clinique & Groupe',
    nameAr: 'المصحات والمجمعات (Clinique)',
    descriptionFr: 'Pour centres médicaux, polycliniques et cabinets partagés.',
    descriptionAr: 'للمراكز الطبية والمجمعات الطبية متعددة الأطباء.',
    monthlyPrice: 189,
    discountPercentage: 15,
    isRecommended: false,
    featuresFr: [
      'Tout dans Pro Cabinet',
      "Jusqu'à 10 comptes praticiens & secrétaires",
      'Tableau de bord analytique & recettes',
      'Support technique dédié 24h/7j'
    ],
    featuresAr: [
      'كل ميزات الباقة المحترفة',
      'حتى 10 حسابات أطباء وسكرتارية',
      'لوحة تحكم تحليلية وإحصائيات المداخيل',
      'دعم فني مخصص على مدار الساعة'
    ]
  }
];

const OFFLINE_METHODS = [
  {
    id: 'bank_transfer',
    labelFr: 'Virement / Versement Bancaire (RIB)',
    labelAr: 'تحويل أو إيداع بنكي (RIB)',
    requiresRef: true
  },
  {
    id: 'd17_poste',
    labelFr: 'D17 / La Poste Tunisienne (Mandat)',
    labelAr: 'تطبيق D17 / البريد التونسي (حوالة)',
    requiresRef: true
  },
  {
    id: 'check',
    labelFr: 'Chèque Bancaire',
    labelAr: 'شيك بنكي',
    requiresRef: true
  },
  {
    id: 'cash',
    labelFr: 'Espèces (Agence / Commercial)',
    labelAr: 'نقداً (الوكالة / المندوب التجاري)',
    requiresRef: false
  }
];

const ALLOWED_METHOD_IDS = new Set(OFFLINE_METHODS.map(m => m.id));
const ALLOWED_CYCLES = new Set(['monthly', 'annual']);

function getBankInstructions() {
  return {
    beneficiary: process.env.OFFLINE_BANK_HOLDER || 'MAW2IDI / SAHATN HEALTH TECH SARL',
    bankName: process.env.OFFLINE_BANK_NAME || 'BIAT — Agence Les Berges du Lac, Tunis',
    rib: process.env.OFFLINE_BANK_RIB || '08 004 0123456789012 34',
    d17Number: process.env.OFFLINE_D17_NUMBER || '+216 50 000 000',
    posteAccount: process.env.OFFLINE_POSTE_CCP || 'CCP 17 000 0001234567 89',
    officeAddress: process.env.OFFLINE_OFFICE_ADDRESS || 'Les Berges du Lac 2, 1053 Tunis, Tunisie',
    supportPhone: process.env.OFFLINE_SUPPORT_PHONE || '+216 71 000 000',
    supportEmail: process.env.OFFLINE_SUPPORT_EMAIL || 'facturation@maw2idi.tn'
  };
}

function calculateServerPlanPrice(planId, billingCycle = 'monthly') {
  const plan = SUBSCRIPTION_PLANS.find(p => p.id === planId);
  if (!plan) return null;
  const cycle = ALLOWED_CYCLES.has(billingCycle) ? billingCycle : 'monthly';
  const monthly = Number(plan.monthlyPrice);
  const discount = Number(plan.discountPercentage) || 0;
  const annualTotal = Math.round(monthly * 12 * (1 - discount / 100));
  const annualPerMonth = Math.round(annualTotal / 12);
  return {
    plan,
    billingCycle: cycle,
    monthlyPrice: monthly,
    annualTotal,
    annualPerMonth,
    discountPercentage: discount,
    amountTnd: cycle === 'annual' ? annualTotal : monthly,
    durationDays: cycle === 'annual' ? 365 : 30
  };
}

function generateReferenceCode() {
  const year = new Date().getFullYear();
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `MAW-${year}-${suffix}`;
}

function resolveDoctorId(req) {
  const isAdmin = req.user && (req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN');
  if (isAdmin && (req.query?.doctorId || req.body?.doctorId)) {
    return String(req.query?.doctorId || req.body?.doctorId);
  }
  if (req.user?.doctorId) return String(req.user.doctorId);
  // Fallback: match doctor by user email
  if (req.user?.email) {
    const doc = db.findOne('doctors', d => d.email && d.email.toLowerCase() === req.user.email.toLowerCase());
    if (doc) return String(doc.id);
  }
  return req.user?.uuid ? String(req.user.uuid) : null;
}

function computeEffectiveSubscription(sub) {
  if (!sub) {
    return {
      status: 'none',
      planId: null,
      planName: null,
      billingCycle: null,
      startsAt: null,
      expiresAt: null,
      daysRemaining: 0
    };
  }
  const now = Date.now();
  const expMs = sub.expiresAt ? new Date(sub.expiresAt).getTime() : 0;
  let effectiveStatus = sub.status;
  let daysRemaining = 0;

  if (sub.status === 'active' && expMs > 0) {
    const diffMs = expMs - now;
    if (diffMs <= 0) {
      effectiveStatus = 'expired';
      daysRemaining = 0;
    } else {
      daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    }
  }

  return {
    ...sub,
    status: effectiveStatus,
    daysRemaining
  };
}

function recordAudit(req, action, resource, details) {
  try {
    db.insert('auditLogs', {
      id: `aud-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      timestamp: new Date().toISOString(),
      tunisTime: new Date().toLocaleString('fr-TN', { timeZone: 'Africa/Tunis' }),
      action,
      actor: {
        uuid: req.user?.uuid || 'system',
        email: req.user?.email || 'system',
        role: req.user?.role || 'SYSTEM'
      },
      resource,
      clientIp: req.ip || req.socket?.remoteAddress || 'unknown',
      status: 'SUCCESS',
      details,
      compliance: 'INPDP_TUNISIE_2004_63'
    });
  } catch (e) {
    console.warn('[Payments Audit] Failed to record audit:', e.message);
  }
}

// ---------------------------------------------------------------------------
// 1. GET /api/payments/config — Plans, offline methods & bank RIB/D17 info
// ---------------------------------------------------------------------------
router.get('/config', verifyToken, (req, res) => {
  const plans = SUBSCRIPTION_PLANS.map(p => {
    const pricing = calculateServerPlanPrice(p.id, 'annual');
    return {
      ...p,
      annualTotal: pricing.annualTotal,
      annualPerMonth: pricing.annualPerMonth
    };
  });
  return res.json({
    success: true,
    data: {
      plans,
      methods: OFFLINE_METHODS,
      bankInfo: getBankInstructions()
    }
  });
});

// ---------------------------------------------------------------------------
// 2. GET /api/payments/my — Current doctor's subscription & offline payments
// ---------------------------------------------------------------------------
router.get(
  '/my',
  verifyToken,
  requireRole('DOCTOR', 'PRATICIEN', 'SECRETARY', 'ADMIN', 'SUPER_ADMIN'),
  (req, res) => {
    const doctorId = resolveDoctorId(req);
    if (!doctorId) {
      return res.status(400).json({ success: false, message: 'Identifiant médecin introuvable.' });
    }

    const rawSub = db.findOne('doctorSubscriptions', s => String(s.doctorId) === doctorId);
    const subscription = computeEffectiveSubscription(rawSub);
    const payments = db
      .filter('offlinePayments', p => String(p.doctorId) === doctorId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const plans = SUBSCRIPTION_PLANS.map(p => {
      const pricing = calculateServerPlanPrice(p.id, 'annual');
      return {
        ...p,
        annualTotal: pricing.annualTotal,
        annualPerMonth: pricing.annualPerMonth
      };
    });

    return res.json({
      success: true,
      data: {
        doctorId,
        subscription,
        payments,
        plans,
        methods: OFFLINE_METHODS,
        bankInfo: getBankInstructions()
      }
    });
  }
);

// ---------------------------------------------------------------------------
// 3. POST /api/payments/offline — Doctor submits an offline payment + receipt
// ---------------------------------------------------------------------------
router.post(
  '/offline',
  verifyToken,
  requireRole('DOCTOR', 'PRATICIEN', 'SECRETARY', 'ADMIN', 'SUPER_ADMIN'),
  (req, res) => {
    const doctorId = resolveDoctorId(req);
    if (!doctorId) {
      return res.status(400).json({ success: false, message: 'Identifiant médecin introuvable.' });
    }

    const {
      planId,
      billingCycle = 'monthly',
      method,
      transactionRef = '',
      notes = '',
      receiptDataUri = null
    } = req.body || {};

    if (!planId || !SUBSCRIPTION_PLANS.some(p => p.id === planId)) {
      return res.status(400).json({ success: false, message: 'Formule d\'abonnement invalide.' });
    }
    if (!ALLOWED_CYCLES.has(billingCycle)) {
      return res.status(400).json({ success: false, message: 'Cycle de facturation invalide (monthly ou annual).' });
    }
    if (!method || !ALLOWED_METHOD_IDS.has(method)) {
      return res.status(400).json({ success: false, message: 'Méthode de paiement hors-ligne invalide.' });
    }

    const methodObj = OFFLINE_METHODS.find(m => m.id === method);
    const cleanTxRef = String(transactionRef || '').trim().slice(0, 120);
    if (methodObj?.requiresRef && !cleanTxRef && !receiptDataUri) {
      return res.status(400).json({
        success: false,
        message: 'Veuillez fournir le numéro de référence/transaction ou joindre le justificatif de paiement.'
      });
    }

    let receiptUrl = null;
    if (receiptDataUri) {
      try {
        receiptUrl = persistDataUri(receiptDataUri, 'receipts');
      } catch (err) {
        return res.status(400).json({ success: false, message: err.message });
      }
    }

    const pricing = calculateServerPlanPrice(planId, billingCycle);
    const doctor = db.findOne('doctors', d => String(d.id) === doctorId);
    const nowIso = new Date().toISOString();

    const payment = {
      id: `pay-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      referenceCode: generateReferenceCode(),
      doctorId,
      doctorName: doctor?.name || req.user?.name || 'Médecin',
      doctorEmail: doctor?.email || req.user?.email || '',
      planId: pricing.plan.id,
      planName: pricing.plan.name,
      billingCycle: pricing.billingCycle,
      amountTnd: pricing.amountTnd,
      method,
      transactionRef: cleanTxRef || null,
      receiptUrl,
      notes: String(notes || '').trim().slice(0, 500) || null,
      status: 'pending',
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      createdAt: nowIso
    };

    db.insert('offlinePayments', payment);

    // If doctor has no active subscription yet, record a pending subscription state
    const existingSub = db.findOne('doctorSubscriptions', s => String(s.doctorId) === doctorId);
    if (!existingSub) {
      db.insert('doctorSubscriptions', {
        id: `sub-${doctorId}`,
        doctorId,
        planId: pricing.plan.id,
        planName: pricing.plan.name,
        billingCycle: pricing.billingCycle,
        status: 'pending',
        startsAt: null,
        expiresAt: null,
        lastPaymentId: payment.id,
        updatedAt: nowIso
      });
    }

    // Notify Admins in real-time
    const notif = {
      id: `notif-pay-${Date.now()}`,
      type: 'OFFLINE_PAYMENT',
      title: 'Nouveau paiement hors-ligne à vérifier',
      message: `${payment.doctorName} a soumis un paiement de ${payment.amountTnd} TND (${payment.planName} — ${payment.referenceCode}).`,
      timestamp: nowIso,
      read: false
    };
    try {
      db.insert('notifications', notif);
    } catch (e) { /* non-blocking */ }

    const io = req.app.get('io');
    if (io) {
      io.to('admin').emit('payment:submitted', payment);
      io.to('admin').emit('notif:new', notif);
    }

    recordAudit(
      req,
      'OFFLINE_PAYMENT_SUBMITTED',
      `offline_payments/${payment.id}`,
      `Doctor ${payment.doctorName} (${doctorId}) submitted ${payment.amountTnd} TND via ${payment.method} (${payment.referenceCode})`
    );

    return res.status(201).json({
      success: true,
      message: 'Votre justificatif de paiement hors-ligne a été soumis et est en attente de validation.',
      data: payment
    });
  }
);

// ---------------------------------------------------------------------------
// 4. GET /api/payments/admin/list — Admin lists & filters all offline payments
// ---------------------------------------------------------------------------
router.get(
  '/admin/list',
  verifyToken,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  (req, res) => {
    const statusFilter = String(req.query.status || 'all').toLowerCase();
    const q = String(req.query.q || '').trim().toLowerCase();

    const allPayments = (db.get('offlinePayments') || []).slice().sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const summary = allPayments.reduce(
      (acc, p) => {
        const amt = Number(p.amountTnd) || 0;
        if (p.status === 'approved') {
          acc.approvedCount += 1;
          acc.approvedTotalTnd += amt;
        } else if (p.status === 'pending') {
          acc.pendingCount += 1;
          acc.pendingTotalTnd += amt;
        } else if (p.status === 'rejected') {
          acc.rejectedCount += 1;
        }
        return acc;
      },
      {
        approvedTotalTnd: 0,
        pendingTotalTnd: 0,
        pendingCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        totalCount: allPayments.length,
        activeSubscriptionsCount: 0
      }
    );

    const subscriptions = (db.get('doctorSubscriptions') || []).map(computeEffectiveSubscription);
    summary.activeSubscriptionsCount = subscriptions.filter(s => s.status === 'active').length;

    const filtered = allPayments.filter(p => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (q) {
        const hay = `${p.referenceCode} ${p.doctorName} ${p.doctorEmail} ${p.planName} ${p.transactionRef || ''} ${p.method}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    return res.json({
      success: true,
      data: {
        payments: filtered,
        subscriptions,
        summary
      }
    });
  }
);

// ---------------------------------------------------------------------------
// 5. PATCH /api/payments/admin/:id/approve — Admin approves & activates plan
// ---------------------------------------------------------------------------
router.patch(
  '/admin/:id/approve',
  verifyToken,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  (req, res) => {
    const { id } = req.params;
    const payment = db.findOne('offlinePayments', p => p.id === id);
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Paiement introuvable.' });
    }
    if (payment.status !== 'pending') {
      return res.status(409).json({
        success: false,
        message: `Ce paiement a déjà été traité (statut actuel : ${payment.status}).`
      });
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const durationDays = payment.billingCycle === 'annual' ? 365 : 30;

    // Activate or extend doctor subscription
    const existingSub = db.findOne('doctorSubscriptions', s => String(s.doctorId) === String(payment.doctorId));
    let baseStart = now;
    if (existingSub && existingSub.status === 'active' && existingSub.expiresAt) {
      const currentExp = new Date(existingSub.expiresAt);
      if (currentExp.getTime() > now.getTime()) {
        baseStart = currentExp;
      }
    }
    const newExpiresAt = new Date(baseStart.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();

    const updatedPayment = db.update(
      'offlinePayments',
      p => p.id === id,
      {
        status: 'approved',
        reviewedBy: req.user.email || req.user.name || 'admin',
        reviewedAt: nowIso,
        rejectionReason: null
      }
    );

    let updatedSub;
    if (existingSub) {
      updatedSub = db.update(
        'doctorSubscriptions',
        s => String(s.doctorId) === String(payment.doctorId),
        {
          planId: payment.planId,
          planName: payment.planName,
          billingCycle: payment.billingCycle,
          status: 'active',
          startsAt: existingSub.startsAt && existingSub.status === 'active' ? existingSub.startsAt : nowIso,
          expiresAt: newExpiresAt,
          lastPaymentId: payment.id,
          updatedAt: nowIso
        }
      );
    } else {
      updatedSub = db.insert('doctorSubscriptions', {
        id: `sub-${payment.doctorId}`,
        doctorId: payment.doctorId,
        planId: payment.planId,
        planName: payment.planName,
        billingCycle: payment.billingCycle,
        status: 'active',
        startsAt: nowIso,
        expiresAt: newExpiresAt,
        lastPaymentId: payment.id,
        updatedAt: nowIso
      });
    }

    const io = req.app.get('io');
    if (io) {
      const payload = {
        payment: updatedPayment,
        subscription: computeEffectiveSubscription(updatedSub)
      };
      io.to(`doctor:${payment.doctorId}`).emit('payment:updated', payload);
      io.to('admin').emit('payment:updated', payload);
    }

    recordAudit(
      req,
      'OFFLINE_PAYMENT_APPROVED',
      `offline_payments/${payment.id}`,
      `Approved ${payment.amountTnd} TND (${payment.referenceCode}) for doctor ${payment.doctorId} — active until ${newExpiresAt}`
    );

    return res.json({
      success: true,
      message: 'Paiement validé et abonnement médecin activé avec succès.',
      data: {
        payment: updatedPayment,
        subscription: computeEffectiveSubscription(updatedSub)
      }
    });
  }
);

// ---------------------------------------------------------------------------
// 6. PATCH /api/payments/admin/:id/reject — Admin rejects with reason
// ---------------------------------------------------------------------------
router.patch(
  '/admin/:id/reject',
  verifyToken,
  requireRole('ADMIN', 'SUPER_ADMIN'),
  (req, res) => {
    const { id } = req.params;
    const reason = String(req.body?.rejectionReason || req.body?.reason || '').trim().slice(0, 400);
    if (!reason) {
      return res.status(400).json({ success: false, message: 'Veuillez indiquer le motif du refus.' });
    }

    const payment = db.findOne('offlinePayments', p => p.id === id);
    if (!payment) {
      return res.status(404).json({ success: false, message: 'Paiement introuvable.' });
    }
    if (payment.status !== 'pending') {
      return res.status(409).json({
        success: false,
        message: `Ce paiement a déjà été traité (statut actuel : ${payment.status}).`
      });
    }

    const nowIso = new Date().toISOString();
    const updatedPayment = db.update(
      'offlinePayments',
      p => p.id === id,
      {
        status: 'rejected',
        reviewedBy: req.user.email || req.user.name || 'admin',
        reviewedAt: nowIso,
        rejectionReason: reason
      }
    );

    const existingSub = db.findOne('doctorSubscriptions', s => String(s.doctorId) === String(payment.doctorId));
    const io = req.app.get('io');
    if (io) {
      const payload = {
        payment: updatedPayment,
        subscription: computeEffectiveSubscription(existingSub)
      };
      io.to(`doctor:${payment.doctorId}`).emit('payment:updated', payload);
      io.to('admin').emit('payment:updated', payload);
    }

    recordAudit(
      req,
      'OFFLINE_PAYMENT_REJECTED',
      `offline_payments/${payment.id}`,
      `Rejected ${payment.referenceCode} for doctor ${payment.doctorId} — reason: ${reason}`
    );

    return res.json({
      success: true,
      message: 'Paiement refusé et médecin notifié.',
      data: {
        payment: updatedPayment,
        subscription: computeEffectiveSubscription(existingSub)
      }
    });
  }
);

// ---------------------------------------------------------------------------
// 7. GET /api/payments/:id/receipt — Protected receipt streaming (Owner or Admin)
// ---------------------------------------------------------------------------
router.get('/:id/receipt', verifyToken, (req, res) => {
  const payment = db.findOne('offlinePayments', p => p.id === req.params.id);
  if (!payment || !payment.receiptUrl) {
    return res.status(404).json({ success: false, message: 'Justificatif introuvable.' });
  }

  const isAdmin = req.user.role === 'ADMIN' || req.user.role === 'SUPER_ADMIN';
  const callerDoctorId = resolveDoctorId(req);
  if (!isAdmin && String(payment.doctorId) !== String(callerDoctorId)) {
    return res.status(403).json({ success: false, message: 'Accès refusé à ce justificatif.' });
  }

  const filename = path.basename(payment.receiptUrl);
  const filePath = resolveUploadPath('receipts', filename);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, message: 'Fichier justificatif introuvable sur le serveur.' });
  }

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  return res.sendFile(filePath);
});

router.SUBSCRIPTION_PLANS = SUBSCRIPTION_PLANS;
router.OFFLINE_METHODS = OFFLINE_METHODS;
router.calculateServerPlanPrice = calculateServerPlanPrice;
router.generateReferenceCode = generateReferenceCode;
router.computeEffectiveSubscription = computeEffectiveSubscription;

module.exports = router;
