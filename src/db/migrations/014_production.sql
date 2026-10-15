-- Work orders: finishing (grey fabric becomes finished fabric) and cutting (fabric and trims become pieces of a style).
-- Everything that comes out goes to quality control before anyone can use it.

-- A quality inspection can now be for goods that came out of a work order, not only goods that came in on a receipt.
ALTER TABLE qc_inspection ALTER COLUMN receipt_line_id DROP NOT NULL;
ALTER TABLE qc_inspection ADD COLUMN source_work_order_id uuid, ADD COLUMN source_qty numeric(18,4), ADD COLUMN source_item_id uuid REFERENCES item(id), ADD COLUMN source_unit text;
ALTER TABLE qc_inspection ADD CONSTRAINT qc_has_source CHECK (receipt_line_id IS NOT NULL OR source_work_order_id IS NOT NULL);

CREATE TABLE work_order (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       uuid NOT NULL REFERENCES site(id),
  number        text NOT NULL UNIQUE,
  kind          text NOT NULL CHECK (kind IN ('finish','cut')),
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','completed','cancelled')),
  style_id      uuid REFERENCES product_style(id),
  out_item_id   uuid REFERENCES item(id),                 -- finishing: the finished fabric that comes back
  processor_id  uuid REFERENCES partner(id),              -- finishing: a job-work vendor; empty means in-house
  finish_name   text,
  colour        text,
  notes         text,
  created_by    uuid NOT NULL REFERENCES app_user(id),
  issued_by     uuid REFERENCES app_user(id),
  completed_by  uuid REFERENCES app_user(id),
  issued_at     timestamptz,
  completed_at  timestamptz,
  cancel_reason text,
  version       int NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE work_order_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wo_id       uuid NOT NULL REFERENCES work_order(id),
  line_no     int NOT NULL,
  role        text NOT NULL CHECK (role IN ('input','sku','output')),
  item_id     uuid NOT NULL REFERENCES item(id),
  sku_id      uuid REFERENCES sku(id),
  lot_id      uuid REFERENCES lot(id),
  planned_qty numeric(18,4) NOT NULL DEFAULT 0,
  actual_qty  numeric(18,4),
  unit        text NOT NULL REFERENCES unit(code),
  UNIQUE (wo_id, line_no)
);
-- What was actually taken out of stock for a work order, lot by lot (so every piece can be traced back to its roll).
CREATE TABLE work_order_issue (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wo_id       uuid NOT NULL REFERENCES work_order(id),
  lot_id      uuid NOT NULL REFERENCES lot(id),
  item_id     uuid NOT NULL REFERENCES item(id),
  qty         numeric(18,4) NOT NULL CHECK (qty > 0),
  colour      text
);
CREATE INDEX work_order_line_wo ON work_order_line(wo_id);
CREATE INDEX work_order_issue_wo ON work_order_issue(wo_id);
