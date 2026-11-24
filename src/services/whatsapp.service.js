/**
 * ============================================================================
 * SahaTN / Maw2idi — Real WhatsApp Mobile Dispatch Service (UltraMsg Gateway)
 * ============================================================================
 * Sends REAL WhatsApp messages to physical mobile numbers (patient & doctor)
 * using the UltraMsg REST API Gateway (scanned directly from clinic WhatsApp).
 */

class WhatsAppService {
  constructor() {
    this.instanceId = (process.env.ULTRAMSG_INSTANCE_ID || '').trim();
    this.token = (process.env.ULTRAMSG_TOKEN || '').trim();
    this.enabled = process.env.ENABLE_REAL_WHATSAPP !== 'false';
  }

  /**
   * Normalize and format any phone number into international E.164 format
   * Supports Tunisian 8-digit mobile numbers (e.g. 98 123 456 -> +21698123456)
   */
  formatPhone(phone) {
    if (!phone) return null;
    let clean = String(phone).replace(/[^0-9]/g, '');
    
    // Tunisian 8-digit phone without country code
    if (clean.length === 8) {
      return `+216${clean}`;
    }
    // Tunisian phone starting with 216
    if (clean.startsWith('216') && clean.length === 11) {
      return `+${clean}`;
    }
    // Starting with 00 (e.g. 00216...)
    if (clean.startsWith('00')) {
      return `+${clean.substring(2)}`;
    }
    return phone.startsWith('+') ? phone : `+${clean}`;
  }

  /**
   * Check if real WhatsApp credentials are fully configured
   */
  isConfigured() {
    return Boolean(this.instanceId && this.token && !this.instanceId.includes('YOUR_'));
  }

  /**
   * Send a real WhatsApp text message to any physical mobile phone
   * @param {Object} params
   * @param {string} params.to - Recipient phone number (e.g. +21698123456)
   * @param {string} params.body - Text message content
   * @param {number} [params.priority=10] - 1 to 10
   */
  async sendTextMessage({ to, body, priority = 10 }) {
    const formattedTo = this.formatPhone(to);
    if (!formattedTo) {
      console.warn('[WhatsAppService] ⚠️ Invalid recipient phone number:', to);
      return { success: false, error: 'Numéro de téléphone invalide' };
    }

    if (!body || !body.trim()) {
      return { success: false, error: 'Contenu du message vide' };
    }

    // If not configured, gracefully simulate and log setup instructions
    if (!this.isConfigured() || !this.enabled) {
      console.log(`[WhatsAppService-SIMULATED] 📱 To: ${formattedTo}`);
      console.log(`[WhatsAppService-SIMULATED] 💬 Body:\n${body}`);
      console.log('[WhatsAppService] ℹ️ To send REAL WhatsApp messages to this phone, add your ULTRAMSG_INSTANCE_ID and ULTRAMSG_TOKEN in your .env file.');
      return {
        success: true,
        simulated: true,
        to: formattedTo,
        message: 'Message simulé avec succès. Pour livraison mobile réelle, configurez ULTRAMSG_INSTANCE_ID et ULTRAMSG_TOKEN dans .env.'
      };
    }

    // Call real UltraMsg API endpoint
    try {
      const url = `https://api.ultramsg.com/${this.instanceId}/messages/chat`;
      const payload = {
        token: this.token,
        to: formattedTo,
        body: body.trim(),
        priority: priority
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok && (data.sent === 'true' || data.sent === true || data.id)) {
        console.log(`[WhatsAppService] 🚀 REAL WhatsApp message delivered to ${formattedTo}! (ID: ${data.id || 'OK'})`);
        return {
          success: true,
          real: true,
          messageId: data.id,
          to: formattedTo,
          data
        };
      } else {
        console.error(`[WhatsAppService] ❌ UltraMsg API error to ${formattedTo}:`, data);
        return {
          success: false,
          error: data.error || data.message || 'Erreur UltraMsg',
          details: data
        };
      }
    } catch (err) {
      console.error(`[WhatsAppService] ❌ Network error sending WhatsApp to ${formattedTo}:`, err.message);
      return {
        success: false,
        error: err.message
      };
    }
  }

  /**
   * Helper: Dispatch automated appointment confirmation WhatsApp to patient
   */
  async sendAppointmentConfirmationToPatient({
    patientName,
    patientPhone,
    doctorName,
    doctorSpecialty,
    date,
    time,
    ticketNumber,
    address = 'Cabinet Médical, Tunisie'
  }) {
    const isAr = /[\u0600-\u06FF]/.test(patientName) || /[\u0600-\u06FF]/.test(date);
    
    const body = isAr
      ? `مرحباً ${patientName} 🩺،\nتم تأكيد موعدك الطبي بنجاح عبر منصة SahaTN.\n\n👨‍⚕️ الطبيب: ${doctorName} (${doctorSpecialty || 'أخصائي'})\n📅 التاريخ: ${date}\n⏰ التوقيت: ${time}\n🎫 تذكرة الانتظار: ${ticketNumber || 'N° 01'}\n📍 العنوان: ${address}\n\nيرجى الحضور قبل الموعد بـ 10 دقائق. نتمنى لكم دوام الصحة والعافية.`
      : `Bonjour ${patientName} 🩺,\nVotre rendez-vous médical a été confirmé avec succès sur SahaTN.\n\n👨‍⚕️ Praticien: ${doctorName} (${doctorSpecialty || 'Spécialiste'})\n📅 Date: ${date}\n⏰ Heure: ${time}\n🎫 Ticket: ${ticketNumber || 'N° 01'}\n📍 Lieu: ${address}\n\nMerci de vous présenter 10 minutes à l'avance. Prenez soin de vous !`;

    return this.sendTextMessage({ to: patientPhone, body, priority: 10 });
  }

  /**
   * Helper: Dispatch automated appointment alert WhatsApp to doctor's physical mobile
   */
  async sendAppointmentNotificationToDoctor({
    doctorName,
    doctorPhone,
    patientName,
    patientPhone,
    date,
    time,
    ticketNumber,
    type = 'CABINET'
  }) {
    if (!doctorPhone) return { success: false, error: 'Numéro de mobile du médecin non renseigné' };

    const body = `🩺 *SahaTN - Nouveau Rendez-vous Reçu*\n\nDocteur ${doctorName},\nUn nouveau patient a réservé un créneau sur votre planning :\n\n👤 Patient: *${patientName}*\n📞 Tél: ${patientPhone || 'Non renseigné'}\n📅 Date: *${date}*\n⏰ Heure: *${time}*\n🏷️ Type: ${type}\n🎫 Ticket: ${ticketNumber}\n\nCe rendez-vous est synchronisé dans votre Agenda SahaTN.`;

    return this.sendTextMessage({ to: doctorPhone, body, priority: 8 });
  }

  /**
   * Diagnostic: Check UltraMsg instance connectivity and authentication
   */
  async checkInstanceStatus() {
    if (!this.isConfigured()) {
      return {
        configured: false,
        message: 'Identifiants UltraMsg non configurés dans .env'
      };
    }

    try {
      const url = `https://api.ultramsg.com/${this.instanceId}/instance/status?token=${this.token}`;
      const response = await fetch(url);
      const data = await response.json();
      return {
        configured: true,
        status: data?.status || data,
        authenticated: data?.status?.account_status === 'authenticated'
      };
    } catch (err) {
      return {
        configured: true,
        authenticated: false,
        error: err.message
      };
    }
  }
}

module.exports = new WhatsAppService();

