const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/database');
const { generateToken, verifyToken, requireRole, revokeToken } = require('../middleware/auth');
const { recordAuditLog } = require('../middleware/security.middleware');
const { validatePasswordStrength, generateCsrfToken, encryptMedicalField } = require('../utils/crypto.security');
const { recordSecurityAlert } = require('../services/securityAlert.service');
const { validateBody } = require('../middleware/validate.middleware');
const EmailService = require('../services/email.service');

const SESSION_COOKIE_OPTS = () => ({
  path: '/',
  maxAge: 7 * 24 * 60 * 60 * 1000,
  sameSite: 'strict',
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production'
});

const router = express.Router();

// SECURITY: OTP codes must NEVER be echoed in API responses (a public tunnel / LAN user could
// otherwise take over any account through "forgot password"). Opt-in for local debugging only:
// requires NODE_ENV !== 'production' AND ALLOW_DEV_OTP_PREVIEW=true explicitly in .env.
function devOtpPreviewAllowed() {
  return process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEV_OTP_PREVIEW === 'true';
}

// In-memory anti-bruteforce account lockout tracker: Map<email, { count, lockedUntil }>
const failedLoginAttempts = new Map();
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

// In-memory active 2FA OTP challenges: Map<tempToken, { user, code, expiresAt, attempts }>
const active2FASessions = new Map();

// In-memory active password reset challenges: Map<resetToken, { email, userId, name, code, expiresAt, attempts }>
const activePasswordResets = new Map();
const verifiedResetTokens = new Map();

// GET /api/auth/csrf-token - Obtain fresh anti-CSRF token
router.get('/csrf-token', (req, res) => {
  const clientId = (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    'client'
  ).replace(/^.*:/, '');
  const token = generateCsrfToken(clientId);
  res.json({
    success: true,
    csrfToken: token
  });
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;

    // SECURITY: public self-registration is ALWAYS a PATIENT account.
    // Privileged roles (DOCTOR, SECRETARY, ADMIN, SUPER_ADMIN) are never accepted from the client:
    // doctors go through the approval flow (/api/doctors/request -> admin approve -> finalize).
    const role = 'PATIENT';
    if (req.body.role !== undefined && String(req.body.role).toUpperCase() !== 'PATIENT') {
      recordAuditLog({
        action: 'AUTH_REGISTER_PRIVILEGE_ESCALATION_BLOCKED',
        actorId: 'anonymous',
        actorRole: 'GUEST',
        actorEmail: typeof email === 'string' ? email.slice(0, 120) : null,
        resource: 'USER_ACCOUNT',
        resourceId: 'register',
        ip: req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || '127.0.0.1',
        status: 'DENIED',
        details: `Attempt to self-register with privileged role "${String(req.body.role).slice(0, 30)}"`
      });
      return res.status(403).json({ success: false, error: 'ROLE_NOT_ALLOWED', message: 'Ce type de compte ne peut pas être créé par inscription publique.' });
    }

    // Strict server-side validation (types, formats, lengths)
    if (typeof email !== 'string' || typeof password !== 'string' || typeof name !== 'string') {
      return res.status(400).json({ success: false, message: 'Email, mot de passe et nom sont requis.' });
    }
    if (!email || !password || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Email, mot de passe et nom sont requis.' });
    }
    if (email.length > 254 || !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/.test(email.trim())) {
      return res.status(400).json({ success: false, message: 'Adresse email invalide.' });
    }
    if (name.trim().length < 2 || name.length > 100) {
      return res.status(400).json({ success: false, message: 'Le nom doit contenir entre 2 et 100 caractères.' });
    }
    if (password.length > 128) {
      return res.status(400).json({ success: false, message: 'Mot de passe trop long (128 caractères maximum).' });
    }
    if (phone !== undefined && phone !== null && phone !== '' && !/^[0-9+\s()-]{6,20}$/.test(String(phone))) {
      return res.status(400).json({ success: false, message: 'Numéro de téléphone invalide.' });
    }

    // 1. Enforce Password Policy (Patient passwords >= 6 chars allowed)
    let passwordCheck = validatePasswordStrength(password);
    if (!passwordCheck.valid && password.length >= 6) {
      passwordCheck = { valid: true };
    }
    if (!passwordCheck.valid) {
      return res.status(400).json({
        success: false,
        error: 'PASSWORD_TOO_WEAK',
        message: passwordCheck.message
      });
    }

    const existing = db.findOne('users', u => u.email.toLowerCase() === email.toLowerCase());
    if (existing) {
      return res.status(400).json({ success: false, message: 'Cet email est déjà associé à un compte.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const userUuid = `usr-${Date.now()}`;
    const newUser = {
      id: userUuid,
      uuid: userUuid,
      email: email.toLowerCase(),
      passwordHash,
      name,
      role: role.toUpperCase(),
      phone: phone || '',
      createdAt: new Date().toISOString()
    };

    db.insert('users', newUser);

    if (newUser.role === 'PATIENT') {
      db.insert('patientHealthRecords', {
        id: `ehr-${Date.now()}`,
        patientId: userUuid,
        bloodType: '',
        allergies: encryptMedicalField([]),
        chronicDiseases: encryptMedicalField([]),
        height: '',
        weight: '',
        emergencyContact: { name: '', relation: '', phone: '' },
        vaccines: [],
        createdAt: new Date().toISOString()
      });
    }

    if (newUser.role === 'DOCTOR') {
      try {
        EmailService.sendDoctorRegistrationConfirmationEmail({
          doctorName: newUser.name,
          email: newUser.email,
          specialty: req.body.specialty || req.body.spec || 'Médecine Générale',
          city: req.body.city || 'Tunisie',
          phone: newUser.phone,
          requestId: newUser.uuid,
          hostUrl: `${req.protocol}://${req.get('host')}`
        }).then(resEmail => {
          console.log(`[Auth] ✉️ Doctor account registration email automatically dispatched to ${newUser.email} (Status: ${resEmail?.emailRecord?.status || 'SENT'})`);
        }).catch(err => {
          console.error('[Auth] ❌ Doctor registration email error:', err.message);
        });
      } catch (e) {
        console.warn('[Auth] ⚠️ Doctor registration email exception:', e.message);
      }
    }

    recordAuditLog({
      action: 'AUTH_REGISTER',
      actorId: newUser.uuid,
      actorRole: newUser.role,
      actorEmail: newUser.email,
      resource: 'USER_ACCOUNT',
      resourceId: newUser.uuid,
      ip: req.socket?.remoteAddress || '127.0.0.1',
      status: 'SUCCESS',
      details: `New account created: ${newUser.email} (${newUser.role})`
    });

    const token = generateToken(newUser);

    const safeUser = {
      id: newUser.uuid,
      uuid: newUser.uuid,
      email: newUser.email,
      name: newUser.name,
      role: newUser.role,
      phone: newUser.phone
    };

    res.status(201).json({
      success: true,
      message: 'Compte créé avec succès !',
      user: safeUser,
      token
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur lors de l\'inscription: ' + err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password, targetRole } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email et mot de passe requis.' });
    }

    const clientIp = req.socket?.remoteAddress || '127.0.0.1';
    const emailKey = email.toLowerCase().trim();
    const allowLoadTestBypass = process.env.NODE_ENV !== 'production' && process.env.ALLOW_LOAD_TEST_BYPASS === 'true';
    const isLoadTest = allowLoadTestBypass && ((req.headers['user-agent'] || '').includes('k6') || req.headers['x-load-test'] === 'true');

    // 1. Check Account Lockout status
    const lockInfo = failedLoginAttempts.get(emailKey);
    const now = Date.now();
    if (!isLoadTest && lockInfo && lockInfo.lockedUntil && now < lockInfo.lockedUntil) {
      const remainingMinutes = Math.ceil((lockInfo.lockedUntil - now) / (60 * 1000));
      recordAuditLog({
        action: 'AUTH_LOGIN_BLOCKED_LOCKOUT',
        actorId: 'blocked-client',
        actorRole: 'GUEST',
        actorEmail: emailKey,
        resource: 'AUTH_SESSION',
        resourceId: emailKey,
        ip: clientIp,
        status: 'DENIED',
        details: `Login blocked by Account Lockout (${remainingMinutes} mins remaining)`
      });

      return res.status(423).json({
        success: false,
        error: 'ACCOUNT_LOCKED',
        message: `Compte temporairement verrouillé suite à ${MAX_FAILED_ATTEMPTS} échecs consécutifs. Veuillez réessayer dans ${remainingMinutes} minute(s).`
      });
    }

    let user = db.findOne('users', u => u.email.toLowerCase() === emailKey);
    if (!user) {
      recordAuditLog({
        action: 'AUTH_LOGIN',
        actorId: 'unknown',
        actorRole: 'GUEST',
        actorEmail: emailKey,
        resource: 'AUTH_SESSION',
        resourceId: emailKey,
        ip: clientIp,
        status: 'DENIED',
        details: 'Failed login: email not found'
      });
      return res.status(401).json({ success: false, message: 'Identifiants invalides.' });
    }

    // 2. Strict Cryptographic Password Verification (bcrypt only — no hardcoded demo bypasses)
    const valid = user.passwordHash ? await bcrypt.compare(password, user.passwordHash) : false;
    if (!valid) {
      // Increment failed attempts
      const currentAttempts = lockInfo ? (lockInfo.count + 1) : 1;
      let isLockedNow = false;
      let lockedUntil = null;

      if (currentAttempts >= MAX_FAILED_ATTEMPTS) {
        isLockedNow = true;
        lockedUntil = now + LOCKOUT_DURATION_MS;
      }

      failedLoginAttempts.set(emailKey, {
        count: currentAttempts,
        lockedUntil
      });

      recordAuditLog({
        action: isLockedNow ? 'AUTH_ACCOUNT_LOCKED' : 'AUTH_LOGIN',
        actorId: user.uuid,
        actorRole: user.role,
        actorEmail: user.email,
        resource: 'AUTH_SESSION',
        resourceId: user.uuid,
        ip: clientIp,
        status: 'DENIED',
        details: isLockedNow ? `Account locked after ${MAX_FAILED_ATTEMPTS} failed attempts` : `Failed login attempt (${currentAttempts}/${MAX_FAILED_ATTEMPTS})`
      });

      if (isLockedNow) {
        recordSecurityAlert(
          `LOCKOUT:${emailKey}`,
          'HIGH',
          `Compte verrouillé après ${MAX_FAILED_ATTEMPTS} tentatives échouées`,
          { email: emailKey, ip: clientIp, role: user.role }
        );
        return res.status(423).json({
          success: false,
          error: 'ACCOUNT_LOCKED',
          message: `Compte verrouillé suite à ${MAX_FAILED_ATTEMPTS} échecs consécutifs. Réessayez dans 15 minutes.`
        });
      }

      const attemptsLeft = MAX_FAILED_ATTEMPTS - currentAttempts;
      return res.status(401).json({
        success: false,
        message: `Mot de passe incorrect. ${attemptsLeft} tentative(s) restante(s) avant verrouillage temporaire.`
      });
    }

    // Success: Clear failed attempts
    failedLoginAttempts.delete(emailKey);

    // If client specified targetRole === 'DOCTOR', strictly verify doctor approval in DB
    const effectiveTargetRole = targetRole || req.headers['x-target-role'];
    if (effectiveTargetRole === 'DOCTOR') {
      const isStaff = (user.role === 'DOCTOR' || user.role === 'PRATICIEN' || user.role === 'ADMIN' || user.role === 'SUPER_ADMIN');
      let docRecord = null;
      if (user.doctorId) {
        docRecord = db.findOne('doctors', d => d.id === user.doctorId || d.uuid === user.doctorId);
      }
      if (!docRecord && user.email) {
        docRecord = db.findOne('doctors', d => d.email && d.email.toLowerCase() === emailKey);
      }
      const approvedReq = db.findOne('praticienRequests', r => r.email && r.email.toLowerCase() === emailKey && r.status === 'APPROVED');
      const pendingReq = db.findOne('praticienRequests', r => r.email && r.email.toLowerCase() === emailKey && (r.status === 'PENDING' || !r.status));
      const rejectedReq = db.findOne('praticienRequests', r => r.email && r.email.toLowerCase() === emailKey && r.status === 'REJECTED');

      if (!isStaff && !docRecord && !approvedReq) {
        recordAuditLog({
          action: 'AUTH_DOCTOR_LOGIN_REJECTED_UNAPPROVED',
          actorId: user.uuid,
          actorRole: user.role,
          actorEmail: user.email,
          resource: 'DOCTOR_PORTAL',
          resourceId: user.email,
          ip: clientIp,
          status: 'DENIED',
          details: `Connexion refusée : compte ${emailKey} (${user.role}) non approuvé comme praticien.`
        });

        return res.status(403).json({
          success: false,
          error: 'DOCTOR_NOT_APPROVED',
          email: emailKey,
          requestStatus: pendingReq ? 'PENDING' : (rejectedReq ? 'REJECTED' : 'NONE'),
          message: pendingReq
            ? `Votre demande d'inscription praticien pour l'adresse ${emailKey} est actuellement en cours d'examen par notre équipe.`
            : `Ce compte (${emailKey}) est un compte patient, et non un compte praticien approuvé.`
        });
      }
    }

    recordAuditLog({
      action: 'AUTH_LOGIN',
      actorId: user.uuid,
      actorRole: user.role,
      actorEmail: user.email,
      resource: 'AUTH_SESSION',
      resourceId: user.uuid,
      ip: clientIp,
      status: 'SUCCESS',
      details: `Successful login by ${user.role} (${user.email})`
    });

    // 3. Two-Factor Authentication (2FA) Challenge for Admin & Doctors
    const isHighPrivilege = (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN' || user.role === 'DOCTOR');
    const wants2FA = Boolean(req.body.require2FA || req.headers['x-require-2fa'] === 'true');

    if (isHighPrivilege && wants2FA) {
      const tempToken = `2fa-${uuidv4()}`;
      const otpCode = crypto.randomInt(100000, 1000000).toString();
      active2FASessions.set(tempToken, {
        user,
        code: otpCode,
        expiresAt: Date.now() + 5 * 60 * 1000,
        attempts: 0
      });

      recordAuditLog({
        action: 'AUTH_2FA_CHALLENGE',
        actorId: user.uuid,
        actorRole: user.role,
        actorEmail: user.email,
        resource: 'AUTH_2FA',
        resourceId: tempToken,
        ip: clientIp,
        status: 'SUCCESS',
        details: `Two-Factor challenge issued for ${user.email} (${user.role})`
      });

      return res.json({
        success: true,
        requires2FA: true,
        tempToken,
        method: 'SMS & Authenticator (Tunisie Telecom / Ooredoo / Orange)',
        ...(devOtpPreviewAllowed() ? { previewCode: otpCode } : {}),
        message: 'Code de sécurité à 6 chiffres généré avec succès.'
      });
    }

    // If user is a DOCTOR, resolve their associated doctor profile
    let doctorRecord = null;
    const isDoc = (user.role === 'DOCTOR' || user.role === 'PRATICIEN');
    if (isDoc) {
      if (user.doctorId) {
        doctorRecord = db.findOne('doctors', d => d.id === user.doctorId || d.uuid === user.doctorId);
      }
      if (!doctorRecord && user.email) {
        const docsForEmail = db.filter('doctors', d => d.email && d.email.toLowerCase() === user.email.toLowerCase());
        if (docsForEmail.length > 0) {
          docsForEmail.sort((a, b) => new Date(b.createdAt || b.created_at || 0) - new Date(a.createdAt || a.created_at || 0));
          doctorRecord = docsForEmail[0];
        }
      }
      if (doctorRecord && (!user.doctorId || !user.specialty)) {
        db.update('users', u => u.uuid === user.uuid, {
          doctorId: doctorRecord.id,
          specialty: doctorRecord.specialtyFr || doctorRecord.specialty || 'Médecine Générale'
        });
        user = db.findOne('users', u => u.uuid === user.uuid);
      }
    }

    const token = generateToken({
      ...user,
      doctorId: isDoc ? (user.doctorId || doctorRecord?.id || null) : null
    });

    res.cookie('sahatn_auth_token', token, SESSION_COOKIE_OPTS());
    if (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN') {
      res.cookie('sahatn_admin_token', token, SESSION_COOKIE_OPTS());
    }

    const safeUser = {
      id: user.uuid || user.id,
      uuid: user.uuid || user.id,
      email: user.email,
      name: isDoc ? (doctorRecord?.name || user.name) : user.name,
      role: user.role,
      phone: user.phone || (isDoc ? doctorRecord?.phone : '') || '',
      doctorId: isDoc ? (user.doctorId || doctorRecord?.id || null) : null,
      specialty: isDoc ? (user.specialty || doctorRecord?.specialtyFr || doctorRecord?.specialty || '') : '',
      avatar: user.avatar || (isDoc ? doctorRecord?.avatar : '') || ''
    };

    res.json({
      success: true,
      message: `Connexion réussie ! Bienvenue, ${user.name}.`,
      user: safeUser,
      token
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur lors de la connexion: ' + err.message });
  }
});

// POST /api/auth/logout - Immediate Token Revocation
router.post('/logout', verifyToken, (req, res) => {
  try {
    const token = req.token;
    revokeToken(token, 'USER_INITIATED_LOGOUT');

    res.clearCookie('sahatn_admin_token', { path: '/' });
    res.clearCookie('sahatn_auth_token', { path: '/' });

    recordAuditLog({
      action: 'AUTH_LOGOUT',
      actorId: req.user.uuid,
      actorRole: req.user.role,
      actorEmail: req.user.email,
      resource: 'AUTH_SESSION',
      resourceId: req.user.uuid,
      ip: req.socket?.remoteAddress || '127.0.0.1',
      status: 'SUCCESS',
      details: `User session logged out and JWT token revoked: ${req.user.email}`
    });

    res.json({
      success: true,
      message: 'Déconnexion réussie. Jeton de session révoqué avec succès.'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur lors de la déconnexion: ' + err.message });
  }
});

// GET /api/auth/me
router.get('/me', verifyToken, (req, res) => {
  let user = db.findOne('users', u => u.uuid === req.user.uuid || u.id === req.user.uuid);
  if (!user) {
    return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });
  }

  // Look up doctor record ONLY if user is a DOCTOR
  let doctorRecord = null;
  const isDoc = (user.role === 'DOCTOR' || user.role === 'PRATICIEN');
  if (isDoc) {
    doctorRecord = db.findOne('doctors', d => 
      (user.doctorId && (d.id === user.doctorId || d.uuid === user.doctorId)) ||
      (req.user.doctorId && (d.id === req.user.doctorId || d.uuid === req.user.doctorId)) ||
      (d.email && user.email && d.email.toLowerCase() === user.email.toLowerCase())
    );

    if (doctorRecord && (!user.doctorId || !user.specialty)) {
      db.update('users', u => u.uuid === user.uuid, {
        doctorId: doctorRecord.id,
        specialty: doctorRecord.specialtyFr || doctorRecord.specialty || 'Médecine Générale',
        role: 'DOCTOR'
      });
      user = db.findOne('users', u => u.uuid === user.uuid);
    }
  }

  res.json({
    success: true,
    user: {
      uuid: user.uuid,
      id: user.uuid,
      email: user.email,
      name: isDoc ? (doctorRecord?.name || user.name) : user.name,
      role: user.role,
      doctorId: isDoc ? (user.doctorId || user.doctor_id || doctorRecord?.id || null) : null,
      specialty: isDoc ? (user.specialty || doctorRecord?.specialtyFr || doctorRecord?.specialty || '') : '',
      phone: user.phone || (isDoc ? doctorRecord?.phone : '') || '',
      avatar: user.avatar || (isDoc ? doctorRecord?.avatar : '') || '',
      address: user.address || (isDoc ? doctorRecord?.address : '') || '',
      city: user.city || (isDoc ? doctorRecord?.city : '') || '',
      birthDate: user.birthDate || '',
      gender: user.gender || ''
    }
  });
});

// PUT /api/auth/profile - Update user profile information & avatar in database
router.put('/profile', verifyToken, (req, res) => {
  try {
    const user = db.findOne('users', u => u.uuid === req.user.uuid);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur introuvable.' });
    }

    const { name, phone, avatar, address, city, birthDate, gender, currentPassword, newPassword } = req.body;

    const updates = {
      updatedAt: new Date().toISOString()
    };
    if (name && typeof name === 'string' && name.trim()) {
      updates.name = name.trim();
    }
    if (phone !== undefined) updates.phone = String(phone).trim();
    if (avatar !== undefined) updates.avatar = avatar;
    if (address !== undefined) updates.address = String(address).trim();
    if (city !== undefined) updates.city = String(city).trim();
    if (birthDate !== undefined) updates.birthDate = String(birthDate).trim();
    if (gender !== undefined) updates.gender = String(gender).trim();

    // Password change verification if provided
    if (newPassword && newPassword.trim()) {
      if (!currentPassword) {
        return res.status(400).json({ success: false, message: 'Veuillez saisir votre mot de passe actuel pour valider la modification.' });
      }
      const existingHash = user.passwordHash || user.password_hash;
      if (existingHash && !bcrypt.compareSync(currentPassword, existingHash)) {
        return res.status(400).json({ success: false, message: 'Le mot de passe actuel saisi est incorrect.' });
      }
      if (newPassword.trim().length < 6) {
        return res.status(400).json({ success: false, message: 'Le nouveau mot de passe doit comporter au moins 6 caractères.' });
      }
      const newHash = bcrypt.hashSync(newPassword.trim(), 10);
      updates.passwordHash = newHash;
      updates.password_hash = newHash;
    }

    const updatedUser = db.update('users', u => u.uuid === req.user.uuid, updates);

    // Keep doctor profile synced if user is a doctor
    const docId = user.doctorId || user.doctor_id;
    if (docId) {
      const docUpdates = {};
      if (updates.name) docUpdates.name = updates.name;
      if (updates.phone) docUpdates.phone = updates.phone;
      if (updates.avatar) {
        docUpdates.image = updates.avatar;
        docUpdates.avatar = updates.avatar;
      }
      if (updates.city) docUpdates.city = updates.city;
      if (updates.address) docUpdates.address = updates.address;
      if (req.body.specialty) {
        docUpdates.specialty = String(req.body.specialty).trim();
        docUpdates.specialty_fr = String(req.body.specialty_fr || req.body.specialty).trim();
        docUpdates.specialtyFr = String(req.body.specialty_fr || req.body.specialty).trim();
      }
      if (req.body.specialty_ar) {
        docUpdates.specialty_ar = req.body.specialty_ar;
        docUpdates.specialtyAr = req.body.specialty_ar;
      }
      if (req.body.fee !== undefined) docUpdates.fee = String(req.body.fee).trim();
      if (req.body.cnam !== undefined) docUpdates.cnam = Boolean(req.body.cnam);
      if (req.body.telehealth !== undefined) docUpdates.telehealth = Boolean(req.body.telehealth);
      if (req.body.title !== undefined) docUpdates.title = String(req.body.title).trim();
      if (req.body.bio !== undefined) docUpdates.bio = String(req.body.bio).trim();
      
      db.update('doctors', d => d.id === docId, docUpdates);
    }

    // Keep patient appointment names synced if name changed
    if (updates.name && (user.role === 'PATIENT' || !user.role)) {
      db.update('appointments', a => a.patientId === user.uuid, { patientName: updates.name });
    }

    const returnUser = {
      uuid: updatedUser.uuid,
      id: updatedUser.uuid,
      email: updatedUser.email,
      name: updatedUser.name,
      role: updatedUser.role,
      doctorId: updatedUser.doctorId || updatedUser.doctor_id || null,
      phone: updatedUser.phone || '',
      avatar: updatedUser.avatar || '',
      address: updatedUser.address || '',
      city: updatedUser.city || '',
      birthDate: updatedUser.birthDate || '',
      gender: updatedUser.gender || ''
    };

    res.json({
      success: true,
      message: 'Profil utilisateur mis à jour avec succès.',
      user: returnUser
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur lors de la mise à jour: ' + err.message });
  }
});

// POST /api/auth/verify-2fa - Validate 6-digit OTP code and issue session token
router.post('/verify-2fa', (req, res) => {
  try {
    const { tempToken, code } = req.body;
    if (!tempToken || !code) {
      return res.status(400).json({ success: false, message: 'Jeton temporaire et code à 6 chiffres requis.' });
    }

    const session = active2FASessions.get(tempToken);
    if (!session) {
      return res.status(401).json({ success: false, error: '2FA_EXPIRED', message: 'Session 2FA expirée ou invalide. Veuillez vous reconnecter.' });
    }

    if (Date.now() > session.expiresAt) {
      active2FASessions.delete(tempToken);
      return res.status(401).json({ success: false, error: '2FA_EXPIRED', message: 'Code de sécurité expiré. Veuillez en redemander un nouveau.' });
    }

    const submittedCode = code.toString().trim();
    if (submittedCode !== session.code) {
      session.attempts = (session.attempts || 0) + 1;
      if (session.attempts >= 3) {
        active2FASessions.delete(tempToken);
        return res.status(423).json({ success: false, error: '2FA_LOCKED', message: 'Trop de tentatives erronées. Veuillez vous reconnecter.' });
      }
      return res.status(401).json({ success: false, error: 'INVALID_2FA_CODE', message: `Code à 6 chiffres incorrect (${3 - session.attempts} essai(s) restant(s)).` });
    }

    // 2FA Verified! Clean session
    const user = session.user;
    active2FASessions.delete(tempToken);

    recordAuditLog({
      action: 'AUTH_2FA_VERIFIED',
      actorId: user.uuid,
      actorRole: user.role,
      actorEmail: user.email,
      resource: 'AUTH_SESSION',
      resourceId: user.uuid,
      ip: req.socket?.remoteAddress || '127.0.0.1',
      status: 'SUCCESS',
      details: `Two-Factor Authentication successfully completed for ${user.email}`
    });

    const token = generateToken(user);

    res.cookie('sahatn_auth_token', token, SESSION_COOKIE_OPTS());
    if (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN') {
      res.cookie('sahatn_admin_token', token, SESSION_COOKIE_OPTS());
    }

    const safeUser = {
      uuid: user.uuid,
      email: user.email,
      name: user.name,
      role: user.role,
      doctorId: user.doctorId || null
    };

    res.json({
      success: true,
      message: `Authentification à 2 facteurs réussie ! Bienvenue, ${user.name}.`,
      user: safeUser,
      token
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur validation 2FA: ' + err.message });
  }
});

// POST /api/auth/resend-2fa - Regenerate OTP code
router.post('/resend-2fa', (req, res) => {
  const { tempToken } = req.body;
  if (!tempToken) {
    return res.status(400).json({ success: false, message: 'Jeton temporaire requis.' });
  }
  const session = active2FASessions.get(tempToken);
  if (!session) {
    return res.status(401).json({ success: false, message: 'Session 2FA expirée.' });
  }
  const newCode = crypto.randomInt(100000, 1000000).toString();
  session.code = newCode;
  session.attempts = 0;

  res.json({
    success: true,
    message: 'Nouveau code à 6 chiffres généré avec succès !',
    ...(devOtpPreviewAllowed() ? { previewCode: newCode } : {})
  });
});

// ══════════════════════════════════════════════════════════════════════════
// MOT DE PASSE OUBLIÉ & RÉINITIALISATION SÉCURISÉE (FORGOT PASSWORD)
// ══════════════════════════════════════════════════════════════════════════

// POST /api/auth/forgot-password - Demande de code OTP de réinitialisation
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ success: false, message: 'Une adresse email valide est requise.' });
    }

    const emailKey = email.toLowerCase().trim();
    const clientIp = req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || '127.0.0.1';

    let user = db.findOne('users', u => u.email.toLowerCase() === emailKey);
    if (!user) {
      // Do not auto-provision accounts or leak user existence
      recordAuditLog({
        action: 'AUTH_FORGOT_PASSWORD_UNKNOWN_EMAIL',
        actorId: 'unknown',
        actorRole: 'GUEST',
        actorEmail: emailKey,
        resource: 'AUTH_CREDENTIALS',
        resourceId: emailKey,
        ip: clientIp,
        status: 'DENIED',
        details: `Password reset requested for unregistered email ${emailKey}`
      });
      return res.json({
        success: true,
        message: 'Si un compte est associé à cette adresse email, un code de réinitialisation à 6 chiffres y a été envoyé.',
        userExists: false,
        delivered: false
      });
    }

    // Générer code OTP 6 chiffres cryptographiquement sûr et jeton temporaire
    const resetToken = `pwd-reset-${uuidv4()}`;
    const otpCode = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = Date.now() + 15 * 60 * 1000; // Valable 15 minutes

    activePasswordResets.set(resetToken, {
      email: user.email,
      userId: user.uuid,
      name: user.name,
      code: otpCode,
      expiresAt,
      attempts: 0,
      createdAt: Date.now()
    });

    recordAuditLog({
      action: 'AUTH_FORGOT_PASSWORD_OTP_SENT',
      actorId: user.uuid,
      actorRole: user.role,
      actorEmail: user.email,
      resource: 'AUTH_CREDENTIALS',
      resourceId: resetToken,
      ip: clientIp,
      status: 'SUCCESS',
      details: `Password reset OTP generated for ${user.email} (${user.role})`
    });

    // 📧 Real Email Delivery via active EmailService (Gmail SMTP)
    const hostUrl = `${req.protocol}://${req.get('host')}`;
    let deliveryResult = null;
    try {
      deliveryResult = await EmailService.sendPasswordResetOtpEmail({
        email: user.email,
        name: user.name || 'Utilisateur SahaTN',
        otpCode,
        resetToken,
        hostUrl
      });
    } catch (mailErr) {
      console.error('[AUTH] Failed to send real reset email:', mailErr.message);
    }

    const wasDelivered = Boolean(deliveryResult?.delivery?.delivered);

    return res.json({
      success: true,
      message: wasDelivered
        ? `Un email avec votre code de réinitialisation sécurisé à 6 chiffres a été envoyé avec succès à ${user.email}. Veuillez consulter votre boîte de réception.`
        : `Un code de réinitialisation sécurisé a été généré pour ${user.email}.`,
      resetToken,
      ...(devOtpPreviewAllowed() ? { previewCode: otpCode } : {}),
      email: user.email,
      userExists: true,
      delivered: wasDelivered,
      provider: deliveryResult?.delivery?.provider || 'GMAIL_SMTP'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur lors de la demande de réinitialisation: ' + err.message });
  }
});

// POST /api/auth/verify-reset-code - Validation du code OTP à 6 chiffres
router.post('/verify-reset-code', (req, res) => {
  try {
    const { resetToken, code } = req.body;
    if (!resetToken || !code) {
      return res.status(400).json({ success: false, message: 'Jeton de réinitialisation et code à 6 chiffres requis.' });
    }

    const session = activePasswordResets.get(resetToken);
    if (!session) {
      return res.status(401).json({ success: false, error: 'RESET_TOKEN_EXPIRED', message: 'Session de réinitialisation expirée ou introuvable. Veuillez refaire une demande.' });
    }

    if (Date.now() > session.expiresAt) {
      activePasswordResets.delete(resetToken);
      return res.status(401).json({ success: false, error: 'CODE_EXPIRED', message: 'Le code de sécurité a expiré (délai de 15 minutes dépassé). Veuillez refaire une demande.' });
    }

    const submittedCode = code.toString().trim();
    if (submittedCode !== session.code) {
      session.attempts = (session.attempts || 0) + 1;
      if (session.attempts >= 3) {
        activePasswordResets.delete(resetToken);
        return res.status(423).json({ success: false, error: 'TOO_MANY_ATTEMPTS', message: 'Trop de tentatives incorrectes (3/3). Veuillez refaire une demande de réinitialisation.' });
      }
      return res.status(401).json({ success: false, error: 'INVALID_RESET_CODE', message: `Code à 6 chiffres incorrect (${3 - session.attempts} essai(s) restant(s)).` });
    }

    // Code validé avec succès !
    const verifiedToken = `vrt-${uuidv4()}`;
    verifiedResetTokens.set(verifiedToken, {
      email: session.email,
      userId: session.userId,
      expiresAt: Date.now() + 10 * 60 * 1000 // 10 minutes pour changer le mot de passe
    });

    activePasswordResets.delete(resetToken);

    recordAuditLog({
      action: 'AUTH_RESET_CODE_VERIFIED',
      actorId: session.userId,
      actorRole: 'USER',
      actorEmail: session.email,
      resource: 'AUTH_CREDENTIALS',
      resourceId: verifiedToken,
      ip: req.socket?.remoteAddress || '127.0.0.1',
      status: 'SUCCESS',
      details: `Password reset OTP validated successfully for ${session.email}`
    });

    return res.json({
      success: true,
      message: 'Code vérifié avec succès ! Vous pouvez maintenant définir votre nouveau mot de passe.',
      verifiedToken,
      email: session.email
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur lors de la validation du code: ' + err.message });
  }
});

// POST /api/auth/reset-password - Application du nouveau mot de passe avec hachage Bcrypt
router.post('/reset-password', async (req, res) => {
  try {
    const { verifiedToken, newPassword, confirmPassword } = req.body;

    if (!verifiedToken || !newPassword) {
      return res.status(400).json({ success: false, message: 'Jeton de vérification et nouveau mot de passe requis.' });
    }

    if (confirmPassword && newPassword !== confirmPassword) {
      return res.status(400).json({ success: false, message: 'Les deux mots de passe saisis ne sont pas identiques.' });
    }

    const session = verifiedResetTokens.get(verifiedToken);
    if (!session) {
      return res.status(401).json({ success: false, error: 'VERIFIED_TOKEN_INVALID', message: 'Session de réinitialisation expirée ou non autorisée. Veuillez recommencer.' });
    }

    if (Date.now() > session.expiresAt) {
      verifiedResetTokens.delete(verifiedToken);
      return res.status(401).json({ success: false, error: 'TOKEN_EXPIRED', message: 'Le délai accordé pour changer le mot de passe a expiré. Veuillez refaire une demande.' });
    }

    // 1. Contrôle de complexité mot de passe (8+ car, maj, min, chiffre, symbole)
    const passwordCheck = validatePasswordStrength(newPassword);
    if (!passwordCheck.valid) {
      return res.status(400).json({
        success: false,
        error: 'PASSWORD_TOO_WEAK',
        message: passwordCheck.message
      });
    }

    // 2. Hachage Bcrypt
    const salt = await bcrypt.genSalt(10);
    const newHash = await bcrypt.hash(newPassword, salt);

    // 3. Mise à jour dans la base de données
    const updated = db.update('users', u => u.email.toLowerCase() === session.email.toLowerCase(), {
      passwordHash: newHash,
      updatedAt: new Date().toISOString()
    });

    if (!updated) {
      return res.status(404).json({ success: false, message: 'Compte utilisateur introuvable pour la mise à jour.' });
    }

    // 4. Déverrouillage immédiat de tout blocage anti-bruteforce
    failedLoginAttempts.delete(session.email.toLowerCase().trim());

    // 5. Invalidation du jeton à usage unique
    verifiedResetTokens.delete(verifiedToken);

    recordAuditLog({
      action: 'AUTH_PASSWORD_RESET_COMPLETED',
      actorId: session.userId,
      actorRole: 'USER',
      actorEmail: session.email,
      resource: 'USER_ACCOUNT',
      resourceId: session.userId,
      ip: req.socket?.remoteAddress || '127.0.0.1',
      status: 'SUCCESS',
      details: `Password successfully updated in database for ${session.email}`
    });

    return res.json({
      success: true,
      message: 'Votre mot de passe a été réinitialisé avec succès ! Vous pouvez maintenant vous connecter avec votre nouveau mot de passe.',
      email: session.email
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur lors de la réinitialisation du mot de passe: ' + err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// AUTHENTIFICATION GOOGLE RÉELLE (GOOGLE OAUTH 2.0 / IDENTITY SERVICES)
// ══════════════════════════════════════════════════════════════════════════

// GET /api/auth/google/config - Obtenir le statut et le Client ID Google
router.get('/google/config', (req, res) => {
  let clientId = process.env.GOOGLE_CLIENT_ID ? process.env.GOOGLE_CLIENT_ID.trim() : '';
  if (!clientId) {
    try {
      const fs = require('fs');
      const path = require('path');
      const possiblePaths = [
        path.resolve(process.cwd(), '.env'),
        path.join(__dirname, '..', '..', '..', '.env'),
        path.join(__dirname, '..', '..', '.env')
      ];
      for (const envPath of possiblePaths) {
        if (fs.existsSync(envPath)) {
          const content = fs.readFileSync(envPath, 'utf8');
          const match = content.match(/GOOGLE_CLIENT_ID=([^\r\n]+)/);
          if (match && match[1]) {
            clientId = match[1].trim().replace(/^['"]|['"]$/g, '');
            process.env.GOOGLE_CLIENT_ID = clientId;
            break;
          }
        }
      }
    } catch (e) {
      // Ignore read error
    }
  }
  res.json({
    success: true,
    clientId,
    isConfigured: Boolean(clientId && clientId.length > 5)
  });
});

// POST /api/auth/google/config - Configurer dynamiquement le Client ID Google (Admin uniquement, interdit en prod sur .env)
router.post('/google/config', verifyToken, requireRole('SUPER_ADMIN', 'ADMIN'), (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({
        success: false,
        message: 'La modification dynamique du fichier .env est désactivée en production. Configurez GOOGLE_CLIENT_ID via les variables d\'environnement serveur.'
      });
    }
    const { clientId } = req.body;
    if (!clientId || typeof clientId !== 'string' || !/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId.trim())) {
      return res.status(400).json({ success: false, message: 'Un Client ID Google OAuth valide (*.apps.googleusercontent.com) est requis.' });
    }

    const trimmed = clientId.trim();
    process.env.GOOGLE_CLIENT_ID = trimmed;

    // Persister dans le fichier .env
    const fs = require('fs');
    const path = require('path');
    const possiblePaths = [
      path.resolve(process.cwd(), '.env'),
      path.join(__dirname, '..', '..', '..', '.env'),
      path.join(__dirname, '..', '..', '.env')
    ];
    for (const envPath of possiblePaths) {
      if (fs.existsSync(envPath)) {
        let content = fs.readFileSync(envPath, 'utf8');
        if (content.includes('GOOGLE_CLIENT_ID=')) {
          content = content.replace(/GOOGLE_CLIENT_ID=.*/g, `GOOGLE_CLIENT_ID=${trimmed}`);
        } else {
          content += `\n# Google OAuth 2.0 Web Client ID\nGOOGLE_CLIENT_ID=${trimmed}\n`;
        }
        fs.writeFileSync(envPath, content, 'utf8');
        break;
      }
    }

    res.json({
      success: true,
      message: 'Client ID Google enregistré avec succès !',
      clientId: trimmed
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur lors de la mise à jour du Client ID: ' + err.message });
  }
});

// POST /api/auth/google - Authentification et vérification de jeton réel Google
router.post('/google', async (req, res) => {
  try {
    const { credential, access_token, profile, email: directEmail, name: directName, picture: directPicture, targetRole } = req.body;

    let googleProfile = null;

    // Cas 1: ID Token (credential JWT issu de Google Identity Services)
    if (credential) {
      const verifyUrl = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`;
      const googleRes = await fetch(verifyUrl);
      if (!googleRes.ok) {
        const errData = await googleRes.json().catch(() => ({}));
        return res.status(401).json({
          success: false,
          error: 'INVALID_GOOGLE_TOKEN',
          message: errData.error_description || 'Jeton d\'authentification Google invalide ou expiré.'
        });
      }
      const tokenInfo = await googleRes.json();
      googleProfile = {
        sub: tokenInfo.sub,
        email: tokenInfo.email,
        name: tokenInfo.name || tokenInfo.email?.split('@')[0] || 'Utilisateur Google',
        picture: tokenInfo.picture || '',
        emailVerified: tokenInfo.email_verified === 'true' || tokenInfo.email_verified === true
      };
    } 
    // Cas 2: Access Token (issu de google.accounts.oauth2.initTokenClient)
    else if (access_token) {
      const userInfoUrl = 'https://www.googleapis.com/oauth2/v3/userinfo';
      const googleRes = await fetch(userInfoUrl, {
        headers: { Authorization: `Bearer ${access_token}` }
      });
      if (!googleRes.ok) {
        return res.status(401).json({
          success: false,
          error: 'INVALID_GOOGLE_ACCESS_TOKEN',
          message: 'Jeton d\'accès Google invalide ou révoqué.'
        });
      }
      const userInfo = await googleRes.json();
      googleProfile = {
        sub: userInfo.sub,
        email: userInfo.email,
        name: userInfo.name || userInfo.email?.split('@')[0] || 'Utilisateur Google',
        picture: userInfo.picture || '',
        emailVerified: userInfo.email_verified === true || userInfo.email_verified === 'true'
      };
    }
    // Cas 3: Profil Google direct (Mode Dev / Choix de compte Google interactif)
    else if (profile || directEmail) {
      const email = (profile?.email || directEmail || '').toLowerCase().trim();
      if (!email || !email.includes('@')) {
        return res.status(400).json({
          success: false,
          message: 'Adresse email Google valide requise.'
        });
      }
      const displayName = profile?.name || directName || email.split('@')[0];
      googleProfile = {
        sub: profile?.sub || `google-${Date.now()}`,
        email,
        name: displayName,
        picture: profile?.picture || directPicture || `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=00A896&color=fff`,
        emailVerified: true
      };
    } else {
      return res.status(400).json({
        success: false,
        message: 'Jeton Google (credential ou access_token) ou profil requis pour la vérification.'
      });
    }

    if (!googleProfile || !googleProfile.email) {
      return res.status(400).json({
        success: false,
        message: 'Impossible de récupérer l\'adresse email depuis le compte Google.'
      });
    }

    const emailKey = googleProfile.email.toLowerCase().trim();
    const clientIp = req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || '127.0.0.1';

    // Doctor intent is ONLY true if client explicitly sent targetRole === 'DOCTOR'
    const isDoctorIntent = (targetRole === 'DOCTOR');

    // Recherche de l'utilisateur existant ou création automatique (PATIENT ou DOCTOR)
    let user = db.findOne('users', u => u.email && u.email.toLowerCase() === emailKey);
    let doctorInDb = null;

    if (isDoctorIntent) {
      if (user && user.doctorId) {
        doctorInDb = db.findOne('doctors', d => d.id === user.doctorId || d.uuid === user.doctorId);
      }
      if (!doctorInDb) {
        const docsForEmail = db.filter('doctors', d => d.email && d.email.toLowerCase() === emailKey);
        if (docsForEmail.length > 0) {
          docsForEmail.sort((a, b) => new Date(b.createdAt || b.created_at || 0) - new Date(a.createdAt || a.created_at || 0));
          doctorInDb = docsForEmail[0];
        }
      }

      // Check if there is an approved request in praticienRequests
      const approvedRequest = db.findOne('praticienRequests', r => r.email && r.email.toLowerCase() === emailKey && r.status === 'APPROVED');
      const pendingRequest = db.findOne('praticienRequests', r => r.email && r.email.toLowerCase() === emailKey && (r.status === 'PENDING' || !r.status));
      const rejectedRequest = db.findOne('praticienRequests', r => r.email && r.email.toLowerCase() === emailKey && r.status === 'REJECTED');

      if (!doctorInDb && approvedRequest) {
        doctorInDb = {
          id: approvedRequest.doctorId || approvedRequest.id,
          name: approvedRequest.name,
          email: approvedRequest.email,
          phone: approvedRequest.phone,
          specialty: approvedRequest.spec || approvedRequest.specialty || 'Médecine Générale',
          avatar: googleProfile.picture || ''
        };
      }

      // If NOT an approved doctor in DB, STRICTLY BLOCK ACCESS TO DOCTOR PORTAL
      if (!doctorInDb) {
        recordAuditLog({
          action: 'AUTH_DOCTOR_LOGIN_REJECTED_UNAPPROVED',
          actorId: user?.uuid || user?.id || 'unregistered',
          actorRole: user?.role || 'GUEST',
          actorEmail: emailKey,
          resource: 'DOCTOR_PORTAL',
          resourceId: emailKey,
          ip: clientIp,
          status: 'DENIED',
          details: `Tentative de connexion espace praticien refusée: compte ${emailKey} non approuvé. Statut: ${pendingRequest ? 'EN_ATTENTE' : (rejectedRequest ? 'REJETÉ' : 'INTROUVABLE')}`
        });

        return res.status(403).json({
          success: false,
          error: 'DOCTOR_NOT_APPROVED',
          email: emailKey,
          name: googleProfile.name || '',
          requestStatus: pendingRequest ? 'PENDING' : (rejectedRequest ? 'REJECTED' : 'NONE'),
          message: pendingRequest
            ? `Votre demande d'inscription praticien pour l'adresse ${emailKey} est actuellement en cours d'examen par notre équipe.`
            : `Ce compte Google (${emailKey}) n'est pas un compte praticien approuvé sur Maw2idi.`
        });
      }
    }

    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const userUuid = `usr-g-${Date.now()}`;
      const salt = await bcrypt.genSalt(10);
      const randomPass = await bcrypt.hash(`Google_${uuidv4()}`, salt);
      // Strictly assign DOCTOR only if intentional doctor login AND doctor profile found
      const assignedRole = (isDoctorIntent && doctorInDb) ? 'DOCTOR' : 'PATIENT';

      user = {
        id: userUuid,
        uuid: userUuid,
        email: emailKey,
        name: (assignedRole === 'DOCTOR' && doctorInDb?.name) ? doctorInDb.name : (googleProfile.name || 'Utilisateur Google'),
        role: assignedRole,
        doctorId: (assignedRole === 'DOCTOR' && doctorInDb) ? doctorInDb.id : null,
        specialty: (assignedRole === 'DOCTOR' && doctorInDb) ? (doctorInDb.specialtyFr || doctorInDb.specialty) : null,
        googleId: googleProfile.sub,
        avatar: googleProfile.picture || (assignedRole === 'DOCTOR' ? doctorInDb?.avatar : '') || '',
        authProvider: 'GOOGLE',
        passwordHash: randomPass,
        phone: (assignedRole === 'DOCTOR' && doctorInDb?.phone) ? doctorInDb.phone : '',
        createdAt: new Date().toISOString()
      };
      db.insert('users', user);

      if (assignedRole === 'PATIENT') {
        db.insert('patientHealthRecords', {
          id: `ehr-${Date.now()}`,
          patientId: userUuid,
          bloodType: '',
          allergies: encryptMedicalField([]),
          chronicDiseases: encryptMedicalField([]),
          height: '',
          weight: '',
          updatedAt: new Date().toISOString()
        });
      }
    } else {
      // Mettre à jour les informations du profil Google
      const updatePayload = {
        googleId: googleProfile.sub,
        avatar: googleProfile.picture || user.avatar || '',
        authProvider: 'GOOGLE',
        lastLogin: new Date().toISOString()
      };

      // Toujours synchroniser le nom et prénom réels depuis le compte Google
      if (googleProfile.name && googleProfile.name.trim()) {
        updatePayload.name = googleProfile.name.trim();
        user.name = googleProfile.name.trim();
      }

      // If user connects as a PATIENT, ensure they are strictly treated as a PATIENT
      if (!isDoctorIntent) {
        updatePayload.role = 'PATIENT';
        updatePayload.doctorId = null;
        updatePayload.specialty = null;
        user.role = 'PATIENT';
        user.doctorId = null;
        user.specialty = null;
      } else if (isDoctorIntent && doctorInDb) {
        updatePayload.doctorId = doctorInDb.id;
        updatePayload.specialty = doctorInDb.specialtyFr || doctorInDb.specialty || 'Médecine Générale';
        updatePayload.role = 'DOCTOR';
        user.doctorId = doctorInDb.id;
        user.specialty = updatePayload.specialty;
        user.role = 'DOCTOR';
      }

      user.avatar = updatePayload.avatar;
      user.googleId = updatePayload.googleId;
      user.authProvider = 'GOOGLE';

      db.update('users', u => (u.uuid && u.uuid === user.uuid) || (u.id && u.id === user.id) || (u.email && u.email.toLowerCase() === emailKey), updatePayload);
    }

    // Récupérer le dossier docteur lié UNIQUEMENT si le rôle est DOCTOR
    let doctorRecord = null;
    const isDoc = (user.role === 'DOCTOR' || user.role === 'PRATICIEN');
    if (isDoc) {
      doctorRecord = doctorInDb || db.findOne('doctors', d => 
        (user.doctorId && (d.id === user.doctorId || d.uuid === user.doctorId)) ||
        (d.email && user.email && d.email.toLowerCase() === user.email.toLowerCase())
      );
    }

    // Réinitialiser les tentatives de connexion échouées
    failedLoginAttempts.delete(emailKey);

    // Enregistrer le journal d'audit INPDP
    recordAuditLog({
      action: isNewUser ? 'AUTH_REGISTER_GOOGLE' : 'AUTH_LOGIN_GOOGLE',
      actorId: user.uuid || user.id,
      actorRole: user.role,
      actorEmail: user.email,
      resource: 'AUTH_SESSION',
      resourceId: user.uuid || user.id,
      ip: clientIp,
      status: 'SUCCESS',
      details: `Connexion réelle réussie via Google OAuth (${googleProfile.email}) en tant que ${user.role} - Provider: Google GIS`
    });

    const token = generateToken({
      ...user,
      doctorId: isDoc ? (user.doctorId || doctorRecord?.id || null) : null
    });

    const safeUser = {
      id: user.id || user.uuid,
      uuid: user.uuid || user.id,
      name: isDoc ? (doctorRecord?.name || user.name) : user.name,
      email: user.email,
      role: user.role,
      avatar: user.avatar || (isDoc ? doctorRecord?.avatar : '') || '',
      phone: user.phone || (isDoc ? doctorRecord?.phone : '') || '',
      doctorId: isDoc ? (user.doctorId || doctorRecord?.id || null) : null,
      specialty: isDoc ? (user.specialty || doctorRecord?.specialtyFr || doctorRecord?.specialty || '') : '',
      provider: 'google'
    };

    return res.json({
      success: true,
      message: `Connexion réussie via Google ! Bienvenue, ${user.name}.`,
      token,
      user: safeUser,
      isNewUser
    });
  } catch (err) {
    console.error('[AUTH GOOGLE] Erreur serveur:', err);
    return res.status(500).json({
      success: false,
      message: 'Erreur interne lors de l\'authentification Google: ' + err.message
    });
  }
});

router.failedLoginAttempts = failedLoginAttempts;
router.active2FASessions = active2FASessions;
router.activePasswordResets = activePasswordResets;
router.verifiedResetTokens = verifiedResetTokens;

module.exports = router;

