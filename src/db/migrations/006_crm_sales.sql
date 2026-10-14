-- ═══════════ CRM ═══════════
CREATE TABLE crm_lead (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq           bigserial UNIQUE,
  number        text GENERATED ALWAYS AS ('LD-' || lpad(seq::text, 4, '0')) STORED,
  name          text NOT NULL,
  company       text,
  phone         text,
  email         text,
  source        text,
  interest      text,
  est_value     numeric(16,2) NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','qualified','quoted','won','lost')),
  owner_id      uuid NOT NULL REFERENCES app_user(id),
  next_follow_up date,
  lost_reason   text,
  customer_id   uuid REFERENCES partner(id),
  version       int NOT NULL DEFAULT 1,
  created_by    uuid NOT NULL REFERENCES app_user(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_lead_status_idx ON crm_lead(status);

CREATE TABLE crm_activity (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     uuid REFERENCES crm_lead(id),
  customer_id uuid REFERENCES partner(id),
  kind        text NOT NULL CHECK (kind IN ('call','visit','email','meeting','note')),
  summary     text NOT NULL,
  due_date    date,                                   -- a follow-up still to do
  done        boolean NOT NULL DEFAULT true,
  created_by  uuid NOT NULL REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (lead_id IS NOT NULL OR customer_id IS NOT NULL)
);

-- ═══════════ Sales ═══════════
CREATE TABLE customer_terms (
  partner_id   uuid PRIMARY KEY REFERENCES partner(id),
  credit_limit numeric(16,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  payment_days int NOT NULL DEFAULT 30 CHECK (payment_days BETWEEN 0 AND 365),
  updated_by   uuid REFERENCES app_user(id),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quotation (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES site(id),
  number      text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES partner(id),
  lead_id     uuid REFERENCES crm_lead(id),
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','rejected','cancelled')),
  valid_until date NOT NULL,
  total       numeric(16,2) NOT NULL DEFAULT 0,
  notes       text,
  created_by  uuid NOT NULL REFERENCES app_user(id),
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE quotation_line (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id uuid NOT NULL REFERENCES quotation(id),
  line_no      int NOT NULL,
  item_id      uuid NOT NULL REFERENCES item(id),
  qty          numeric(18,4) NOT NULL CHECK (qty > 0),
  unit         text NOT NULL REFERENCES unit(code),
  rate         numeric(18,4) NOT NULL CHECK (rate >= 0),
  disc_pct     numeric(5,2) NOT NULL DEFAULT 0 CHECK (disc_pct BETWEEN 0 AND 100),
  amount       numeric(16,2) NOT NULL,
  UNIQUE (quotation_id, line_no)
);

CREATE TABLE sales_order (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id      uuid NOT NULL REFERENCES site(id),
  number       text NOT NULL UNIQUE,
  customer_id  uuid NOT NULL REFERENCES partner(id),
  quotation_id uuid REFERENCES quotation(id),
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approval_pending','confirmed','part_dispatched','dispatched','cancelled')),
  total        numeric(16,2) NOT NULL DEFAULT 0,
  due_date     date,
  created_by   uuid NOT NULL REFERENCES app_user(id),
  approved_by  uuid REFERENCES app_user(id),
  cancel_reason text,
  version      int NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE so_line (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  so_id          uuid NOT NULL REFERENCES sales_order(id),
  line_no        int NOT NULL,
  item_id        uuid NOT NULL REFERENCES item(id),
  qty            numeric(18,4) NOT NULL CHECK (qty > 0),
  unit           text NOT NULL REFERENCES unit(code),
  rate           numeric(18,4) NOT NULL CHECK (rate >= 0),
  disc_pct       numeric(5,2) NOT NULL DEFAULT 0,
  amount         numeric(16,2) NOT NULL,
  dispatched_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (dispatched_qty >= 0),
  UNIQUE (so_id, line_no),
  CHECK (dispatched_qty <= qty)
);

CREATE TABLE dispatch (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id    uuid NOT NULL REFERENCES site(id),
  number     text NOT NULL UNIQUE,
  so_id      uuid NOT NULL REFERENCES sales_order(id),
  vehicle_no text,
  lr_no      text,
  dispatched_by uuid NOT NULL REFERENCES app_user(id),
  dispatched_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dispatch_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id uuid NOT NULL REFERENCES dispatch(id),
  so_line_id  uuid NOT NULL REFERENCES so_line(id),
  lot_id      uuid NOT NULL REFERENCES lot(id),
  location_id uuid NOT NULL REFERENCES location(id),
  qty         numeric(18,4) NOT NULL CHECK (qty > 0)
);
-- A dispatch is a fact: it is corrected by a return, never edited
CREATE TRIGGER dispatch_immutable BEFORE UPDATE OR DELETE ON dispatch FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER dispatch_line_immutable BEFORE UPDATE OR DELETE ON dispatch_line FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
