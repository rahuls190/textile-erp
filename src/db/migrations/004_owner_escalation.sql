-- Escalation ladder for urgent approvals, and the owner's audited override.

CREATE TABLE escalation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq           bigserial UNIQUE,
  number        text GENERATED ALWAYS AS ('ESC-' || lpad(seq::text, 4, '0')) STORED,
  entity_type   text NOT NULL CHECK (entity_type IN ('purchase_order','stock_adjustment','leave_request','salary_structure','payroll_run')),
  entity_id     uuid NOT NULL,
  site_id       uuid REFERENCES site(id),
  title         text NOT NULL,
  amount        numeric(18,2),
  urgency       text NOT NULL CHECK (urgency IN ('urgent','critical')),
  level         int  NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 3),   -- 1 approver, 2 senior management, 3 owner
  reason        text NOT NULL,
  auto          boolean NOT NULL DEFAULT false,                          -- raised by the overdue sweep, not by a person
  raised_by     uuid NOT NULL REFERENCES app_user(id),
  raised_at     timestamptz NOT NULL DEFAULT now(),
  next_step_at  timestamptz NOT NULL,                                    -- when it moves up a level if nobody has acted
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','cancelled')),
  resolved_at   timestamptz,
  resolution    text,
  version       int NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX escalation_one_open ON escalation(entity_type, entity_id) WHERE status = 'open';

CREATE TABLE escalation_event (
  id            bigserial PRIMARY KEY,
  escalation_id uuid NOT NULL REFERENCES escalation(id),
  at            timestamptz NOT NULL DEFAULT now(),
  actor_id      uuid REFERENCES app_user(id),
  action        text NOT NULL,          -- raised | moved_up | resolved | cancelled | overridden
  level         int  NOT NULL,
  note          text
);
CREATE TRIGGER escalation_event_append_only BEFORE UPDATE OR DELETE ON escalation_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE override_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  actor_id      uuid NOT NULL REFERENCES app_user(id),
  entity_type   text NOT NULL,
  entity_id     uuid NOT NULL,
  title         text NOT NULL,
  decision      text NOT NULL CHECK (decision IN ('approve','reject')),
  reason        text NOT NULL,
  status_before text,
  created_by    text,                   -- who had prepared the item, for the record
  escalation_id uuid REFERENCES escalation(id)
);
CREATE TRIGGER override_log_append_only BEFORE UPDATE OR DELETE ON override_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
