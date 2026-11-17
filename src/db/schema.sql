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
  radius_m INTEGER NOT NULL DEFAULT 15,
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
ALTER TABLE office_locations ADD COLUMN IF NOT EXISTS timezone VARCHAR(100) NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE office_locations ADD COLUMN IF NOT EXISTS office_ips JSONB NOT NULL DEFAULT '[]'::jsonb;
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
