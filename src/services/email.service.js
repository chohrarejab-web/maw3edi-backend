/**
 * SahaTN / Maw2idi — Unified Email Service
 * All application emails share one consistent, email-client-safe design system.
 * Supports:
 * 1. Personal Gmail via SMTP (Google App Password)
 * 2. Brevo (Sendinblue) / Mailtrap / Custom SMTP
 * 3. Resend Developer API
 * 4. Automatic Safe Fallback (Database Archive) when credentials are not configured
 */

const nodemailer = require('nodemailer');
const db = require('../config/database');

const BADGE_TONES = {
  brand:   { bg: 'rgba(255,255,255,0.18)', border: 'rgba(255,255,255,0.35)', text: '#ffffff' },
  success: { bg: 'rgba(16,185,129,0.24)',  border: 'rgba(110,231,183,0.55)', text: '#d1fae5' },
  warning: { bg: 'rgba(245,158,11,0.24)',  border: 'rgba(253,224,71,0.50)',  text: '#fef08a' },
  danger:  { bg: 'rgba(239,68,68,0.26)',   border: 'rgba(252,165,165,0.55)', text: '#fecaca' },
  info:    { bg: 'rgba(14,165,233,0.24)',  border: 'rgba(125,211,252,0.50)', text: '#e0f2fe' }
};

const CALLOUT_TONES = {
  teal:  { bg: '#f0fdfa', border: '#ccfbf1', accent: '#00A896', title: '#0f766e', text: '#115e59' },
  amber: { bg: '#fffbeb', border: '#fde68a', accent: '#f59e0b', title: '#92400e', text: '#78350f' },
  rose:  { bg: '#fef2f2', border: '#fecaca', accent: '#ef4444', title: '#991b1b', text: '#7f1d1d' },
  blue:  { bg: '#eff6ff', border: '#bfdbfe', accent: '#0086cd', title: '#1e40af', text: '#1e3a8a' },
  slate: { bg: '#f8fafc', border: '#e2e8f0', accent: '#64748b', title: '#334155', text: '#475569' }
};

class EmailService {
  /**
   * Escape user-supplied text before interpolating into HTML email templates
   */
  static escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Shared callout box component (100% table-based, Gmail/Outlook safe)
   */
  static renderCallout({ tone = 'teal', title = '', bodyHtml = '' }) {
    const t = CALLOUT_TONES[tone] || CALLOUT_TONES.teal;
    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: ${t.bg}; border: 1px solid ${t.border}; border-left: 5px solid ${t.accent}; border-radius: 16px; margin: 20px 0; overflow: hidden;">
        <tr>
          <td style="padding: 18px 20px; font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Arial, sans-serif;">
            ${title ? `<div style="font-size: 13px; font-weight: 900; color: ${t.title}; margin-bottom: 8px; letter-spacing: 0.2px;">${title}</div>` : ''}
            <div style="font-size: 13.5px; color: ${t.text}; line-height: 1.6;">
              ${bodyHtml}
            </div>
          </td>
        </tr>
      </table>`;
  }

  /**
   * Shared key-value details card (100% table-based, replaces flexbox for Outlook/Gmail)
   */
  static renderInfoTable(rows = [], title = '') {
    const validRows = rows.filter(r => r && r.label !== undefined && r.value !== undefined && r.value !== null && r.value !== '');
    if (validRows.length === 0) return '';

    const rowsHtml = validRows.map((row, idx) => {
      const isLast = idx === validRows.length - 1;
      const borderStyle = isLast ? '' : 'border-bottom: 1px dashed #cbd5e1;';
      const valColor = row.highlight ? '#0086cd' : (row.accent || '#0f172a');
      const valStyle = row.mono ? "font-family: 'Courier New', Courier, monospace;" : '';
      const valContent = row.rawValue ? row.value : this.escapeHtml(row.value);
      return `
        <tr>
          <td style="padding: 10px 8px 10px 0; ${borderStyle} font-size: 13px; color: #64748b; font-weight: 600; vertical-align: top; width: 42%;">
            ${row.label}
          </td>
          <td align="right" style="padding: 10px 0 10px 8px; ${borderStyle} font-size: 13px; color: ${valColor}; font-weight: 800; vertical-align: top; text-align: right; ${valStyle}">
            ${valContent}
          </td>
        </tr>`;
    }).join('');

    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 18px; margin: 22px 0; overflow: hidden;">
        <tr>
          <td style="padding: 18px 20px; font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Arial, sans-serif;">
            ${title ? `<div style="font-size: 12.5px; font-weight: 900; color: #0f766e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px;">${title}</div>` : ''}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${rowsHtml}
            </table>
          </td>
        </tr>
      </table>`;
  }

  /**
   * Master Maw2idi / SahaTN Unified Email Layout
   * Every email sent by the platform uses this exact frame, header, button, and footer.
   */
  static renderEmailLayout({
    title = 'Maw2idi · SahaTN',
    badge = 'Maw2idi · SahaTN · Santé Numérique Tunisie',
    badgeTone = 'brand',
    heading = '',
    subtitle = '',
    bodyHtml = '',
    ctaLabel = '',
    ctaUrl = '',
    fallbackUrl = '',
    footerNote = ''
  }) {
    const b = BADGE_TONES[badgeTone] || BADGE_TONES.brand;

    const ctaBlock = (ctaLabel && ctaUrl) ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin: 28px 0 14px 0;">
        <tr>
          <td align="center">
            <a href="${this.escapeHtml(ctaUrl)}" target="_blank" class="btn-hover" style="display: inline-block; background: linear-gradient(135deg, #00A896 0%, #0086cd 100%); background-color: #00A896; color: #ffffff !important; text-decoration: none; font-weight: 900; font-size: 14px; padding: 15px 34px; border-radius: 16px; box-shadow: 0 8px 22px rgba(0, 168, 150, 0.32); text-align: center; letter-spacing: 0.3px; font-family: 'Segoe UI', Arial, sans-serif;">
              ${ctaLabel}
            </a>
          </td>
        </tr>
      </table>` : '';

    const fallbackBlock = fallbackUrl ? `
      <p style="font-size: 12px; color: #64748b; margin: 16px 0 6px 0; text-align: center;">
        Si le bouton ne fonctionne pas, copiez et collez le lien sécurisé suivant dans votre navigateur :
      </p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 12px;">
        <tr>
          <td style="background-color: #f8fafc; border: 1px dashed #cbd5e1; padding: 12px 14px; border-radius: 12px; font-family: 'Courier New', Courier, monospace; font-size: 11px; word-break: break-all; color: #0f766e; text-align: center;">
            ${this.escapeHtml(fallbackUrl)}
          </td>
        </tr>
      </table>` : '';

    return `<!DOCTYPE html>
<html lang="fr" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${this.escapeHtml(title)}</title>
  <style>
    body, table, td, p, a, li { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; outline: none; text-decoration: none; }
    body { margin: 0 !important; padding: 0 !important; width: 100% !important; background-color: #f1f5f9; font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Arial, sans-serif; }
    .btn-hover:hover { opacity: 0.92 !important; }
  </style>
</head>
<body style="margin: 0; padding: 24px 12px; background-color: #f1f5f9; font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <center style="width: 100%; background-color: #f1f5f9;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f1f5f9; margin: 0 auto; max-width: 620px;">
      <tr>
        <td align="center" style="padding: 0;">

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; background-color: #ffffff; border-radius: 24px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 10px 30px rgba(3, 43, 67, 0.08);">

            <!-- UNIFIED HEADER -->
            <tr>
              <td style="background: linear-gradient(135deg, #032b43 0%, #004b5c 52%, #00A896 100%); background-color: #032b43; padding: 36px 32px; text-align: center; color: #ffffff;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin: 0 auto 14px auto;">
                  <tr>
                    <td style="background-color: ${b.bg}; border: 1px solid ${b.border}; border-radius: 9999px; padding: 5px 16px; text-align: center;">
                      <span style="color: ${b.text}; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.8px; font-family: 'Segoe UI', Arial, sans-serif; display: inline-block;">
                        ${badge}
                      </span>
                    </td>
                  </tr>
                </table>
                <h1 style="margin: 0; font-size: 23px; font-weight: 900; color: #ffffff; letter-spacing: -0.4px; line-height: 1.25; font-family: 'Segoe UI', Arial, sans-serif;">
                  ${heading}
                </h1>
                ${subtitle ? `<p style="margin: 8px 0 0 0; font-size: 13.5px; color: #ccfbf1; opacity: 0.95; line-height: 1.45; font-family: 'Segoe UI', Arial, sans-serif;">${subtitle}</p>` : ''}
              </td>
            </tr>

            <!-- UNIFIED CONTENT BODY -->
            <tr>
              <td style="padding: 32px 30px; font-size: 14px; line-height: 1.65; color: #334155; font-family: 'Segoe UI', Arial, sans-serif; background-color: #ffffff;">
                ${bodyHtml}
                ${ctaBlock}
                ${fallbackBlock}
              </td>
            </tr>

            <!-- UNIFIED FOOTER -->
            <tr>
              <td style="background-color: #f8fafc; padding: 22px 30px; font-size: 11px; color: #94a3b8; text-align: center; border-top: 1px solid #e2e8f0; line-height: 1.6; font-family: 'Segoe UI', Arial, sans-serif;">
                <p style="margin: 0 0 4px 0; color: #475569;"><strong>Maw2idi · SahaTN</strong> — Plateforme Nationale de Santé Numérisée en Tunisie</p>
                <p style="margin: 0 0 4px 0;">Conforme aux normes INPDP &amp; Conseil National de l'Ordre des Médecins de Tunisie</p>
                <p style="margin: 0; font-size: 10.5px; color: #94a3b8;">
                  ${footerNote || 'Support 7j/7 : support@sahatn.tn · +216 71 884 900 · Ne pas répondre directement à cet email automatique.'}
                </p>
              </td>
            </tr>

          </table>

        </td>
      </tr>
    </table>
  </center>
</body>
</html>`;
  }

  /**
   * Resolve active email transport strategy from environment variables
   */
  static getTransporter() {
    // Strategy 1: Free Personal Gmail SMTP (App Password)
    const gmailUser = process.env.GMAIL_USER?.trim();
    const gmailPass = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, '');

    if (gmailUser && gmailPass) {
      return {
        provider: 'GMAIL_SMTP',
        label: 'Google Gmail SMTP (App Password)',
        from: `"Maw2idi · SahaTN" <${gmailUser}>`,
        transporter: nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: gmailUser,
            pass: gmailPass
          }
        })
      };
    }

    // Strategy 2: Generic SMTP (Brevo / Sendinblue, Mailtrap, MailerSend)
    const smtpHost = process.env.SMTP_HOST?.trim();
    const smtpUser = process.env.SMTP_USER?.trim();
    const smtpPass = process.env.SMTP_PASS?.trim();

    if (smtpHost && smtpUser && smtpPass) {
      const port = parseInt(process.env.SMTP_PORT) || 587;
      const secure = port === 465;
      const from = process.env.SMTP_FROM || `"Maw2idi · SahaTN" <${smtpUser}>`;

      return {
        provider: 'CUSTOM_SMTP',
        label: `SMTP Relay (${smtpHost}:${port})`,
        from: from,
        transporter: nodemailer.createTransport({
          host: smtpHost,
          port: port,
          secure: secure,
          auth: {
            user: smtpUser,
            pass: smtpPass
          }
        })
      };
    }

    // Strategy 3: Resend Developer API
    const resendKey = process.env.RESEND_API_KEY?.trim();
    if (resendKey) {
      return {
        provider: 'RESEND_API',
        label: 'Resend Developer API',
        from: process.env.RESEND_FROM || 'Maw2idi · SahaTN <onboarding@resend.dev>',
        apiKey: resendKey
      };
    }

    // Strategy 4: Local Database Archive (Dev / Staging Safe Fallback)
    return {
      provider: 'SIMULATED_ARCHIVE',
      label: 'Mode Archive & Simulation Locale (Bdd)',
      from: '"Maw2idi · SahaTN" <contact@sahatn.tn>'
    };
  }

  /**
   * Return information about currently active email delivery provider
   */
  static getProviderStatus() {
    const config = this.getTransporter();
    const isLive = config.provider !== 'SIMULATED_ARCHIVE';

    let instructions = '';
    if (!isLive) {
      instructions = 'Pour envoyer des emails réels aux médecins : Définissez GMAIL_USER et GMAIL_APP_PASSWORD dans .env (100% gratuit avec un compte Gmail).';
    } else {
      instructions = `Fournisseur actif : ${config.label}. Les emails sont expédiés en direct vers les boîtes de réception réelles.`;
    }

    return {
      provider: config.provider,
      label: config.label,
      isLiveSending: isLive,
      fromAddress: config.from,
      instructions: instructions
    };
  }

  /**
   * Deliver email over active provider (SMTP or API), or archive if offline
   */
  static async deliverEmail({ to, subject, html, text }) {
    const transport = this.getTransporter();

    if (transport.provider === 'GMAIL_SMTP' || transport.provider === 'CUSTOM_SMTP') {
      try {
        const info = await transport.transporter.sendMail({
          from: transport.from,
          to: to,
          subject: subject,
          html: html,
          text: text || subject
        });
        return {
          delivered: true,
          provider: transport.provider,
          messageId: info.messageId,
          response: info.response
        };
      } catch (err) {
        console.error(`[EmailService] SMTP error with ${transport.provider}:`, err.message);
        return {
          delivered: false,
          provider: transport.provider,
          error: err.message
        };
      }
    }

    if (transport.provider === 'RESEND_API') {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${transport.apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: transport.from,
            to: [to],
            subject: subject,
            html: html
          })
        });
        const json = await res.json();
        if (!res.ok) {
          throw new Error(json.message || `Resend HTTP ${res.status}`);
        }
        return {
          delivered: true,
          provider: 'RESEND_API',
          messageId: json.id
        };
      } catch (err) {
        console.error('[EmailService] Resend API error:', err.message);
        return {
          delivered: false,
          provider: 'RESEND_API',
          error: err.message
        };
      }
    }

    // Simulated archive
    return {
      delivered: false,
      simulated: true,
      provider: 'SIMULATED_ARCHIVE',
      note: 'Stocké et inspectable en BDD (aucun identifiant SMTP configuré dans .env)'
    };
  }

  /**
   * 1. Official approval/validation email to practitioner
   */
  static async sendDoctorApprovalEmail({ doctorName, email, requestId, doctorId, activationToken, hostUrl = 'http://localhost:4000' }) {
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const finalizationUrl = `${clientUrl}/doctor/onboarding?id=${encodeURIComponent(requestId || doctorId || '')}&email=${encodeURIComponent(email)}&name=${encodeURIComponent(doctorName)}&token=${encodeURIComponent(activationToken || '')}`;
    const cleanDoctorName = (doctorName || '').replace(/^Dr\.?\s*/i, '').trim();
    const salutation = `Dr. ${cleanDoctorName}`;
    const safeSalutation = this.escapeHtml(salutation);

    const subject = `[SahaTN] Félicitations ${salutation} : Votre dossier praticien est validé !`;

    const bodyHtml = `
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #1e293b;">Bonjour <strong>${safeSalutation}</strong>,</p>
      <p style="margin: 0 0 16px 0;">
        Nous avons le plaisir de vous informer que votre demande d'adhésion et vos justificatifs professionnels (diplôme, inscription à l'Ordre des Médecins de Tunisie) ont été <strong>officiellement vérifiés et approuvés</strong> par l'équipe administrative de Maw2idi / SahaTN.
      </p>
      ${this.renderCallout({
        tone: 'teal',
        title: '📍 Prochaine étape : Finalisation de votre Cabinet',
        bodyHtml: `
          <p style="margin: 0 0 10px 0;">Pour rendre votre cabinet visible auprès des patients et déverrouiller votre agenda, veuillez finaliser votre compte en configurant :</p>
          <div style="margin-bottom: 6px;">• <strong>Votre mot de passe secret</strong> de connexion praticien.</div>
          <div style="margin-bottom: 6px;">• <strong>L'emplacement géographique exact</strong> de votre cabinet sur la carte interactive.</div>
          <div>• Vos paramètres de téléconsultation et conventionnement CNAM.</div>
        `
      })}
      <p style="font-size: 12px; color: #64748b; margin: 16px 0 0 0; text-align: center;">
        <em>Ce lien d'activation sécurisé est valable pendant 7 jours.</em>
      </p>`;

    const html = this.renderEmailLayout({
      title: subject,
      badge: 'Maw2idi · Direction Médicale & Ordre des Médecins',
      badgeTone: 'success',
      heading: 'Dossier Praticien Validé avec Succès ! 🎉',
      subtitle: 'Votre cabinet est prêt à rejoindre le réseau national de santé en Tunisie.',
      bodyHtml,
      ctaLabel: '🚀 Finaliser mon Compte & Positionner mon Cabinet',
      ctaUrl: finalizationUrl,
      fallbackUrl: finalizationUrl
    });

    const emailRecord = {
      id: `mail-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
      type: 'APPROVAL_VALIDATION',
      recipientEmail: email.toLowerCase().trim(),
      recipientName: doctorName,
      subject,
      requestId,
      doctorId,
      finalizationUrl,
      htmlBody: html,
      status: 'PENDING',
      sentAt: new Date().toISOString(),
      tunisDate: new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Tunis' })
    };

    db.insert('emailLogs', emailRecord);

    const delivery = await this.deliverEmail({ to: email, subject, html });

    if (delivery.delivered) {
      emailRecord.status = 'SENT';
      emailRecord.delivery = delivery;
      db.update('emailLogs', e => e.id === emailRecord.id, { status: 'SENT', delivery });
      console.log(`[EmailService] 🟢 Validation email sent via ${delivery.provider} to ${email}`);
    } else {
      emailRecord.status = delivery.error ? 'FAILED' : 'SAVED_IN_DB';
      emailRecord.delivery = delivery;
      db.update('emailLogs', e => e.id === emailRecord.id, { status: emailRecord.status, delivery });
      console.log(`[EmailService] ⚪ Validation email recorded in database archive for ${email} (Provider: ${delivery.provider})`);
    }

    return emailRecord;
  }

  /**
   * 2. Permanent Rejection Workflow Email
   */
  static async sendPermanentRejectionEmail({
    recipientName = 'Praticien',
    doctorName,
    email,
    requestId,
    reason = 'Justificatifs professionnels non conformes au code de déontologie médicale ou critères d\'éligibilité non remplis.',
    hostUrl = process.env.CLIENT_URL || 'http://localhost:5173'
  }) {
    const targetEmail = (email || '').toLowerCase().trim();
    const finalName = doctorName || recipientName || 'Praticien';
    const cleanDoctorName = finalName.replace(/^Dr\.?\s*/i, '').trim();
    const salutation = `Dr. ${cleanDoctorName}`;
    const safeSalutation = this.escapeHtml(salutation);
    const subject = `[SahaTN] Décision définitive concernant votre demande d'adhésion`;

    const bodyHtml = `
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #1e293b;">Bonjour <strong>${safeSalutation}</strong>,</p>
      <p style="margin: 0 0 14px 0;">
        Nous vous remercions de l'intérêt porté à la plateforme médicale <strong>Maw2idi / SahaTN</strong> et pour la confiance accordée à notre écosystème de santé.
      </p>
      <p style="margin: 0 0 18px 0;">
        Après un examen approfondi de votre dossier et des éléments transmis auprès de notre commission de vérification médicale, nous avons le regret de vous notifier que votre demande d'adhésion <strong style="color: #dc2626;">ne peut pas être retenue</strong> de manière définitive.
      </p>
      ${this.renderCallout({
        tone: 'rose',
        title: '⚠️ Motif officiel de refus notifié :',
        bodyHtml: `<strong>${this.escapeHtml(reason)}</strong>`
      })}
      ${this.renderCallout({
        tone: 'slate',
        title: 'Cadre Réglementaire & Conformité :',
        bodyHtml: `Cette décision a été actée conformément aux règles déontologiques applicables à l'exercice médical en République Tunisienne (Conseil National de l'Ordre des Médecins) et à la politique de conformité INPDP.`
      })}
      <p style="font-size: 13px; color: #475569; margin: 18px 0 16px 0;">
        Si vous estimez qu'une erreur d'appréciation a été commise, vous pouvez contacter notre service déontologie à <a href="mailto:contact@sahatn.tn" style="color: #0086cd; font-weight: bold; text-decoration: none;">contact@sahatn.tn</a>.
      </p>
      <p style="margin: 0; font-size: 13px; color: #334155;">
        Veuillez agréer, <strong>${safeSalutation}</strong>, nos salutations respectueuses.
      </p>`;

    const html = this.renderEmailLayout({
      title: subject,
      badge: 'Décision Administrative Définitive',
      badgeTone: 'danger',
      heading: 'Statut de votre Candidature Praticien',
      subtitle: 'Notification officielle de la commission de vérification médicale',
      bodyHtml,
      footerNote: `Identifiant de dossier : ${this.escapeHtml(requestId || 'N/A')} · Notification générée automatiquement.`
    });

    const emailRecord = {
      id: `mail-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
      type: 'REJECTION_PERMANENT',
      workflow: 'PERMANENT_REJECTION',
      recipientEmail: targetEmail,
      recipientName: finalName,
      subject,
      requestId,
      reason,
      htmlBody: html,
      status: 'PENDING',
      sentAt: new Date().toISOString(),
      tunisDate: new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Tunis' })
    };

    db.insert('emailLogs', emailRecord);

    const delivery = await this.deliverEmail({ to: targetEmail, subject, html });

    if (delivery.delivered) {
      emailRecord.status = 'SENT';
      emailRecord.delivery = delivery;
      db.update('emailLogs', e => e.id === emailRecord.id, { status: 'SENT', delivery });
      console.log(`[EmailService] 🔴 Permanent rejection email sent to ${targetEmail} via ${delivery.provider}`);
    } else {
      emailRecord.status = delivery.error ? 'FAILED' : 'SAVED_IN_DB';
      emailRecord.delivery = delivery;
      db.update('emailLogs', e => e.id === emailRecord.id, { status: emailRecord.status, delivery });
      console.log(`[EmailService] ⚪ Permanent rejection email recorded in DB for ${targetEmail} (${delivery.provider})`);
    }

    return emailRecord;
  }

  /**
   * 3. Temporary Rejection (Pending Documents) Workflow Email
   */
  static async sendTemporaryRejectionEmail({
    recipientName = 'Praticien',
    doctorName,
    email,
    requestId,
    reason = 'Votre dossier d\'inscription nécessite des pièces justificatives complémentaires pour être validé.',
    missingDocuments = [],
    customNotes = '',
    resubmitUrl,
    hostUrl = process.env.CLIENT_URL || 'http://localhost:5173'
  }) {
    const targetEmail = (email || '').toLowerCase().trim();
    const finalName = doctorName || recipientName || 'Praticien';
    const cleanDoctorName = finalName.replace(/^Dr\.?\s*/i, '').trim();
    const salutation = `Dr. ${cleanDoctorName}`;
    const safeSalutation = this.escapeHtml(salutation);
    const subject = `[SahaTN] ⚠️ Action requise : Pièces complémentaires demandées pour votre dossier`;

    const cleanHost = hostUrl.replace(/\/$/, '');
    const uploadLink = resubmitUrl || `${cleanHost}/doctor/onboarding?action=upload&id=${encodeURIComponent(requestId || '')}&email=${encodeURIComponent(targetEmail)}`;

    const docsList = Array.isArray(missingDocuments) && missingDocuments.length > 0
      ? missingDocuments
      : [
          'Copie certifiée du Diplôme de Docteur en Médecine',
          'Carte d\'Identité Nationale (CIN) recto/verso lisible',
          'Attestation d\'inscription au Conseil de l\'Ordre des Médecins (CNOM) de l\'année en cours'
        ];

    const docsHtml = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 18px; margin: 20px 0; overflow: hidden;">
        <tr>
          <td style="padding: 20px;">
            <div style="font-size: 13px; font-weight: 900; color: #0f172a; margin-bottom: 12px;">
              📌 Pièces justificatives requises pour débloquer votre dossier :
            </div>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              ${docsList.map(doc => `
                <tr>
                  <td style="padding: 7px 10px 7px 0; vertical-align: top; width: 90px;">
                    <span style="display: inline-block; background-color: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; border-radius: 6px; padding: 3px 8px; font-size: 10px; font-weight: 900; letter-spacing: 0.4px; text-transform: uppercase; white-space: nowrap;">À FOURNIR</span>
                  </td>
                  <td style="padding: 7px 0; vertical-align: top; font-size: 13.5px; font-weight: 700; color: #1e293b; line-height: 1.5;">
                    ${this.escapeHtml(doc)}
                  </td>
                </tr>`).join('')}
            </table>
          </td>
        </tr>
      </table>`;

    const bodyHtml = `
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #1e293b;">Bonjour <strong>${safeSalutation}</strong>,</p>
      <p style="margin: 0 0 14px 0;">
        Votre demande d'inscription sur <strong>Maw2idi / SahaTN</strong> a été examinée par notre équipe de conformité médicale. Votre dossier est actuellement <strong style="color: #b45309;">temporairement mis en pause</strong> en raison de documents manquants ou à compléter.
      </p>
      ${this.renderCallout({
        tone: 'amber',
        title: '📋 Remarque de l\'Administration :',
        bodyHtml: `
          <strong>${this.escapeHtml(reason)}</strong>
          ${customNotes ? `<div style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed #fcd34d; font-size: 13px; font-style: italic;"><strong>Note complémentaire :</strong> ${this.escapeHtml(customNotes)}</div>` : ''}
        `
      })}
      ${docsHtml}
      ${this.renderCallout({
        tone: 'teal',
        title: '📍 Prochaines étapes pour valider votre cabinet :',
        bodyHtml: `
          <div style="margin-bottom: 8px;"><strong>1. Préparez vos documents :</strong> Numérisez les pièces listées ci-dessus (PDF haute résolution ou photo nette).</div>
          <div style="margin-bottom: 8px;"><strong>2. Accédez à votre espace sécurisé :</strong> Cliquez sur le bouton de téléversement ci-dessous.</div>
          <div><strong>3. Réexamen prioritaire :</strong> Votre dossier sera réexaminé sous 24 à 48 heures ouvrées.</div>
        `
      })}
      <p style="font-size: 12px; color: #64748b; margin: 16px 0 0 0; text-align: center;">
        ⏳ <em>Vous disposez d'un délai de <strong>15 jours calendaires</strong> pour soumettre vos pièces manquantes.</em>
      </p>`;

    const html = this.renderEmailLayout({
      title: subject,
      badge: '⚠️ Action Requise · Dossier en Attente',
      badgeTone: 'warning',
      heading: 'Complément de Dossier Praticien',
      subtitle: 'Votre cabinet est temporairement en pause · Démarche de régularisation rapide',
      bodyHtml,
      ctaLabel: '📤 Téléverser mes Pièces Justificatives',
      ctaUrl: uploadLink,
      fallbackUrl: uploadLink,
      footerNote: `Dossier N° : ${this.escapeHtml(requestId || 'N/A')} · Support 7j/7 : support@sahatn.tn · +216 71 884 900`
    });

    const emailRecord = {
      id: `mail-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
      type: 'REJECTION_TEMPORARY_DOCUMENTS',
      workflow: 'TEMPORARY_REJECTION_PENDING_DOCS',
      recipientEmail: targetEmail,
      recipientName: finalName,
      subject,
      requestId,
      reason,
      missingDocuments: docsList,
      customNotes,
      uploadLink,
      htmlBody: html,
      status: 'PENDING',
      sentAt: new Date().toISOString(),
      tunisDate: new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Tunis' })
    };

    db.insert('emailLogs', emailRecord);

    const delivery = await this.deliverEmail({ to: targetEmail, subject, html });

    if (delivery.delivered) {
      emailRecord.status = 'SENT';
      emailRecord.delivery = delivery;
      db.update('emailLogs', e => e.id === emailRecord.id, { status: 'SENT', delivery });
      console.log(`[EmailService] 🟡 Temporary rejection (pending docs) email sent to ${targetEmail} via ${delivery.provider}`);
    } else {
      emailRecord.status = delivery.error ? 'FAILED' : 'SAVED_IN_DB';
      emailRecord.delivery = delivery;
      db.update('emailLogs', e => e.id === emailRecord.id, { status: emailRecord.status, delivery });
      console.log(`[EmailService] ⚪ Temporary rejection email recorded in DB for ${targetEmail} (${delivery.provider})`);
    }

    return emailRecord;
  }

  /**
   * Unified dispatcher: Permanent or Temporary rejection email workflow
   */
  static async sendRejectionNotification(options = {}) {
    const rawType = (options.type || options.rejectionType || '').toString().toUpperCase();
    const isTemp = (rawType === 'TEMPORARY' || rawType === 'TEMPORARY_DOCUMENTS' || rawType === 'PENDING_DOCUMENTS' || rawType === 'ACTION_REQUIRED');
    if (isTemp) {
      return this.sendTemporaryRejectionEmail(options);
    }
    return this.sendPermanentRejectionEmail(options);
  }

  static async sendDoctorRejectionEmail(options) {
    return this.sendRejectionNotification(options);
  }

  /**
   * 4. Password Reset OTP Verification Email
   */
  static async sendPasswordResetOtpEmail({ email, name = 'Utilisateur', otpCode, resetToken, hostUrl = 'http://localhost:4000' }) {
    const subject = `[SahaTN] 🔐 Votre code de réinitialisation de mot de passe : ${otpCode}`;
    const resetUrl = `${hostUrl}/forgot-password?token=${encodeURIComponent(resetToken || '')}&email=${encodeURIComponent(email)}`;

    const otpBox = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f0fdfa; border: 2px dashed #2dd4bf; border-radius: 18px; margin: 24px 0;">
        <tr>
          <td align="center" style="padding: 24px 20px;">
            <div style="font-size: 11px; font-weight: 800; color: #0d9488; text-transform: uppercase; letter-spacing: 0.8px;">
              Votre Code de Sécurité Temporaire (OTP)
            </div>
            <div style="font-family: 'Courier New', Courier, monospace; font-size: 38px; font-weight: 900; letter-spacing: 10px; color: #0086cd; margin: 10px 0;">
              ${this.escapeHtml(otpCode)}
            </div>
            <div style="font-size: 11.5px; color: #64748b; font-weight: 600;">
              ⏱️ Ce code expire dans 15 minutes
            </div>
          </td>
        </tr>
      </table>`;

    const bodyHtml = `
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #1e293b;">Bonjour <strong>${this.escapeHtml(name)}</strong>,</p>
      <p style="margin: 0 0 14px 0;">
        Nous avons reçu une demande de réinitialisation de mot de passe pour votre compte <strong>Maw2idi / SahaTN</strong> (${this.escapeHtml(email)}).
      </p>
      ${otpBox}
      <p style="margin: 0 0 14px 0;">
        Veuillez saisir ce code à 6 chiffres dans la fenêtre de réinitialisation ouverte dans votre navigateur, ou cliquez sur le bouton ci-dessous :
      </p>
      ${this.renderCallout({
        tone: 'amber',
        title: '🛡️ Protection de votre compte',
        bodyHtml: `Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet email en toute sécurité. Votre mot de passe actuel demeure protégé et inchangé.`
      })}`;

    const html = this.renderEmailLayout({
      title: subject,
      badge: 'Maw2idi · Sécurité du Compte',
      badgeTone: 'info',
      heading: '🔐 Réinitialisation de Mot de Passe',
      subtitle: 'Code de vérification à usage unique valable 15 minutes',
      bodyHtml,
      ctaLabel: '🔑 Réinitialiser Mon Mot de Passe →',
      ctaUrl: resetUrl
    });

    const emailRecord = {
      id: `mail-reset-${Date.now()}-${Math.floor(100 + Math.random() * 900)}`,
      type: 'PASSWORD_RESET_OTP',
      recipientEmail: email.toLowerCase().trim(),
      recipientName: name,
      subject,
      code: otpCode,
      status: 'PENDING',
      sentAt: new Date().toISOString(),
      tunisDate: new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Tunis' })
    };

    try { db.insert('emailLogs', emailRecord); } catch (e) {}

    const delivery = await this.deliverEmail({
      to: email,
      subject,
      html,
      text: `Bonjour ${name}, votre code de réinitialisation de mot de passe Maw2idi / SahaTN est : ${otpCode} (valable 15 minutes).`
    });

    if (delivery.delivered) {
      emailRecord.status = 'SENT';
      emailRecord.delivery = delivery;
      try { db.update('emailLogs', e => e.id === emailRecord.id, { status: 'SENT', delivery }); } catch (e) {}
      console.log(`[EmailService] 🟢 Real password reset email delivered to ${email} (MessageId: ${delivery.messageId})`);
    } else {
      emailRecord.status = delivery.error ? 'FAILED' : 'SAVED_IN_DB';
      emailRecord.delivery = delivery;
      try { db.update('emailLogs', e => e.id === emailRecord.id, { status: emailRecord.status, delivery }); } catch (e) {}
      console.warn(`[EmailService] ⚠️ Password reset email delivery note for ${email}:`, delivery);
    }

    return { delivery, emailRecord };
  }

  /**
   * 5. Appointment confirmation email to the patient
   */
  static async sendAppointmentConfirmationEmail({ appointment, patientEmail, doctor, hostUrl = 'http://localhost:5173' }) {
    const targetEmail = (patientEmail || 'rejabchohra@gmail.com').toLowerCase().trim();
    const patientName = appointment.patientName || 'Patient';
    const doctorName = appointment.doctorName || (doctor && doctor.name) || 'Dr. Praticien SahaTN';
    const specialty = appointment.specialty || (doctor && (doctor.specialtyFr || doctor.specialty)) || 'Consultation Spécialisée';
    const date = appointment.date || 'Date convenue';
    const time = appointment.time || '10:00';
    const ticket = appointment.ticketNumber || 'N° 01';
    const typeLabel = (appointment.type === 'TELECONSULT' || appointment.type === 'TELECONSULTATION')
      ? '🎥 Téléconsultation Vidéo Sécurisée'
      : '🏥 Consultation en Présentiel au Cabinet';
    const fee = appointment.fee || (doctor && doctor.fee ? doctor.fee + ' TND' : '70 TND');
    const cabinetAddress = (doctor && doctor.address) || 'Cabinet Médical, Tunisie';
    const cabinetPhone = (doctor && doctor.phone) || '+216 71 830 120';
    const portalUrl = `${hostUrl}/patient/dashboard`;

    const subject = `🏥 Confirmation RDV : ${doctorName} - ${date} à ${time} (Ticket ${ticket}) | SahaTN`;

    const ticketPill = `<span style="display: inline-block; background-color: #00A896; color: #ffffff; padding: 3px 10px; border-radius: 8px; font-weight: 900; font-size: 12px;">${this.escapeHtml(ticket)}</span>`;

    const bodyHtml = `
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #1e293b;">Bonjour <strong>${this.escapeHtml(patientName)}</strong>,</p>
      <p style="margin: 0 0 18px 0;">
        Votre rendez-vous médical a été enregistré et validé avec succès sur <strong>Maw2idi / SahaTN</strong>. Retrouvez ci-dessous le récapitulatif complet de votre consultation :
      </p>
      ${this.renderInfoTable([
        { label: '🩺 Praticien', value: doctorName },
        { label: '🏥 Spécialité', value: specialty },
        { label: '📅 Date &amp; Heure', value: `${date} à ${time}`, highlight: true },
        { label: '🎫 File d\'attente', value: ticketPill, rawValue: true },
        { label: '📋 Mode de consultation', value: typeLabel },
        { label: '📍 Adresse du cabinet', value: cabinetAddress },
        { label: '📞 Contact cabinet', value: cabinetPhone },
        { label: '💰 Honoraires', value: `${fee} (CNAM éligible)` }
      ], 'Récapitulatif de votre consultation')}
      ${this.renderCallout({
        tone: 'teal',
        title: '📋 Consignes pratiques pour votre consultation :',
        bodyHtml: `
          <div style="margin-bottom: 6px;">• Présentez-vous <strong>10 minutes à l'avance</strong> à l'accueil du cabinet médical.</div>
          <div style="margin-bottom: 6px;">• Munissez-vous de votre <strong>CIN</strong> et de votre <strong>carnet de soins CNAM</strong>.</div>
          <div style="margin-bottom: 6px;">• Apportez vos ordonnances récentes, bilans ou clichés d'imagerie.</div>
          <div>• En cas d'empêchement, annulez ou reportez depuis votre espace patient au moins 4 heures à l'avance.</div>
        `
      })}`;

    const html = this.renderEmailLayout({
      title: subject,
      badge: '✔ Rendez-vous Officiellement Confirmé',
      badgeTone: 'success',
      heading: 'Confirmation de Rendez-vous',
      subtitle: `${this.escapeHtml(doctorName)} · ${this.escapeHtml(date)} à ${this.escapeHtml(time)}`,
      bodyHtml,
      ctaLabel: 'Accéder à Mon Espace Patient →',
      ctaUrl: portalUrl
    });

    const text = `Bonjour ${patientName}, votre rendez-vous avec ${doctorName} (${specialty}) est confirmé pour le ${date} à ${time} (Ticket ${ticket}) au cabinet : ${cabinetAddress}. Honoraires: ${fee}.`;

    const emailRecord = {
      id: `eml-apt-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      category: 'APPOINTMENT_CONFIRMATION',
      appointmentId: appointment.id,
      doctorId: appointment.doctorId,
      recipientEmail: targetEmail,
      recipientName: patientName,
      subject,
      status: 'PENDING',
      sentAt: new Date().toISOString(),
      tunisDate: new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Tunis' })
    };

    try { db.insert('emailLogs', emailRecord); } catch (e) {}

    const delivery = await this.deliverEmail({ to: targetEmail, subject, html, text });

    if (delivery.delivered) {
      emailRecord.status = 'SENT';
      emailRecord.delivery = delivery;
      try { db.update('emailLogs', e => e.id === emailRecord.id, { status: 'SENT', delivery }); } catch (e) {}
      console.log(`[EmailService] ✉️ Real appointment confirmation email sent to ${targetEmail} (MessageId: ${delivery.messageId})`);
    } else {
      emailRecord.status = delivery.error ? 'FAILED' : 'SAVED_IN_DB';
      emailRecord.delivery = delivery;
      try { db.update('emailLogs', e => e.id === emailRecord.id, { status: emailRecord.status, delivery }); } catch (e) {}
      console.warn(`[EmailService] ℹ️ Appointment email delivery status for ${targetEmail}:`, delivery);
    }

    return { delivery, emailRecord };
  }

  /**
   * 6. Doctor notification email when a new appointment is booked
   */
  static async sendDoctorNewAppointmentNotificationEmail({ appointment, doctorEmail, doctorName, hostUrl = 'http://localhost:5173' }) {
    if (!doctorEmail) return null;
    const targetEmail = doctorEmail.toLowerCase().trim();
    const patientName = appointment.patientName || 'Patient';
    const patientPhone = appointment.patientPhone || 'Non spécifié';
    const date = appointment.date || 'Date';
    const time = appointment.time || '10:00';
    const ticket = appointment.ticketNumber || 'N° 01';
    const typeLabel = (appointment.type === 'TELECONSULT' || appointment.type === 'TELECONSULTATION') ? '🎥 Téléconsultation Vidéo' : '🏥 Au Cabinet';
    const agendaUrl = `${hostUrl}/doctor/dashboard`;

    const subject = `🔔 Nouveau RDV : ${patientName} - ${date} à ${time} (Ticket ${ticket})`;

    const bodyHtml = `
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #1e293b;">Bonjour <strong>${this.escapeHtml(doctorName || 'Docteur')}</strong>,</p>
      <p style="margin: 0 0 16px 0;">
        Un patient vient de réserver une consultation sur votre planning en ligne <strong>Maw2idi / SahaTN</strong> :
      </p>
      ${this.renderInfoTable([
        { label: '👤 Patient', value: patientName },
        { label: '📞 Téléphone', value: patientPhone },
        { label: '📅 Date &amp; Heure', value: `${date} à ${time}`, highlight: true },
        { label: '🎫 Ticket salle d\'attente', value: ticket, accent: '#00A896' },
        { label: '📋 Mode', value: typeLabel }
      ], 'Détails du rendez-vous')}
      <p style="font-size: 13px; color: #64748b; margin: 0;">
        Retrouvez ce patient dans votre onglet <strong>Agenda &amp; Salle d'attente</strong>.
      </p>`;

    const html = this.renderEmailLayout({
      title: subject,
      badge: '🔔 Nouveau Rendez-vous',
      badgeTone: 'info',
      heading: 'Nouveau Rendez-vous Enregistré',
      subtitle: `${this.escapeHtml(patientName)} · ${this.escapeHtml(date)} à ${this.escapeHtml(time)}`,
      bodyHtml,
      ctaLabel: 'Ouvrir Mon Agenda Praticien →',
      ctaUrl: agendaUrl
    });

    const text = `Nouveau RDV Maw2idi / SahaTN: ${patientName} (${patientPhone}) pour le ${date} à ${time} (Ticket ${ticket}).`;

    const emailRecord = {
      id: `eml-doc-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      category: 'DOCTOR_NEW_APPOINTMENT',
      appointmentId: appointment.id,
      recipientEmail: targetEmail,
      subject,
      status: 'PENDING',
      sentAt: new Date().toISOString()
    };

    try { db.insert('emailLogs', emailRecord); } catch (e) {}

    const delivery = await this.deliverEmail({ to: targetEmail, subject, html, text });
    if (delivery.delivered) {
      try { db.update('emailLogs', e => e.id === emailRecord.id, { status: 'SENT', delivery }); } catch (e) {}
    }
    return { delivery, emailRecord };
  }

  /**
   * 7. Doctor notification email when a patient cancels an appointment
   */
  static async sendDoctorAppointmentCancelledNotificationEmail({ appointment, doctorEmail, doctorName, hostUrl = 'http://localhost:5173' }) {
    if (!doctorEmail) return null;
    const targetEmail = doctorEmail.toLowerCase().trim();
    const patientName = appointment.patientName || 'Patient';
    const patientPhone = appointment.patientPhone || 'Non spécifié';
    const date = appointment.date || appointment.dateIso || 'Date';
    const time = appointment.time || '10:00';
    const ticket = appointment.ticketNumber || '—';
    const motif = appointment.motif || 'Consultation';
    const typeLabel = (appointment.type === 'TELECONSULT' || appointment.type === 'TELECONSULTATION') ? '🎥 Téléconsultation Vidéo' : '🏥 Au Cabinet';
    const cancelledAt = new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Tunis' });
    const agendaUrl = `${hostUrl}/doctor/dashboard`;

    const subject = `🚫 RDV Annulé par le patient : ${patientName} - ${date} à ${time}`;

    const bodyHtml = `
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #1e293b;">Bonjour <strong>${this.escapeHtml(doctorName || 'Docteur')}</strong>,</p>
      <p style="margin: 0 0 16px 0;">
        Nous vous informons que le patient <strong>${this.escapeHtml(patientName)}</strong> a annulé son rendez-vous sur <strong>Maw2idi / SahaTN</strong>. Le créneau a été <strong>automatiquement libéré</strong> sur votre planning en ligne.
      </p>
      ${this.renderInfoTable([
        { label: '👤 Patient', value: patientName },
        { label: '📞 Téléphone', value: patientPhone },
        { label: '📅 Créneau annulé', value: `${date} à ${time}`, accent: '#be123c' },
        { label: '📝 Motif', value: motif },
        { label: '📋 Mode', value: typeLabel },
        { label: '🎫 Ticket', value: ticket },
        { label: '🕒 Annulé le', value: `${cancelledAt} (Tunis)` }
      ], 'Récapitulatif de l\'annulation')}
      ${this.renderCallout({
        tone: 'rose',
        title: '🔓 Créneau libéré automatiquement',
        bodyHtml: `Ce créneau est de nouveau disponible à la réservation dans votre espace <strong>Agenda &amp; Salle d'attente</strong>.`
      })}`;

    const html = this.renderEmailLayout({
      title: subject,
      badge: '🚫 Annulation de Rendez-vous',
      badgeTone: 'danger',
      heading: 'Un Patient a Annulé son Rendez-vous',
      subtitle: `${this.escapeHtml(patientName)} · ${this.escapeHtml(date)} à ${this.escapeHtml(time)}`,
      bodyHtml,
      ctaLabel: 'Consulter Mon Planning →',
      ctaUrl: agendaUrl
    });

    const text = `RDV Annulé (Maw2idi / SahaTN): Le patient ${patientName} (${patientPhone}) a annulé son rendez-vous prévu le ${date} à ${time}. Le créneau a été automatiquement libéré sur votre planning.`;

    const emailRecord = {
      id: `eml-doc-cancel-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      category: 'DOCTOR_APPOINTMENT_CANCELLED',
      appointmentId: appointment.id,
      recipientEmail: targetEmail,
      subject,
      status: 'PENDING',
      sentAt: new Date().toISOString()
    };

    try { db.insert('emailLogs', emailRecord); } catch (e) {}

    const delivery = await this.deliverEmail({ to: targetEmail, subject, html, text });
    if (delivery.delivered) {
      try { db.update('emailLogs', e => e.id === emailRecord.id, { status: 'SENT', delivery }); } catch (e) {}
    }
    return { delivery, emailRecord };
  }

  /**
   * 8. Doctor registration request confirmation email
   */
  static async sendDoctorRegistrationConfirmationEmail({
    doctorName,
    email,
    specialty,
    city,
    phone,
    requestId,
    hostUrl = 'http://localhost:5173'
  }) {
    const targetEmail = (email || 'rejabchohra@gmail.com').toLowerCase().trim();
    const cleanDoctorName = (doctorName || 'Docteur').startsWith('Dr.') ? doctorName : `Dr. ${doctorName || 'Docteur'}`;
    const cleanSpecialty = specialty || 'Médecine Générale';
    const cleanCity = city || 'Tunisie';
    const cleanPhone = phone || '+216 00 000 000';
    const refId = requestId || `PRAT-${Date.now().toString().slice(-4)}`;

    const subject = `📋 [SahaTN] Demande reçue : Votre dossier praticien est en cours d'examen (${refId})`;

    const bodyHtml = `
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #1e293b;">Bonjour <strong>${this.escapeHtml(cleanDoctorName)}</strong>,</p>
      <p style="margin: 0 0 18px 0;">
        Nous vous remercions pour votre démarche d'adhésion au réseau national de santé numérique <strong>Maw2idi / SahaTN</strong>. Votre dossier de candidature praticien a été enregistré avec succès et transmis à notre équipe de modération médicale.
      </p>
      ${this.renderCallout({
        tone: 'amber',
        title: '⏳ Statut actuel : En cours d\'examen',
        bodyHtml: `Notre équipe procède au contrôle de conformité réglementaire de vos informations et justificatifs (diplôme, inscription au Conseil de l'Ordre des Médecins, conventionnement CNAM).`
      })}
      ${this.renderInfoTable([
        { label: '📋 Numéro de dossier', value: refId, highlight: true, mono: true },
        { label: '👨‍⚕️ Praticien candidat', value: cleanDoctorName },
        { label: '🩺 Spécialité médicale', value: cleanSpecialty },
        { label: '📍 Gouvernorat &amp; Localité', value: cleanCity },
        { label: '📞 Téléphone de contact', value: cleanPhone },
        { label: '⏱️ Délai indicatif', value: '24h à 48h ouvrées', accent: '#00A896' }
      ], 'Récapitulatif de votre demande')}
      ${this.renderCallout({
        tone: 'teal',
        title: '🔍 Quelles sont les prochaines étapes ?',
        bodyHtml: `
          <div style="margin-bottom: 8px;"><strong>1. Vérification déontologique (En cours) :</strong> Contrôle de vos justificatifs et inscription à l'Ordre des Médecins.</div>
          <div style="margin-bottom: 8px;"><strong>2. Décision administrative :</strong> Vous recevrez un email officiel dès l'examen de votre dossier.</div>
          <div><strong>3. Activation de votre cabinet :</strong> En cas de validation, vous recevrez votre lien personnel sécurisé pour configurer votre mot de passe, votre carte et votre abonnement.</div>
        `
      })}
      ${this.renderCallout({
        tone: 'blue',
        title: 'ℹ️ Information importante',
        bodyHtml: `Aucune action n'est requise de votre part pour le moment. Pour toute question : <strong>support.pro@sahatn.tn</strong> · <strong>+216 71 884 900</strong>.`
      })}`;

    const html = this.renderEmailLayout({
      title: subject,
      badge: 'Maw2idi · Direction Médicale & Ordre des Médecins',
      badgeTone: 'brand',
      heading: 'Demande d\'Inscription Praticien Reçue',
      subtitle: 'Votre dossier est actuellement en cours d\'examen',
      bodyHtml,
      footerNote: `Dossier N° : ${this.escapeHtml(refId)} · Ce message confirme automatiquement la réception de votre dossier.`
    });

    const text = `Bonjour ${cleanDoctorName},\n\nNous avons bien reçu votre demande d'inscription praticien sur Maw2idi / SahaTN (Dossier N° ${refId}). Statut actuel : EN COURS D'EXAMEN. Aucune action n'est requise pour le moment.`;

    const emailRecord = {
      id: `eml-prat-reg-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      category: 'DOCTOR_REGISTRATION_CONFIRMATION',
      requestId: refId,
      recipientEmail: targetEmail,
      recipientName: cleanDoctorName,
      subject,
      status: 'PENDING',
      sentAt: new Date().toISOString(),
      tunisDate: new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Tunis' })
    };

    try { db.insert('emailLogs', emailRecord); } catch (e) {}

    const delivery = await this.deliverEmail({ to: targetEmail, subject, html, text });

    if (delivery.delivered) {
      emailRecord.status = 'SENT';
      emailRecord.delivery = delivery;
      try { db.update('emailLogs', e => e.id === emailRecord.id, { status: 'SENT', delivery }); } catch (e) {}
      console.log(`[EmailService] ✉️ Doctor registration confirmation email sent to ${targetEmail} (MessageId: ${delivery.messageId})`);
    } else {
      emailRecord.status = delivery.error ? 'FAILED' : 'SAVED_IN_DB';
      emailRecord.delivery = delivery;
      try { db.update('emailLogs', e => e.id === emailRecord.id, { status: emailRecord.status, delivery }); } catch (e) {}
      console.warn(`[EmailService] ℹ️ Doctor registration email status for ${targetEmail}:`, delivery);
    }

    return { delivery, emailRecord };
  }

  /**
   * 9. Onboarding completed emails (Doctor + Admin)
   */
  static async sendOnboardingCompletedEmails({ doctorName, email, specialty, city, fee, offer, billingCycle, doctorId, address }) {
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@sahatn.tn';
    const cleanDoctorName = (doctorName || '').replace(/^Dr\.?\s*/i, '').trim() || 'Praticien';
    const salutation = `Dr. ${cleanDoctorName}`;
    const planLabel = (offer || 'PRO').toUpperCase();
    const cycleLabel = billingCycle === 'annual' ? 'Annuel (-15%)' : 'Mensuel';
    const feeDisplay = fee ? `${fee} DT` : '70 DT';
    const loginUrl = `${clientUrl}/doctor/auth`;
    const adminUrl = `${clientUrl}/admin/dashboard?tab=praticiens`;

    const docSubject = `[SahaTN] Félicitations ${salutation} : Votre cabinet est activé et en ligne !`;
    const docBody = `
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #1e293b;">Bonjour <strong>${this.escapeHtml(salutation)}</strong>,</p>
      <p style="margin: 0 0 18px 0;">
        Votre mot de passe confidentiel a été configuré, votre cabinet est positionné sur la carte interactive et votre formule <strong>${this.escapeHtml(planLabel)}</strong> (${cycleLabel}) est activée.
      </p>
      ${this.renderInfoTable([
        { label: '👨‍⚕️ Praticien', value: salutation },
        { label: '🩺 Spécialité', value: specialty || 'Médecine Générale' },
        { label: '📍 Adresse &amp; Ville', value: address || city || 'Tunis' },
        { label: '💰 Tarif consultation', value: feeDisplay },
        { label: '⭐ Formule Maw2idi', value: `${planLabel} · ${cycleLabel}`, accent: '#00A896' }
      ], 'Récapitulatif de votre enregistrement')}
      <p style="font-size: 12px; color: #94a3b8; text-align: center; margin: 16px 0 0 0;">
        Par mesure de sécurité, le lien d'activation initial à usage unique a été définitivement désactivé.
      </p>`;

    const docHtml = this.renderEmailLayout({
      title: docSubject,
      badge: 'Maw2idi · Activation Réussie',
      badgeTone: 'success',
      heading: 'Cabinet Médical Opérationnel ! 🩺',
      subtitle: 'Toutes les étapes d\'activation ont été complétées avec succès.',
      bodyHtml: docBody,
      ctaLabel: 'Accéder à mon Espace Praticien →',
      ctaUrl: loginUrl
    });

    const adminSubject = `[SahaTN Admin] Activation Terminée : ${salutation} a finalisé son onboarding`;
    const adminBody = `
      <p style="margin: 0 0 16px 0;">
        Le praticien <strong>${this.escapeHtml(salutation)}</strong> (${this.escapeHtml(email)}) a validé toutes les étapes d'activation :
      </p>
      ${this.renderInfoTable([
        { label: '🆔 ID Praticien', value: doctorId || 'N/A', mono: true },
        { label: '🩺 Spécialité', value: specialty || 'Généraliste' },
        { label: '📍 Ville', value: city || 'Tunis' },
        { label: '💰 Tarif consultation', value: feeDisplay },
        { label: '⭐ Offre choisie', value: `${planLabel} (${cycleLabel})`, accent: '#00A896' },
        { label: '🕒 Finalisé le', value: new Date().toLocaleString('fr-FR', { timeZone: 'Africa/Tunis' }) }
      ], 'Synthèse Onboarding Praticien')}`;

    const adminHtml = this.renderEmailLayout({
      title: adminSubject,
      badge: 'Alerte Admin · Onboarding',
      badgeTone: 'success',
      heading: 'Onboarding Praticien Finalisé ✅',
      subtitle: `${this.escapeHtml(salutation)} est désormais actif sur la plateforme`,
      bodyHtml: adminBody,
      ctaLabel: 'Voir dans le Tableau de Bord Admin →',
      ctaUrl: adminUrl
    });

    this.deliverEmail({
      to: email,
      subject: docSubject,
      html: docHtml,
      text: `Félicitations ${salutation} ! Votre cabinet médical est désormais actif sur Maw2idi / SahaTN (Formule ${planLabel}). Connectez-vous sur ${loginUrl}`
    }).catch(e => console.warn('[EmailService] Doc success email err:', e.message));

    this.deliverEmail({
      to: adminEmail,
      subject: adminSubject,
      html: adminHtml,
      text: `Activation praticien terminée : ${salutation} (${email}) - ${specialty} - ${city}.`
    }).catch(e => console.warn('[EmailService] Admin success notification err:', e.message));
  }

  /**
   * 10. Onboarding expired emails (Doctor + Admin)
   */
  static async sendOnboardingExpiredEmails({ doctorName, email, requestId, lastStepReached }) {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@sahatn.tn';
    const cleanDoctorName = (doctorName || '').replace(/^Dr\.?\s*/i, '').trim() || 'Praticien';
    const salutation = `Dr. ${cleanDoctorName}`;

    const docSubject = `[SahaTN] Information : Votre session d'activation praticien a expiré`;
    const docBody = `
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #1e293b;">Bonjour <strong>${this.escapeHtml(salutation)}</strong>,</p>
      <p style="margin: 0 0 14px 0;">
        Par mesure de sécurité déontologique et de protection de vos données médicales, le délai alloué de <strong>30 minutes</strong> pour finaliser l'activation de votre cabinet sur Maw2idi / SahaTN s'est écoulé avant validation définitive.
      </p>
      <p style="margin: 0 0 16px 0;">
        <strong>Rassurez-vous :</strong> Vos justificatifs et votre validation par l'administration restent intacts. Vous pouvez demander un nouveau lien d'activation sécurisé en contactant la direction médicale :
      </p>
      ${this.renderCallout({
        tone: 'amber',
        title: '📞 Contacter le support praticiens',
        bodyHtml: `📧 <strong>contact@sahatn.tn</strong> ou <strong>support.pro@sahatn.tn</strong><br>📞 <strong>+216 71 884 900</strong>`
      })}`;

    const docHtml = this.renderEmailLayout({
      title: docSubject,
      badge: '⏱️ Sécurité Médicale',
      badgeTone: 'warning',
      heading: 'Session d\'Activation Expirée (30 min)',
      subtitle: 'Votre dossier reste intact — demandez un nouveau lien sécurisé',
      bodyHtml: docBody,
      footerNote: `Dossier N° : ${this.escapeHtml(requestId || 'N/A')} · Support 7j/7 : support.pro@sahatn.tn`
    });

    const adminSubject = `[SahaTN Admin] Délai dépassé : ${salutation} n'a pas finalisé son activation`;
    const adminBody = `
      <p style="margin: 0 0 16px 0;">
        Le praticien <strong>${this.escapeHtml(salutation)}</strong> (${this.escapeHtml(email)}) n'a pas validé son activation dans le délai de 30 minutes.
      </p>
      ${this.renderInfoTable([
        { label: '👨‍⚕️ Praticien', value: salutation },
        { label: '📧 Email', value: email },
        { label: '📋 Dossier N°', value: requestId || 'N/A', mono: true },
        { label: '📍 Dernière étape atteinte', value: `Étape ${lastStepReached || 1}`, accent: '#b45309' }
      ], 'Suivi Session Expirée')}
      <p style="font-size: 13px; color: #64748b; margin: 0;">
        Si le praticien sollicite une réactivation, vous pourrez relancer un lien sécurisé depuis l'onglet <strong>Praticiens</strong>.
      </p>`;

    const adminHtml = this.renderEmailLayout({
      title: adminSubject,
      badge: '⚠️ Alerte Admin · Expiration',
      badgeTone: 'warning',
      heading: 'Session d\'Activation Expirée',
      subtitle: `${this.escapeHtml(salutation)} · Étape ${lastStepReached || 1}`,
      bodyHtml: adminBody
    });

    this.deliverEmail({
      to: email,
      subject: docSubject,
      html: docHtml,
      text: `Bonjour ${salutation}, votre session d'activation Maw2idi / SahaTN (30 min) a expiré. Contactez support.pro@sahatn.tn pour recevoir un nouveau lien.`
    }).catch(e => console.warn('[EmailService] Doc expired email err:', e.message));

    this.deliverEmail({
      to: adminEmail,
      subject: adminSubject,
      html: adminHtml,
      text: `Activation expirée : ${salutation} (${email}) - Étape ${lastStepReached || 1}.`
    }).catch(e => console.warn('[EmailService] Admin expired email err:', e.message));
  }

  /**
   * 11. Reactivation requested emails (Admin + Doctor)
   */
  static async sendReactivationRequestedEmails({ doctorName, email, requestId, reason }) {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@sahatn.tn';
    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const cleanDoctorName = (doctorName || '').replace(/^Dr\.?\s*/i, '').trim() || 'Praticien';
    const salutation = `Dr. ${cleanDoctorName}`;
    const adminUrl = `${clientUrl}/admin/dashboard?tab=praticiens`;

    const adminSubject = `[SahaTN Admin] Demande de Réactivation : ${salutation} sollicite un nouveau lien`;
    const adminBody = `
      <p style="margin: 0 0 16px 0;">
        Le praticien <strong>${this.escapeHtml(salutation)}</strong> (${this.escapeHtml(email)}) sollicite un nouveau lien d'activation sécurisé.
      </p>
      ${reason ? this.renderCallout({
        tone: 'teal',
        title: '💬 Motif indiqué par le praticien :',
        bodyHtml: `<em>&laquo; ${this.escapeHtml(reason)} &raquo;</em>`
      }) : ''}`;

    const adminHtml = this.renderEmailLayout({
      title: adminSubject,
      badge: '🔄 Action Requise · Admin',
      badgeTone: 'warning',
      heading: 'Demande de Réactivation de Lien',
      subtitle: `${this.escapeHtml(salutation)} attend un nouveau lien d'onboarding`,
      bodyHtml: adminBody,
      ctaLabel: 'Accéder à l\'Admin pour Réactiver →',
      ctaUrl: adminUrl
    });

    const docSubject = `[SahaTN] Demande de réactivation reçue pour ${salutation}`;
    const docBody = `
      <p style="margin: 0 0 16px 0; font-size: 15px; color: #1e293b;">Bonjour <strong>${this.escapeHtml(salutation)}</strong>,</p>
      <p style="margin: 0 0 14px 0;">
        Votre demande de réactivation du lien d'activation a bien été reçue par notre équipe administrative.
      </p>
      ${this.renderCallout({
        tone: 'teal',
        title: '📨 Traitement en cours',
        bodyHtml: `Dès validation par l'administrateur, vous recevrez un nouvel e-mail contenant votre lien d'activation actif.`
      })}`;

    const docHtml = this.renderEmailLayout({
      title: docSubject,
      badge: 'Maw2idi · Demande Reçue',
      badgeTone: 'info',
      heading: 'Demande de Réactivation Transmise 📨',
      subtitle: 'Notre équipe administrative traite votre demande',
      bodyHtml: docBody,
      footerNote: `Dossier N° : ${this.escapeHtml(requestId || 'N/A')} · Support 7j/7 : support@sahatn.tn`
    });

    this.deliverEmail({
      to: adminEmail,
      subject: adminSubject,
      html: adminHtml,
      text: `Demande de réactivation reçue de ${salutation} (${email}). Motif: ${reason || 'Non spécifié'}`
    }).catch(e => console.warn('[EmailService] Admin reactivation request err:', e.message));

    this.deliverEmail({
      to: email,
      subject: docSubject,
      html: docHtml,
      text: `Bonjour ${salutation}, votre demande de réactivation Maw2idi / SahaTN a été transmise à l'administrateur.`
    }).catch(e => console.warn('[EmailService] Doc reactivation receipt err:', e.message));
  }
}

module.exports = EmailService;
