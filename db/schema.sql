-- ============================================================================
-- SahaTN / Maw2idi — PostgreSQL Relational Schema
-- Conforme aux spécifications INPDP et architecture e-Santé Tunisie
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
    uuid VARCHAR(64) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(32) DEFAULT 'PATIENT',
    doctor_id VARCHAR(64),
    phone VARCHAR(64),
    avatar TEXT,
    cv_file_name VARCHAR(255),
    cv_file_data TEXT,
    signature TEXT,
    signature_data TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS doctors (
    id VARCHAR(64) PRIMARY KEY,
    uuid VARCHAR(64),
    name VARCHAR(255) NOT NULL,
    title VARCHAR(64) DEFAULT 'Dr.',
    specialty VARCHAR(255),
    specialty_fr VARCHAR(255),
    specialty_ar VARCHAR(255),
    specialty_id VARCHAR(64),
    city VARCHAR(128),
    delegation VARCHAR(128),
    address TEXT,
    phone VARCHAR(64),
    email VARCHAR(255),
    fee VARCHAR(64) DEFAULT '70 TND',
    cnam BOOLEAN DEFAULT TRUE,
    cnam_reimbursement VARCHAR(64),
    cnam_type VARCHAR(64),
    cnam_code VARCHAR(64),
    insurance_accepted BOOLEAN DEFAULT TRUE,
    telehealth BOOLEAN DEFAULT FALSE,
    rating NUMERIC(3,2) DEFAULT 5.0,
    reviews_count INTEGER DEFAULT 0,
    review_count INTEGER DEFAULT 0,
    avatar TEXT,
    cv_file_name VARCHAR(255),
    cv_file_data TEXT,
    signature TEXT,
    signature_data TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS appointments (
    id VARCHAR(64) PRIMARY KEY,
    patient_id VARCHAR(64),
    patient_name VARCHAR(255),
    patient_phone VARCHAR(64),
    doctor_id VARCHAR(64),
    doctor_name VARCHAR(255),
    specialty VARCHAR(255),
    date VARCHAR(32),
    time VARCHAR(32),
    type VARCHAR(32) DEFAULT 'PRESENTIEL',
    fee VARCHAR(64) DEFAULT '70 TND',
    ticket_number VARCHAR(64),
    status VARCHAR(32) DEFAULT 'CONFIRMED',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS queue (
    id VARCHAR(64) PRIMARY KEY,
    doctor_id VARCHAR(64),
    ticket_number VARCHAR(64),
    patient_name VARCHAR(255),
    status VARCHAR(32) DEFAULT 'WAITING',
    position INTEGER DEFAULT 1,
    estimated_wait_minutes INTEGER DEFAULT 15,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS patient_health_records (
    id VARCHAR(64) PRIMARY KEY,
    patient_id VARCHAR(64) UNIQUE,
    blood_type VARCHAR(16),
    allergies TEXT,
    chronic_conditions TEXT,
    emergency_contact JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS medical_documents (
    id VARCHAR(64) PRIMARY KEY,
    patient_id VARCHAR(64),
    doctor_id VARCHAR(64),
    title VARCHAR(255),
    document_type VARCHAR(64),
    file_url TEXT,
    file_name VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dependents (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64),
    name VARCHAR(255),
    relationship VARCHAR(64),
    date_of_birth VARCHAR(32),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS prescriptions (
    id VARCHAR(64) PRIMARY KEY,
    appointment_id VARCHAR(64),
    patient_id VARCHAR(64),
    doctor_id VARCHAR(64),
    medications JSONB,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reviews (
    id VARCHAR(64) PRIMARY KEY,
    doctor_id VARCHAR(64),
    patient_id VARCHAR(64),
    patient_name VARCHAR(255),
    rating NUMERIC(3,2) DEFAULT 5.0,
    comment TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS praticien_requests (
    id VARCHAR(64) PRIMARY KEY,
    uuid VARCHAR(64),
    name VARCHAR(255),
    firstname VARCHAR(255),
    lastname VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(64),
    postal VARCHAR(32),
    objet TEXT,
    spec VARCHAR(255),
    specialty_id VARCHAR(64),
    city VARCHAR(128),
    delegation VARCHAR(128),
    address TEXT,
    ordre VARCHAR(64),
    cnam BOOLEAN DEFAULT TRUE,
    cv_file_name VARCHAR(255),
    cv_file_data TEXT,
    avatar TEXT,
    fee VARCHAR(64) DEFAULT '70 TND',
    date VARCHAR(32),
    status VARCHAR(32) DEFAULT 'PENDING',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    tunis_time VARCHAR(64),
    prev_hash VARCHAR(128),
    hash VARCHAR(128),
    action VARCHAR(255),
    actor JSONB,
    resource VARCHAR(255),
    client_ip VARCHAR(64),
    status VARCHAR(64),
    details TEXT,
    compliance VARCHAR(128) DEFAULT 'INPDP_TUNISIE_2004_63'
);

CREATE TABLE IF NOT EXISTS revoked_tokens (
    id VARCHAR(64) PRIMARY KEY,
    token TEXT,
    expires_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS claims (
    id VARCHAR(64) PRIMARY KEY,
    patient_id VARCHAR(64),
    doctor_id VARCHAR(64),
    appointment_id VARCHAR(64),
    amount VARCHAR(64),
    cnam_code VARCHAR(64),
    status VARCHAR(32) DEFAULT 'PENDING',
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Doctor Subscriptions & Offline Payments (Tunisia: RIB / D17 / Poste / Chèque / Espèces)
CREATE TABLE IF NOT EXISTS doctor_subscriptions (
    id VARCHAR(64) PRIMARY KEY,
    doctor_id VARCHAR(64) UNIQUE NOT NULL,
    plan_id VARCHAR(64) NOT NULL,
    plan_name VARCHAR(128),
    billing_cycle VARCHAR(16) DEFAULT 'monthly',
    status VARCHAR(32) DEFAULT 'pending',
    starts_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    last_payment_id VARCHAR(64),
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS offline_payments (
    id VARCHAR(64) PRIMARY KEY,
    reference_code VARCHAR(64) UNIQUE NOT NULL,
    doctor_id VARCHAR(64) NOT NULL,
    doctor_name VARCHAR(255),
    doctor_email VARCHAR(255),
    plan_id VARCHAR(64) NOT NULL,
    plan_name VARCHAR(128),
    billing_cycle VARCHAR(16) DEFAULT 'monthly',
    amount_tnd NUMERIC(10,2) NOT NULL,
    method VARCHAR(32) NOT NULL,
    transaction_ref VARCHAR(128),
    receipt_url TEXT,
    notes TEXT,
    status VARCHAR(32) DEFAULT 'pending',
    reviewed_by VARCHAR(128),
    reviewed_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_offline_payments_doctor ON offline_payments(doctor_id);
CREATE INDEX IF NOT EXISTS idx_offline_payments_status ON offline_payments(status);
CREATE INDEX IF NOT EXISTS idx_doctor_subscriptions_doctor ON doctor_subscriptions(doctor_id);

-- Additional synced tables for 100% PostgreSQL persistence
CREATE TABLE IF NOT EXISTS notifications (
    id VARCHAR(64) PRIMARY KEY,
    space VARCHAR(32) DEFAULT 'admin',
    category VARCHAR(64),
    title VARCHAR(255),
    message TEXT,
    read BOOLEAN DEFAULT FALSE,
    payload JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS doctor_schedules (
    doctor_id VARCHAR(64) PRIMARY KEY,
    schedule JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS referral_letters (
    id VARCHAR(64) PRIMARY KEY,
    from_doctor_id VARCHAR(64),
    to_doctor_id VARCHAR(64),
    patient_id VARCHAR(64),
    patient_name VARCHAR(255),
    status VARCHAR(32) DEFAULT 'UNREAD',
    payload JSONB,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Mobile Push Notification Device Tokens (Firebase Cloud Messaging)
CREATE TABLE IF NOT EXISTS device_tokens (
    fcm_token TEXT PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    role VARCHAR(32) DEFAULT 'PATIENT',
    doctor_id VARCHAR(64),
    lang VARCHAR(8) DEFAULT 'fr',
    platform VARCHAR(32) DEFAULT 'android',
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_device_tokens_doctor ON device_tokens(doctor_id);

-- Idempotent column upgrades for existing tables (safe to re-run)
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
ALTER TABLE doctors ADD COLUMN IF NOT EXISTS account_finalized BOOLEAN DEFAULT TRUE;
ALTER TABLE praticien_requests ADD COLUMN IF NOT EXISTS signature TEXT;
ALTER TABLE praticien_requests ADD COLUMN IF NOT EXISTS signature_data TEXT;
ALTER TABLE praticien_requests ADD COLUMN IF NOT EXISTS doctor_id VARCHAR(64);
ALTER TABLE praticien_requests ADD COLUMN IF NOT EXISTS account_finalized BOOLEAN DEFAULT FALSE;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS status VARCHAR(32) DEFAULT 'PUBLIÉ';
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE queue ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE patient_health_records ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE medical_documents ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE dependents ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE claims ADD COLUMN IF NOT EXISTS payload JSONB;

-- ============================================================================
-- ROW-LEVEL SECURITY (RLS) POLICIES — INPDP Loi N° 2004-63
-- Enforces tenant/patient/doctor isolation when querying with a non-superuser role
-- (Set session vars per transaction: SET LOCAL app.current_user_id, app.current_user_role, app.current_doctor_id)
-- ============================================================================
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_health_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE prescriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'appointments' AND policyname = 'appointments_isolation_policy') THEN
    CREATE POLICY appointments_isolation_policy ON appointments
      USING (
        current_setting('app.current_user_role', true) IN ('ADMIN', 'SUPER_ADMIN', 'SYSTEM')
        OR patient_id = current_setting('app.current_user_id', true)
        OR doctor_id = current_setting('app.current_doctor_id', true)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'patient_health_records' AND policyname = 'ehr_isolation_policy') THEN
    CREATE POLICY ehr_isolation_policy ON patient_health_records
      USING (
        current_setting('app.current_user_role', true) IN ('ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'PRATICIEN', 'SYSTEM')
        OR patient_id = current_setting('app.current_user_id', true)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'prescriptions' AND policyname = 'prescriptions_isolation_policy') THEN
    CREATE POLICY prescriptions_isolation_policy ON prescriptions
      USING (
        current_setting('app.current_user_role', true) IN ('ADMIN', 'SUPER_ADMIN', 'SYSTEM')
        OR patient_id = current_setting('app.current_user_id', true)
        OR doctor_id = current_setting('app.current_doctor_id', true)
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'audit_logs' AND policyname = 'audit_logs_admin_only_policy') THEN
    CREATE POLICY audit_logs_admin_only_policy ON audit_logs
      USING (
        current_setting('app.current_user_role', true) IN ('ADMIN', 'SUPER_ADMIN', 'SYSTEM')
      );
  END IF;
END
$$;
