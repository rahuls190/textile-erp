-- Production planning: six months ahead, minimum stock from average sales, and purchase requests for what will run short.

ALTER TABLE product_style ADD COLUMN cutting_yield_pct numeric(5,2) NOT NULL DEFAULT 100 CHECK (cutting_yield_pct BETWEEN 50 AND 100);

CREATE TABLE plan_setting (
  id                 boolean PRIMARY KEY DEFAULT true CHECK (id),
  sales_months       int NOT NULL DEFAULT 3  CHECK (sales_months BETWEEN 1 AND 24),
  cover_days         int NOT NULL DEFAULT 30 CHECK (cover_days BETWEEN 0 AND 365),
  lead_days          int NOT NULL DEFAULT 21 CHECK (lead_days BETWEEN 0 AND 365),
  horizon_months     int NOT NULL DEFAULT 6  CHECK (horizon_months BETWEEN 1 AND 12),
  updated_by         uuid REFERENCES app_user(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO plan_setting DEFAULT VALUES;

-- Per item: a manual minimum, days of cover and lead time (blank = use the company setting), who to buy from,
-- and for a finished fabric which grey fabric it is made from and how much is lost in finishing.
CREATE TABLE item_plan (
  item_id             uuid PRIMARY KEY REFERENCES item(id),
  manual_min          numeric(18,4) CHECK (manual_min >= 0),
  cover_days          int CHECK (cover_days BETWEEN 0 AND 365),
  lead_days           int CHECK (lead_days BETWEEN 0 AND 365),
  monthly_demand      numeric(18,4) CHECK (monthly_demand >= 0),
  preferred_vendor_id uuid REFERENCES partner(id),
  grey_item_id        uuid REFERENCES item(id),
  finish_loss_pct     numeric(5,2) NOT NULL DEFAULT 0 CHECK (finish_loss_pct BETWEEN 0 AND 60),
  updated_by          uuid REFERENCES app_user(id),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- A planned sales figure for one month overrides the average for that month.
CREATE TABLE plan_demand (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id    uuid NOT NULL REFERENCES item(id),
  month      date NOT NULL CHECK (month = date_trunc('month', month)::date),
  qty        numeric(18,4) NOT NULL CHECK (qty >= 0),
  note       text,
  updated_by uuid REFERENCES app_user(id),
  UNIQUE (item_id, month)
);

CREATE TABLE purchase_request (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id    uuid NOT NULL REFERENCES site(id),
  number     text NOT NULL UNIQUE,
  partner_id uuid REFERENCES partner(id),               -- empty when no vendor could be chosen
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','converted','cancelled')),
  po_id      uuid REFERENCES purchase_order(id),
  source     text NOT NULL DEFAULT 'plan' CHECK (source IN ('plan','manual')),
  note       text,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 1
);
CREATE TABLE purchase_request_line (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id     uuid NOT NULL REFERENCES purchase_request(id),
  line_no   int NOT NULL,
  item_id   uuid NOT NULL REFERENCES item(id),
  qty       numeric(18,4) NOT NULL CHECK (qty > 0),
  unit      text NOT NULL REFERENCES unit(code),
  needed_by date NOT NULL,
  order_by  date NOT NULL,
  est_rate  numeric(18,4),
  reason    text,
  UNIQUE (pr_id, line_no)
);
CREATE INDEX purchase_request_line_item ON purchase_request_line(item_id);
