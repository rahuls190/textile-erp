-- Textile ERP — foundation + stock core (blueprint M01-M04, P02, W01-W03, W04 reservations, W06 adjustments)
-- Quantities are NUMERIC (never floating point). Posted ledger rows are append-only.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ───────────────────────── Platform: control plane ─────────────────────────

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  password_hash text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE session (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES app_user(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role (
  key         text PRIMARY KEY,           -- ADM, MD, BUY, COM, STO ...
  description text NOT NULL
);

-- banded = permission is limited by the user's approval band (max_amount)
CREATE TABLE role_permission (
  role_key   text NOT NULL REFERENCES role(key),
  permission text NOT NULL,
  banded     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (role_key, permission)
);

-- Effective permission = role action AND site scope AND validity AND approval band
CREATE TABLE user_role (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  role_key    text NOT NULL REFERENCES role(key),
  site_id     uuid,                        -- NULL = all sites (company-wide)
  max_amount  numeric(18,2),               -- approval band; NULL = no band granted
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_role_user_idx ON user_role(user_id);

CREATE TABLE command_log (
  request_id text PRIMARY KEY,             -- idempotency identity
  actor_id   uuid,
  action     text NOT NULL,
  result     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid,
  before      jsonb,
  after       jsonb,
  reason      text,
  request_id  text
);
CREATE INDEX audit_entity_idx ON audit_log(entity_type, entity_id);

-- Transactional outbox: written in the same transaction as the business change
CREATE TABLE outbox_event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq            bigserial UNIQUE,
  event_type     text NOT NULL,
  schema_version int  NOT NULL DEFAULT 1,
  entity_type    text NOT NULL,
  entity_id      uuid,
  entity_version int,
  site_id        uuid,
  actor_id       uuid,
  correlation_id text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  payload        jsonb NOT NULL,
  delivered_at   timestamptz
);

CREATE TABLE doc_series (
  site_id  uuid NOT NULL,
  doc_type text NOT NULL,
  prefix   text NOT NULL,
  next_no  bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (site_id, doc_type)
);

-- ───────────────────────── M01 Company, sites, locations ─────────────────────────

CREATE TABLE legal_entity (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL,
  gstin     text,
  state     text,
  status    text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE site (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES legal_entity(id),
  code      text NOT NULL UNIQUE,
  name      text NOT NULL,
  status    text NOT NULL DEFAULT 'active'
);

-- Warehouse / rack / quarantine / transit / floor … a physical custody point
CREATE TABLE location (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id  uuid NOT NULL REFERENCES site(id),
  code     text NOT NULL,
  name     text NOT NULL,
  kind     text NOT NULL CHECK (kind IN ('RECEIVING','STORE','RACK','TRANSIT','FLOOR','VENDOR','SCRAP')),
  UNIQUE (site_id, code)
);

-- ───────────────────────── M02/M04 Masters ─────────────────────────

CREATE TABLE unit (
  code      text PRIMARY KEY,
  name      text NOT NULL,
  precision int  NOT NULL DEFAULT 3 CHECK (precision BETWEEN 0 AND 4)
);

CREATE TABLE item (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('FABRIC','TRIM','CUP','PACKING','PROCESS','WIP','FG')),
  parent_id   uuid REFERENCES item(id),             -- style → colour/size/cup variant
  stock_unit  text NOT NULL REFERENCES unit(code),
  tracking    text NOT NULL DEFAULT 'LOT' CHECK (tracking IN ('NONE','LOT','ROLL')),
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','active','inactive')),
  version     int  NOT NULL DEFAULT 1,
  attributes  jsonb NOT NULL DEFAULT '{}',
  created_by  uuid REFERENCES app_user(id),
  approved_by uuid REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE partner (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  is_vendor   boolean NOT NULL DEFAULT false,
  is_subcontractor boolean NOT NULL DEFAULT false,
  is_customer boolean NOT NULL DEFAULT false,
  gstin       text,
  bank_account text,                                -- masked unless partner.bank.view
  bank_verified_by uuid REFERENCES app_user(id),
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','verification','active','suspended','inactive')),
  version     int  NOT NULL DEFAULT 1,
  created_by  uuid REFERENCES app_user(id),
  approved_by uuid REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Effective-dated vendor rates; transactions store a snapshot, never a live link
CREATE TABLE rate (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partner(id),
  item_id    uuid NOT NULL REFERENCES item(id),
  unit       text NOT NULL REFERENCES unit(code),
  rate       numeric(18,4) NOT NULL CHECK (rate >= 0),
  currency   text NOT NULL DEFAULT 'INR',
  min_qty    numeric(18,4) NOT NULL DEFAULT 0,
  effective_from date NOT NULL,
  effective_to   date,
  status     text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','superseded')),
  proposed_by uuid REFERENCES app_user(id),
  approved_by uuid REFERENCES app_user(id)
);

-- ───────────────────────── P02 Purchase orders ─────────────────────────

CREATE TABLE purchase_order (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES site(id),         -- owning procurement node
  number      text NOT NULL UNIQUE,
  partner_id  uuid NOT NULL REFERENCES partner(id),
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN
              ('draft','approval_pending','approved','released','acknowledged','partial_receipt','completed','closed','cancelled')),
  version     int  NOT NULL DEFAULT 1,                   -- bumps on every committed change
  revision    int  NOT NULL DEFAULT 0,                   -- bumps on a post-release amendment
  currency    text NOT NULL DEFAULT 'INR',
  total       numeric(18,2) NOT NULL DEFAULT 0,
  terms       jsonb NOT NULL DEFAULT '{}',
  created_by  uuid NOT NULL REFERENCES app_user(id),
  approved_by uuid REFERENCES app_user(id),
  released_by uuid REFERENCES app_user(id),
  pending_amendment jsonb,                               -- proposed change awaiting approval; applied atomically
  amended_by  uuid REFERENCES app_user(id),
  released_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE po_line (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id     uuid NOT NULL REFERENCES purchase_order(id),
  line_no   int  NOT NULL,
  item_id   uuid NOT NULL REFERENCES item(id),
  qty       numeric(18,4) NOT NULL CHECK (qty > 0),
  unit      text NOT NULL REFERENCES unit(code),
  rate      numeric(18,4) NOT NULL CHECK (rate >= 0),    -- snapshot
  due_date  date,
  received_qty numeric(18,4) NOT NULL DEFAULT 0,         -- physically received (any QC state)
  accepted_qty numeric(18,4) NOT NULL DEFAULT 0,
  rejected_qty numeric(18,4) NOT NULL DEFAULT 0,
  UNIQUE (po_id, line_no)
);

-- Frozen copy of every committed version; prior versions stay visible
CREATE TABLE po_version (
  po_id    uuid NOT NULL REFERENCES purchase_order(id),
  version  int  NOT NULL,
  snapshot jsonb NOT NULL,
  actor_id uuid,
  reason   text,
  at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (po_id, version)
);

-- ───────────────────────── W01 Receipt, lots/rolls ─────────────────────────

CREATE TABLE receipt (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id    uuid NOT NULL REFERENCES site(id),
  number     text NOT NULL UNIQUE,
  po_id      uuid REFERENCES purchase_order(id),
  partner_id uuid NOT NULL REFERENCES partner(id),
  challan_no text NOT NULL,
  vehicle_no text,
  status     text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  received_by uuid NOT NULL REFERENCES app_user(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  notes      text
);
CREATE INDEX receipt_challan_idx ON receipt(partner_id, challan_no);

-- A lot/roll: stable identity of a physical stock unit
CREATE TABLE lot (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES site(id),         -- the owner node of this inventory pool
  item_id     uuid NOT NULL REFERENCES item(id),
  label       text NOT NULL UNIQUE,                      -- barcode identity (never regenerated on reprint)
  parent_lot_id uuid REFERENCES lot(id),                 -- split/slit genealogy (W07)
  source_receipt_id uuid REFERENCES receipt(id),
  source_po_line_id uuid REFERENCES po_line(id),
  attributes  jsonb NOT NULL DEFAULT '{}',               -- width, GSM, shade …
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE receipt_line (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL REFERENCES receipt(id),
  line_no   int  NOT NULL,
  po_line_id uuid REFERENCES po_line(id),
  item_id   uuid NOT NULL REFERENCES item(id),
  lot_id    uuid NOT NULL REFERENCES lot(id),
  qty       numeric(18,4) NOT NULL CHECK (qty > 0),
  unit      text NOT NULL REFERENCES unit(code),
  UNIQUE (receipt_id, line_no)
);

-- ───────────────────────── W03 Stock ledger ─────────────────────────
-- status is a separate dimension from location:  HOLD (QC pending) / ACCEPTED / REJECTED
CREATE TABLE stock_ledger (
  id            bigserial PRIMARY KEY,
  movement_id   uuid NOT NULL,                  -- groups the legs of one balanced movement
  site_id       uuid NOT NULL REFERENCES site(id),
  lot_id        uuid NOT NULL REFERENCES lot(id),
  item_id       uuid NOT NULL REFERENCES item(id),
  location_id   uuid NOT NULL REFERENCES location(id),
  status        text NOT NULL CHECK (status IN ('HOLD','ACCEPTED','REJECTED')),
  qty           numeric(18,4) NOT NULL CHECK (qty <> 0),   -- signed effect
  unit          text NOT NULL REFERENCES unit(code),
  movement_type text NOT NULL,                  -- RECEIPT, QC_RELEASE, QC_REJECT, PUTAWAY, ADJUSTMENT, RETURN …
  source_type   text NOT NULL,
  source_id     uuid NOT NULL,
  reverses_id   bigint REFERENCES stock_ledger(id),
  actor_id      uuid NOT NULL REFERENCES app_user(id),
  request_id    text,
  posted_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_lot_idx ON stock_ledger(lot_id);
CREATE INDEX ledger_item_loc_idx ON stock_ledger(item_id, location_id, status);

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% rows are append-only; post a linked reversal instead', TG_TABLE_NAME; END $$;
CREATE TRIGGER stock_ledger_immutable BEFORE UPDATE OR DELETE ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Derived balance (reporting reads this; it can never be typed over)
CREATE VIEW stock_balance AS
  SELECT site_id, lot_id, item_id, location_id, status, unit, SUM(qty) AS qty
  FROM stock_ledger GROUP BY site_id, lot_id, item_id, location_id, status, unit
  HAVING SUM(qty) <> 0;

-- Reservations are a separate commitment ledger; physical stock does not move
CREATE TABLE reservation (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id    uuid NOT NULL REFERENCES site(id),
  lot_id     uuid NOT NULL REFERENCES lot(id),
  qty        numeric(18,4) NOT NULL CHECK (qty > 0),
  demand_type text NOT NULL,
  demand_ref text NOT NULL,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','released','consumed')),
  reason     text,
  requested_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz
);
CREATE INDEX reservation_lot_idx ON reservation(lot_id) WHERE status = 'active';

-- ───────────────────────── W02 Quality ─────────────────────────

CREATE TABLE qc_inspection (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       uuid NOT NULL REFERENCES site(id),
  receipt_line_id uuid NOT NULL REFERENCES receipt_line(id),
  lot_id        uuid NOT NULL REFERENCES lot(id),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN
                ('pending','inspecting','submitted','accepted','held','rejected','partial')),
  inspected_qty numeric(18,4) NOT NULL DEFAULT 0,        -- sample size, separate from lot disposition
  recommend_accept numeric(18,4),
  recommend_reject numeric(18,4),
  accepted_qty  numeric(18,4) NOT NULL DEFAULT 0,
  rejected_qty  numeric(18,4) NOT NULL DEFAULT 0,
  inspector_id  uuid REFERENCES app_user(id),
  released_by   uuid REFERENCES app_user(id),
  defects       jsonb NOT NULL DEFAULT '[]',
  version       int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── W06 Stock adjustments ─────────────────────────

CREATE TABLE stock_adjustment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES site(id),
  number      text NOT NULL UNIQUE,
  lot_id      uuid NOT NULL REFERENCES lot(id),
  location_id uuid NOT NULL REFERENCES location(id),
  qty_delta   numeric(18,4) NOT NULL CHECK (qty_delta <> 0),
  reason      text NOT NULL,
  evidence    text,
  status      text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','posted')),
  proposed_by uuid NOT NULL REFERENCES app_user(id),
  approved_by uuid REFERENCES app_user(id),
  version     int NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now()
);
