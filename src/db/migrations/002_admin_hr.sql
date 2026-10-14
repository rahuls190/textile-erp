-- ═══════════ Admin: login hardening, role revocation, permission catalogue ═══════════
ALTER TABLE app_user
  ADD COLUMN email                text,
  ADD COLUMN failed_attempts      int NOT NULL DEFAULT 0,
  ADD COLUMN locked_until         timestamptz,
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN last_login_at        timestamptz,
  ADD COLUMN password_changed_at  timestamptz;

ALTER TABLE user_role
  ADD COLUMN granted_by uuid,
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_by uuid;

ALTER TABLE role ADD COLUMN is_system boolean NOT NULL DEFAULT true;

CREATE TABLE permission_def (
  key      text PRIMARY KEY,
  area     text NOT NULL,
  label    text NOT NULL,
  bandable boolean NOT NULL DEFAULT false
);

-- Every sign-in attempt, successful or not (kept apart from the business audit log)
CREATE TABLE login_event (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  username text NOT NULL,
  user_id  uuid,
  ok       boolean NOT NULL,
  reason   text
);

-- ═══════════ HR master data ═══════════
CREATE TABLE department (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL
);
CREATE TABLE designation (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code  text NOT NULL UNIQUE,
  name  text NOT NULL,
  grade text
);
CREATE TABLE shift (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  start_time  time NOT NULL,
  end_time    time NOT NULL,
  break_min   int  NOT NULL DEFAULT 30,
  grace_min   int  NOT NULL DEFAULT 10
);
CREATE TABLE holiday (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  on_date date NOT NULL,
  name    text NOT NULL,
  site_id uuid REFERENCES site(id),           -- NULL = every site
  UNIQUE (on_date, site_id)
);

CREATE TABLE employee (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,
  name           text NOT NULL,
  site_id        uuid NOT NULL REFERENCES site(id),
  department_id  uuid REFERENCES department(id),
  designation_id uuid REFERENCES designation(id),
  manager_id     uuid REFERENCES employee(id),
  shift_id       uuid REFERENCES shift(id),
  user_id        uuid UNIQUE REFERENCES app_user(id),   -- sign-in account, if any
  emp_type       text NOT NULL DEFAULT 'permanent' CHECK (emp_type IN ('permanent','contract','daily')),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','exited')),
  join_date      date NOT NULL,
  exit_date      date,
  exit_reason    text,
  phone          text,
  bank_account   text,
  pf_applicable  boolean NOT NULL DEFAULT true,
  esi_applicable boolean NOT NULL DEFAULT true,
  version        int NOT NULL DEFAULT 1,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (exit_date IS NULL OR exit_date >= join_date)
);
CREATE INDEX employee_site_idx ON employee(site_id, status);

-- ═══════════ Attendance ═══════════
CREATE TABLE attendance (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employee(id),
  work_date   date NOT NULL,
  status      text NOT NULL CHECK (status IN ('P','A','H','L','LWP','WO','HOL')),
  in_time     time,
  out_time    time,
  worked_min  int NOT NULL DEFAULT 0,
  late_min    int NOT NULL DEFAULT 0,
  ot_min      int NOT NULL DEFAULT 0,
  source      text NOT NULL DEFAULT 'manual',
  note        text,
  locked      boolean NOT NULL DEFAULT false,      -- true once payroll for the month is approved
  marked_by   uuid,
  version     int NOT NULL DEFAULT 1,
  UNIQUE (employee_id, work_date)
);

CREATE FUNCTION forbid_locked_attendance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.locked AND (TG_OP = 'DELETE' OR NEW.locked) THEN
    RAISE EXCEPTION 'Attendance for % is locked by approved payroll', OLD.work_date;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attendance_locked BEFORE UPDATE OR DELETE ON attendance
  FOR EACH ROW EXECUTE FUNCTION forbid_locked_attendance();

-- ═══════════ Leave ═══════════
CREATE TABLE leave_type (
  code            text PRIMARY KEY,
  name            text NOT NULL,
  paid            boolean NOT NULL DEFAULT true,
  annual_quota    numeric(6,1) NOT NULL DEFAULT 0,
  allow_negative  boolean NOT NULL DEFAULT false
);

CREATE TABLE leave_request (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number      text NOT NULL UNIQUE,
  employee_id uuid NOT NULL REFERENCES employee(id),
  leave_type  text NOT NULL REFERENCES leave_type(code),
  from_date   date NOT NULL,
  to_date     date NOT NULL,
  half_day    boolean NOT NULL DEFAULT false,
  days        numeric(6,1) NOT NULL CHECK (days > 0),
  reason      text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  applied_by  uuid NOT NULL,
  decided_by  uuid,
  decision_note text,
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (to_date >= from_date)
);

-- Leave balance is a ledger too: grants add, approvals subtract, cancellations post a reversal
CREATE TABLE leave_ledger (
  id          bigserial PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employee(id),
  leave_type  text NOT NULL REFERENCES leave_type(code),
  delta       numeric(6,1) NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('annual','adjust','used','reversal')),
  year        int NOT NULL,
  request_id  uuid,
  reason      text,
  actor_id    uuid,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX leave_annual_once ON leave_ledger(employee_id, leave_type, year) WHERE kind = 'annual';
CREATE TRIGGER leave_ledger_immutable BEFORE UPDATE OR DELETE ON leave_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ═══════════ Payroll ═══════════
CREATE TABLE salary_structure (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id    uuid NOT NULL REFERENCES employee(id),
  effective_from date NOT NULL,
  basic          numeric(14,2) NOT NULL CHECK (basic >= 0),
  hra            numeric(14,2) NOT NULL DEFAULT 0 CHECK (hra >= 0),
  other_allowance numeric(14,2) NOT NULL DEFAULT 0 CHECK (other_allowance >= 0),
  status         text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','superseded')),
  proposed_by    uuid NOT NULL,
  approved_by    uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payroll_run (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number      text NOT NULL UNIQUE,
  site_id     uuid NOT NULL REFERENCES site(id),
  period      date NOT NULL,                    -- first day of the month
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','cancelled')),
  total_gross numeric(16,2) NOT NULL DEFAULT 0,
  total_net   numeric(16,2) NOT NULL DEFAULT 0,
  warnings    jsonb NOT NULL DEFAULT '[]',
  created_by  uuid NOT NULL,
  approved_by uuid,
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payroll_one_per_period ON payroll_run(site_id, period) WHERE status <> 'cancelled';

CREATE TABLE payslip (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES payroll_run(id),
  employee_id   uuid NOT NULL REFERENCES employee(id),
  days_in_month int NOT NULL,
  paid_days     numeric(5,1) NOT NULL,
  lop_days      numeric(5,1) NOT NULL,
  ot_hours      numeric(7,2) NOT NULL DEFAULT 0,
  basic         numeric(14,2) NOT NULL,
  hra           numeric(14,2) NOT NULL,
  other_allowance numeric(14,2) NOT NULL,
  ot_amount     numeric(14,2) NOT NULL DEFAULT 0,
  gross         numeric(14,2) NOT NULL,
  pf_employee   numeric(14,2) NOT NULL DEFAULT 0,
  esi_employee  numeric(14,2) NOT NULL DEFAULT 0,
  prof_tax      numeric(14,2) NOT NULL DEFAULT 0,
  total_deductions numeric(14,2) NOT NULL,
  net           numeric(14,2) NOT NULL,
  pf_employer   numeric(14,2) NOT NULL DEFAULT 0,
  esi_employer  numeric(14,2) NOT NULL DEFAULT 0,
  UNIQUE (run_id, employee_id)
);

-- Once a run leaves draft its payslips are final
CREATE FUNCTION forbid_final_payslip() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text;
BEGIN
  SELECT status INTO st FROM payroll_run WHERE id = COALESCE(OLD.run_id, NEW.run_id);
  IF st <> 'draft' THEN RAISE EXCEPTION 'Payslips of a % payroll run cannot be changed', st; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payslip_final BEFORE UPDATE OR DELETE ON payslip
  FOR EACH ROW EXECUTE FUNCTION forbid_final_payslip();
