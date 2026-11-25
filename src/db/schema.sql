-- KNOOVIQ Attendance Database Schema for PostgreSQL / Neon
CREATE TABLE IF NOT EXISTS departments (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  code VARCHAR(20) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS employees (
  id SERIAL PRIMARY KEY,
  employee_id VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'EMPLOYEE', -- 'EMPLOYEE', 'HR_ADMIN', 'SUPER_ADMIN'
  department_id INTEGER REFERENCES departments(id) ON DELETE SET NULL,
  department_name VARCHAR(100) NOT NULL,
  designation VARCHAR(100) NOT NULL,
  phone VARCHAR(50),
  joining_date DATE NOT NULL DEFAULT CURRENT_DATE,
  avatar_url TEXT,
  password_hash TEXT,
  password_salt TEXT,
  can_record_attendance BOOLEAN NOT NULL DEFAULT TRUE,
  attendance_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS holidays (
  id SERIAL PRIMARY KEY,
  holiday_date DATE UNIQUE NOT NULL,
  name VARCHAR(150) NOT NULL,
  description TEXT,
  holiday_type VARCHAR(50) DEFAULT 'PUBLIC',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS attendances (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  current_state VARCHAR(50) NOT NULL DEFAULT 'NOT_CHECKED_IN', -- 'NOT_CHECKED_IN', 'CHECKED_IN', 'ON_BREAK', 'CHECKED_OUT'
  check_in TIMESTAMPTZ,
  check_out TIMESTAMPTZ,
  total_work_minutes INTEGER NOT NULL DEFAULT 0,
  total_break_minutes INTEGER NOT NULL DEFAULT 0,
  status VARCHAR(50) NOT NULL DEFAULT 'ABSENT', -- 'PRESENT', 'ABSENT', 'HALF_DAY', 'LEAVE', 'HOLIDAY', 'WEEKLY_OFF'
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_emp_workdate UNIQUE (employee_id, work_date)
);

CREATE TABLE IF NOT EXISTS attendance_breaks (
  id SERIAL PRIMARY KEY,
  attendance_id INTEGER NOT NULL REFERENCES attendances(id) ON DELETE CASCADE,
  break_start TIMESTAMPTZ NOT NULL,
  break_end TIMESTAMPTZ,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  request_type VARCHAR(50) NOT NULL, -- 'LEAVE', 'HOLIDAY', 'REGULARIZATION', 'WFH', 'OTHER'
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'APPROVED', 'REJECTED'
  submission_date TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decision_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  decision_date TIMESTAMPTZ,
  decision_remarks TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  recipient_id INTEGER REFERENCES employees(id) ON DELETE CASCADE, -- NULL means company-wide
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'ANNOUNCEMENT', -- 'ATTENDANCE', 'REQUEST', 'HOLIDAY', 'ANNOUNCEMENT'
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS office_locations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL DEFAULT 'KNOOVIQ HQ, Bengaluru',
  latitude DECIMAL(9,6) NOT NULL DEFAULT 12.971598,
  longitude DECIMAL(9,6) NOT NULL DEFAULT 77.594566,
  radius_m INTEGER NOT NULL DEFAULT 100,
  max_accuracy_m INTEGER NOT NULL DEFAULT 50,
  address TEXT DEFAULT 'KNOOVIQ Tech Tower, Outer Ring Rd, Bengaluru, Karnataka 560103',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by INTEGER REFERENCES employees(id),
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS application_audit_log (
  id SERIAL PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES employees(id),
  action VARCHAR(50) NOT NULL, -- 'approve', 'reject', 'override'
  old_status VARCHAR(50),
  new_status VARCHAR(50),
  remark TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_attendances_emp_date ON attendances(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_attendances_work_date ON attendances(work_date);
CREATE INDEX IF NOT EXISTS idx_requests_employee ON requests(employee_id);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id);
CREATE INDEX IF NOT EXISTS idx_audit_app ON application_audit_log(application_id);

-- Multi-office administration; additive migration for existing installations.
ALTER TABLE office_locations ALTER COLUMN radius_m SET DEFAULT 100;
ALTER TABLE office_locations ADD COLUMN IF NOT EXISTS timezone VARCHAR(100) NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE office_locations ADD COLUMN IF NOT EXISTS office_ips JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE office_locations ADD COLUMN IF NOT EXISTS wifi_attendance_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE office_locations ADD COLUMN IF NOT EXISTS office_public_ip TEXT;
ALTER TABLE office_locations ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS office_id INTEGER REFERENCES office_locations(id) ON DELETE SET NULL;
UPDATE office_locations SET is_primary = TRUE
  WHERE id = (SELECT id FROM office_locations WHERE is_active = TRUE ORDER BY id DESC LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM office_locations WHERE is_primary = TRUE AND is_active = TRUE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_primary_office ON office_locations(is_primary) WHERE is_primary = TRUE AND is_active = TRUE;
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES employees(id),
  action VARCHAR(60) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INTEGER NOT NULL,
  before_data JSONB,
  after_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Reading a company announcement must not mark it read for other employees.
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  read_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (notification_id, employee_id)
);

-- Preserve recorded work mode when migrating existing application records.
ALTER TABLE attendances ADD COLUMN IF NOT EXISTS mode VARCHAR(50);

-- One-time: raise the default GPS accuracy tolerance from 50 m to 75 m (faster punches). Later admin changes are kept.
UPDATE office_locations SET max_accuracy_m = 75
  WHERE max_accuracy_m = 50
  AND NOT EXISTS (SELECT 1 FROM admin_audit_log WHERE action = 'MIGRATE_ACCURACY_75');
INSERT INTO admin_audit_log (actor_id, action, entity_type, entity_id, before_data, after_data)
  SELECT NULL, 'MIGRATE_ACCURACY_75', 'office_location', 0, '{"max_accuracy_m":50}', '{"max_accuracy_m":75}'
  WHERE NOT EXISTS (SELECT 1 FROM admin_audit_log WHERE action = 'MIGRATE_ACCURACY_75');

-- Preserve the old effective limit on existing offices. Higher limits require an admin save.
UPDATE office_locations SET max_accuracy_m = 75
  WHERE max_accuracy_m > 75
  AND NOT EXISTS (SELECT 1 FROM admin_audit_log WHERE action = 'MIGRATE_ACCURACY_OPT_IN');
INSERT INTO admin_audit_log (actor_id, action, entity_type, entity_id, after_data)
  SELECT NULL, 'MIGRATE_ACCURACY_OPT_IN', 'office_location', 0, '{"existing_max_accuracy_m":75}'
  WHERE NOT EXISTS (SELECT 1 FROM admin_audit_log WHERE action = 'MIGRATE_ACCURACY_OPT_IN');

-- HR onboarding: extended employee record and company assets issued to employees.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_contact_name VARCHAR(150);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS emergency_contact_phone VARCHAR(50);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES employees(id) ON DELETE SET NULL;
-- "Others": free-form extra fields HR can add per employee, stored as [{label, value}].
ALTER TABLE employees ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS company_assets (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  asset_type VARCHAR(50) NOT NULL,
  asset_name VARCHAR(150) NOT NULL,
  asset_tag VARCHAR(100),
  serial_number VARCHAR(150),
  condition VARCHAR(50) NOT NULL DEFAULT 'GOOD',
  issued_date DATE NOT NULL DEFAULT CURRENT_DATE,
  returned_date DATE,
  notes TEXT,
  issued_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_company_assets_employee ON company_assets(employee_id);
-- An asset tag can only be assigned to one person at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_assets_active_tag ON company_assets(LOWER(asset_tag)) WHERE returned_date IS NULL AND asset_tag IS NOT NULL;

-- Login identifiers are case-insensitive in the authentication service.
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_email_casefold ON employees(LOWER(email));
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_code_casefold ON employees(LOWER(employee_id));
-- One employee may have only one currently open break on a workday.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_breaks_one_open ON attendance_breaks(attendance_id) WHERE break_end IS NULL;

-- Additive integrity constraints, installed once and validated against existing data.
DO $$
DECLARE rule RECORD;
BEGIN
  FOR rule IN SELECT * FROM (VALUES
    ('attendances','attendance_minutes_nonnegative','total_work_minutes >= 0 AND total_break_minutes >= 0'),
    ('attendances','attendance_punch_order','check_in IS NULL OR check_out IS NULL OR check_out > check_in'),
    ('attendance_breaks','break_minutes_nonnegative','duration_minutes >= 0'),
    ('attendance_breaks','break_time_order','break_end IS NULL OR break_end >= break_start'),
    ('requests','request_date_order','end_date >= start_date'),
    ('company_assets','asset_return_order','returned_date IS NULL OR returned_date >= issued_date'),
    ('office_locations','office_coordinate_range','latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180'),
    ('office_locations','office_positive_limits','radius_m > 0 AND max_accuracy_m > 0'),
    ('office_locations','office_ips_array','jsonb_typeof(office_ips) = ''array'''),
    ('employees','employee_custom_fields_array','jsonb_typeof(custom_fields) = ''array''')
  ) AS rules(table_name,constraint_name,expression)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=rule.constraint_name AND conrelid=format('%I.%I',current_schema(),rule.table_name)::regclass) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s)',rule.table_name,rule.constraint_name,rule.expression);
    END IF;
  END LOOP;
END $$;


-- ============================================================================
-- KNOOVIQ Monthly Salary Management & Payroll Module (integer paise storage)
-- ============================================================================
CREATE TABLE IF NOT EXISTS employee_salaries (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  monthly_salary_paise BIGINT NOT NULL CHECK (monthly_salary_paise > 0),
  effective_from DATE NOT NULL,
  updated_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS employee_salary_history (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  previous_salary_paise BIGINT CHECK (previous_salary_paise IS NULL OR previous_salary_paise > 0),
  updated_salary_paise BIGINT NOT NULL CHECK (updated_salary_paise > 0),
  effective_from DATE NOT NULL,
  updated_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  update_reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_salary_history_emp_eff ON employee_salary_history(employee_id, effective_from DESC, id DESC);

CREATE TABLE IF NOT EXISTS payroll_periods (
  id SERIAL PRIMARY KEY,
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  status VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
  prepared_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  submitted_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ,
  approved_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  rejected_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  authorized_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  authorized_at TIMESTAMPTZ,
  total_employees INTEGER NOT NULL DEFAULT 0,
  total_monthly_salary_paise BIGINT NOT NULL DEFAULT 0,
  total_present_days NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_absent_days NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_deduction_paise BIGINT NOT NULL DEFAULT 0,
  total_payable_paise BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_payroll_period_ym UNIQUE (year, month)
);

CREATE TABLE IF NOT EXISTS payroll_records (
  id SERIAL PRIMARY KEY,
  payroll_period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  employee_name VARCHAR(200) NOT NULL,
  employee_code VARCHAR(50) NOT NULL,
  department_name VARCHAR(100) NOT NULL DEFAULT '',
  designation VARCHAR(100) NOT NULL DEFAULT '',
  monthly_salary_paise BIGINT NOT NULL CHECK (monthly_salary_paise > 0),
  working_days INTEGER NOT NULL DEFAULT 30 CHECK (working_days = 30),
  present_days NUMERIC(5,2) NOT NULL CHECK (present_days >= 0 AND present_days <= 30),
  absent_days NUMERIC(5,2) NOT NULL CHECK (absent_days >= 0 AND absent_days <= 30),
  daily_salary_paise BIGINT NOT NULL CHECK (daily_salary_paise >= 0),
  absent_deduction_paise BIGINT NOT NULL CHECK (absent_deduction_paise >= 0),
  final_payable_paise BIGINT NOT NULL CHECK (final_payable_paise >= 0),
  salary_effective_from DATE,
  attendance_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_payroll_record_emp_period UNIQUE (payroll_period_id, employee_id),
  CONSTRAINT payroll_record_days_sum CHECK (present_days + absent_days = 30)
);
CREATE INDEX IF NOT EXISTS idx_payroll_records_period ON payroll_records(payroll_period_id);
CREATE INDEX IF NOT EXISTS idx_payroll_records_employee ON payroll_records(employee_id);

CREATE TABLE IF NOT EXISTS payroll_approvals (
  id SERIAL PRIMARY KEY,
  payroll_period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  action VARCHAR(30) NOT NULL,
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payroll_approvals_period ON payroll_approvals(payroll_period_id);

CREATE TABLE IF NOT EXISTS employee_bank_accounts (
  id SERIAL PRIMARY KEY,
  employee_id INTEGER NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  account_holder_name VARCHAR(150) NOT NULL,
  bank_name VARCHAR(150) NOT NULL,
  account_number_encrypted TEXT NOT NULL,
  account_number_masked VARCHAR(30) NOT NULL,
  ifsc_code VARCHAR(20) NOT NULL,
  account_type VARCHAR(30) NOT NULL DEFAULT 'SAVINGS',
  is_verified BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS salary_payments (
  id SERIAL PRIMARY KEY,
  payroll_period_id INTEGER NOT NULL REFERENCES payroll_periods(id) ON DELETE RESTRICT,
  payroll_record_id INTEGER NOT NULL UNIQUE REFERENCES payroll_records(id) ON DELETE RESTRICT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  bank_account_id INTEGER REFERENCES employee_bank_accounts(id) ON DELETE SET NULL,
  amount_paise BIGINT NOT NULL CHECK (amount_paise >= 0),
  idempotency_key VARCHAR(120) NOT NULL UNIQUE,
  provider VARCHAR(30) NOT NULL,
  provider_payout_id VARCHAR(120),
  provider_utr VARCHAR(120),
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  failure_reason TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  authorized_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  authorized_at TIMESTAMPTZ,
  initiated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_salary_payments_period ON salary_payments(payroll_period_id);
CREATE INDEX IF NOT EXISTS idx_salary_payments_status ON salary_payments(status);
CREATE INDEX IF NOT EXISTS idx_salary_payments_provider_payout ON salary_payments(provider_payout_id) WHERE provider_payout_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_transactions (
  id SERIAL PRIMARY KEY,
  salary_payment_id INTEGER NOT NULL REFERENCES salary_payments(id) ON DELETE CASCADE,
  provider VARCHAR(30) NOT NULL,
  idempotency_key VARCHAR(120) NOT NULL,
  request_type VARCHAR(30) NOT NULL,
  provider_reference_id VARCHAR(120),
  status VARCHAR(30) NOT NULL,
  http_status INTEGER,
  response_payload JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payment_tx_payment ON payment_transactions(salary_payment_id);

CREATE TABLE IF NOT EXISTS payment_webhook_logs (
  id SERIAL PRIMARY KEY,
  provider VARCHAR(30) NOT NULL,
  event_id VARCHAR(150),
  event_type VARCHAR(100),
  signature_valid BOOLEAN NOT NULL DEFAULT FALSE,
  payload JSONB NOT NULL,
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  processing_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_provider_event ON payment_webhook_logs(provider, event_id) WHERE event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payroll_audit_logs (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  action VARCHAR(60) NOT NULL,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INTEGER NOT NULL,
  before_data JSONB,
  after_data JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payroll_audit_entity ON payroll_audit_logs(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS payment_provider_settings (
  provider VARCHAR(30) PRIMARY KEY,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  mode VARCHAR(20) NOT NULL DEFAULT 'TEST',
  account_identifier VARCHAR(120),
  webhook_url TEXT,
  updated_by INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO payment_provider_settings (provider, is_active, mode)
  VALUES ('RAZORPAYX', TRUE, 'TEST'), ('CASHFREE', FALSE, 'TEST')
  ON CONFLICT (provider) DO NOTHING;
