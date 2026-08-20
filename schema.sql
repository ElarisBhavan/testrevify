-- ═══════════════════════════════════════════════════════════════════════
-- RevifyRCM — database schema
-- Postgres 14+. Run once against your database.
--
-- Written for a HIPAA-eligible deployment: every table that touches PHI or
-- authentication carries the audit fields §164.312(b) requires.
-- ═══════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid, digest

-- ── accounts ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id              BIGSERIAL PRIMARY KEY,
  username        TEXT UNIQUE NOT NULL,
  email           TEXT,
  phone           TEXT,
  password_hash   TEXT NOT NULL,          -- scrypt$N$salt$hash — never plaintext
  password_set_at TIMESTAMPTZ DEFAULT NOW(),
  role            TEXT NOT NULL CHECK (role IN ('admin','supervisor','provider','scheduler','employee')),
  full_name       TEXT NOT NULL,
  title           TEXT,
  initials        TEXT,
  provider_id     TEXT,
  provider_ref    BIGINT,
  org_id          BIGINT,
  scope           TEXT DEFAULT 'self' CHECK (scope IN ('all','facility','self')),
  status          TEXT DEFAULT 'active' CHECK (status IN ('active','disabled','locked')),
  must_change     BOOLEAN DEFAULT FALSE,
  mfa_enabled     BOOLEAN DEFAULT FALSE,
  mfa_secret      TEXT,
  failed_attempts INT DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  last_login      TIMESTAMPTZ,
  last_login_ip   INET,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS accounts_username_idx ON accounts (LOWER(username));
CREATE INDEX IF NOT EXISTS accounts_org_idx      ON accounts (org_id);

-- the last few hashes, so a rotation cannot reuse a recent password
CREATE TABLE IF NOT EXISTS password_history (
  id         BIGSERIAL PRIMARY KEY,
  account_id BIGINT REFERENCES accounts(id) ON DELETE CASCADE,
  hash       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS pwhist_acct_idx ON password_history (account_id, created_at DESC);

-- ── sessions ──────────────────────────────────────────────────────────
-- Server-held so a sign-out is real: the row goes, the token dies.
-- This is what makes cross-device sign-out possible.
CREATE TABLE IF NOT EXISTS sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   BIGINT REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,             -- sha256 of the cookie value, never the value
  device_label TEXT,
  ip           INET,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  last_seen    TIMESTAMPTZ DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  revoked_by   TEXT,
  revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS sessions_token_idx ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_acct_idx  ON sessions (account_id, revoked_at, expires_at);

-- ── password reset ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reset_tokens (
  token_hash TEXT PRIMARY KEY,            -- hashed; the raw token only ever exists in the email
  account_id BIGINT REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  ip         INET,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── audit log ─────────────────────────────────────────────────────────
-- §164.312(b): record and examine activity in systems containing PHI.
-- Append only. Never UPDATE or DELETE rows here.
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ DEFAULT NOW(),
  actor_id     BIGINT,
  actor        TEXT,
  action       TEXT NOT NULL,             -- login, login_failed, view_patient, export, ...
  entity       TEXT,                      -- patient, claim, account, ...
  entity_id    TEXT,
  phi_accessed BOOLEAN DEFAULT FALSE,
  outcome      TEXT DEFAULT 'success',
  ip           INET,
  user_agent   TEXT,
  detail       JSONB
);
CREATE INDEX IF NOT EXISTS audit_at_idx     ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_actor_idx  ON audit_log (actor_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_entity_idx ON audit_log (entity, entity_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_phi_idx    ON audit_log (phi_accessed, at DESC) WHERE phi_accessed;

REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;

-- ── throttling, per identifier and per address ────────────────────────
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket     TEXT PRIMARY KEY,            -- e.g. login:alice or login-ip:203.0.113.4
  hits       INT DEFAULT 0,
  window_at  TIMESTAMPTZ DEFAULT NOW(),
  blocked_until TIMESTAMPTZ
);

-- ── organizations, providers, patients, encounters, claims ────────────
CREATE TABLE IF NOT EXISTS organizations (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL, dba TEXT, md TEXT, specialty TEXT,
  npi TEXT, tax_id TEXT, taxonomy TEXT,
  phone TEXT, billing_phone TEXT, appt_phone TEXT,
  addresses JSONB DEFAULT '[]'::jsonb,
  created_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS providers (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL, first_name TEXT, last_name TEXT, title TEXT,
  email TEXT, phone TEXT, billing_phone TEXT, specialty TEXT,
  npi TEXT, taxonomy TEXT, license TEXT, state TEXT, dea TEXT, caqh TEXT,
  availability TEXT, favourite_cpt TEXT, address TEXT,
  telehealth BOOLEAN DEFAULT FALSE, code TEXT, initials TEXT,
  remarks JSONB DEFAULT '[]'::jsonb,
  created_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS providers_org_idx ON providers (org_id);

-- PHI. Encrypt the tablespace or the whole volume; see COMPLIANCE.md.
CREATE TABLE IF NOT EXISTS patients (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
  internal_id TEXT,
  first_name TEXT, middle_name TEXT, last_name TEXT NOT NULL,
  dob DATE, sex TEXT, phone TEXT, email TEXT, address TEXT,
  relationship TEXT DEFAULT 'Self',
  sub_first TEXT, sub_last TEXT, sub_dob DATE, sub_phone TEXT,
  sub_email TEXT, sub_employment TEXT, sub_address TEXT,
  preferred_location TEXT, race TEXT, ethnicity TEXT, language TEXT, referred_by TEXT,
  member_id TEXT, payer TEXT,
  insurances JSONB DEFAULT '[]'::jsonb,
  created_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS patients_name_idx ON patients (LOWER(last_name), LOWER(first_name));
CREATE INDEX IF NOT EXISTS patients_org_idx  ON patients (org_id);

CREATE TABLE IF NOT EXISTS appointments (
  id BIGSERIAL PRIMARY KEY,
  org_id BIGINT, provider_id BIGINT REFERENCES providers(id) ON DELETE CASCADE,
  patient_ref BIGINT REFERENCES patients(id) ON DELETE SET NULL,
  date DATE NOT NULL, start_min INT NOT NULL, dur INT DEFAULT 20,
  block_type TEXT DEFAULT 'patient', description TEXT, note TEXT,
  attendees JSONB DEFAULT '[]'::jsonb, organiser_id BIGINT, linked_to BIGINT,
  patient_first TEXT, patient_last TEXT, member_id TEXT, dob DATE,
  kind TEXT DEFAULT 'office', is_new BOOLEAN DEFAULT FALSE,
  copay NUMERIC(10,2) DEFAULT 0, collected BOOLEAN DEFAULT FALSE,
  payer TEXT, reason TEXT, status TEXT DEFAULT 'Scheduled',
  booked_mode TEXT DEFAULT 'A', booked_by TEXT, booked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS appts_date_idx ON appointments (date, provider_id);

CREATE TABLE IF NOT EXISTS encounters (
  id BIGSERIAL PRIMARY KEY,
  patient_ref BIGINT REFERENCES patients(id) ON DELETE CASCADE,
  appt_id BIGINT, dos DATE NOT NULL,
  clinician TEXT, clinician_id BIGINT, pos TEXT DEFAULT '11',
  status TEXT DEFAULT 'open' CHECK (status IN ('open','locked')),
  lines JSONB DEFAULT '[]'::jsonb, billing JSONB DEFAULT '{}'::jsonb,
  locked_at TIMESTAMPTZ, locked_by TEXT,
  created_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS enc_patient_idx ON encounters (patient_ref, dos DESC);

CREATE TABLE IF NOT EXISTS claims (
  id BIGSERIAL PRIMARY KEY,
  claim_no TEXT UNIQUE, enc_id BIGINT REFERENCES encounters(id) ON DELETE SET NULL,
  appt_id BIGINT, patient_ref BIGINT REFERENCES patients(id) ON DELETE SET NULL,
  org_id BIGINT, provider_id BIGINT,
  form TEXT DEFAULT 'CMS-1500', dos DATE, pos TEXT,
  payer TEXT, payer_id TEXT, member_id TEXT, group_id TEXT, prior_auth TEXT,
  provider_name TEXT, provider_npi TEXT, org_name TEXT, org_npi TEXT, tax_id TEXT,
  patient_first TEXT, patient_last TEXT, patient_dob DATE, patient_mid TEXT,
  dx JSONB DEFAULT '[]'::jsonb, lines JSONB DEFAULT '[]'::jsonb,
  cms JSONB, ub JSONB,
  total NUMERIC(10,2) DEFAULT 0,
  status TEXT DEFAULT 'submitted',
  history JSONB DEFAULT '[]'::jsonb,
  created_by TEXT, created_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS claims_patient_idx ON claims (patient_ref, dos DESC);
CREATE INDEX IF NOT EXISTS claims_status_idx  ON claims (status, created_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id BIGSERIAL PRIMARY KEY,
  ref TEXT, title TEXT NOT NULL, description TEXT, category TEXT,
  priority TEXT DEFAULT 'med', status TEXT DEFAULT 'open',
  tat_hours INT DEFAULT 24, due TIMESTAMPTZ,
  assignee TEXT, assignee_name TEXT, assignee_role TEXT,
  cc JSONB DEFAULT '[]'::jsonb, cc_names JSONB DEFAULT '[]'::jsonb,
  org_id BIGINT, history JSONB DEFAULT '[]'::jsonb,
  created_by TEXT, from_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks (assignee, status);

-- eligibility responses contain PHI; keep only as long as you need them
CREATE TABLE IF NOT EXISTS eligibility_checks (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT REFERENCES accounts(id) ON DELETE SET NULL,
  patient_ref BIGINT, patient_name TEXT, dob DATE,
  payer TEXT, dos DATE, status TEXT, response JSONB,
  ms INT, created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS elig_acct_idx ON eligibility_checks (account_id, created_at DESC);

-- ── retention ─────────────────────────────────────────────────────────
-- Run daily. Eligibility responses hold PHI with no long-term billing value.
-- Audit rows are kept six years, the HIPAA minimum.
CREATE OR REPLACE FUNCTION rf_retention() RETURNS void AS $$
BEGIN
  DELETE FROM eligibility_checks WHERE created_at < NOW() - INTERVAL '90 days';
  DELETE FROM sessions          WHERE expires_at  < NOW() - INTERVAL '30 days';
  DELETE FROM reset_tokens      WHERE expires_at  < NOW() - INTERVAL '7 days';
  DELETE FROM rate_limits       WHERE window_at   < NOW() - INTERVAL '1 day';
  DELETE FROM audit_log         WHERE at          < NOW() - INTERVAL '6 years';
END;
$$ LANGUAGE plpgsql;


-- ═══════════════════════════════════════════════════════════════════════
-- ReviFlow shared application store
-- Compatibility layer used by the existing browser UI. This is SERVER
-- storage, not IndexedDB. It keeps the UI's flexible record shapes while
-- PostgreSQL remains the single source of truth for every browser/device.
-- ═══════════════════════════════════════════════════════════════════════

CREATE SEQUENCE IF NOT EXISTS app_records_id_seq;

CREATE TABLE IF NOT EXISTS app_records (
  kind         TEXT NOT NULL,
  id           BIGINT NOT NULL DEFAULT nextval('app_records_id_seq'),
  org_id       BIGINT,
  patient_ref  BIGINT,
  provider_id  BIGINT,
  on_date      DATE,
  status       TEXT,
  search       TEXT DEFAULT '',
  source_key   TEXT,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by   TEXT,
  updated_by   TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ,
  PRIMARY KEY (kind,id)
);

CREATE UNIQUE INDEX IF NOT EXISTS app_records_source_key_uq
  ON app_records(kind, source_key)
  WHERE source_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS app_records_kind_idx
  ON app_records(kind, id);

CREATE INDEX IF NOT EXISTS app_records_patient_idx
  ON app_records(kind, patient_ref, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS app_records_date_idx
  ON app_records(kind, on_date, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS app_records_status_idx
  ON app_records(kind, status, id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS app_records_search_idx
  ON app_records USING gin (to_tsvector('simple', coalesce(search,'')));

-- PHI access events generated by /api/data. Kept separate from login/audit
-- events so clinical access can be reviewed independently.
CREATE TABLE IF NOT EXISTS phi_access_log (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ DEFAULT NOW(),
  actor        TEXT,
  actor_id     BIGINT,
  action       TEXT NOT NULL,
  kind         TEXT NOT NULL,
  record_id    BIGINT,
  patient_ref  BIGINT,
  ip           INET,
  user_agent   TEXT,
  detail       JSONB
);

CREATE INDEX IF NOT EXISTS phi_access_at_idx
  ON phi_access_log(at DESC);

CREATE INDEX IF NOT EXISTS phi_access_patient_idx
  ON phi_access_log(patient_ref, at DESC);

CREATE INDEX IF NOT EXISTS phi_access_actor_idx
  ON phi_access_log(actor_id, at DESC);

-- A few missing indexes/constraints used by the shared API.
CREATE INDEX IF NOT EXISTS appointments_patient_idx
  ON appointments(patient_ref, date DESC);

CREATE INDEX IF NOT EXISTS encounters_appt_idx
  ON encounters(appt_id);

CREATE INDEX IF NOT EXISTS eligibility_patient_idx
  ON eligibility_checks(patient_ref, created_at DESC);
