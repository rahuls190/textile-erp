-- Products: a style (the design) with sizes and colours, one SKU per size and colour, and versioned bills of materials.
CREATE TABLE product_style (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,15}$'),
  name        text NOT NULL,
  category    text,
  description text,
  hsn_code    text,
  gst_rate    numeric(5,2),
  sizes       text[] NOT NULL CHECK (cardinality(sizes) BETWEEN 1 AND 24),
  colours     jsonb  NOT NULL DEFAULT '[]',             -- [{"code":"BLK","name":"Black"}]
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version     int  NOT NULL DEFAULT 1,
  created_by  uuid REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- every size and colour that is made is a stock item of its own (kind FG), so it can be quoted, ordered, stocked and labelled
CREATE TABLE sku (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  style_id   uuid NOT NULL REFERENCES product_style(id),
  item_id    uuid NOT NULL UNIQUE REFERENCES item(id),
  code       text NOT NULL UNIQUE,
  size       text NOT NULL,
  colour_code text NOT NULL,
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (style_id, size, colour_code)
);
CREATE INDEX sku_style ON sku(style_id);

CREATE TABLE bom (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  style_id      uuid NOT NULL REFERENCES product_style(id),
  version       int  NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','active','superseded')),
  notes         text,
  return_reason text,
  rev           int  NOT NULL DEFAULT 1,
  created_by    uuid REFERENCES app_user(id),
  submitted_by  uuid REFERENCES app_user(id),
  approved_by   uuid REFERENCES app_user(id),
  approved_at   timestamptz,
  effective_from date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (style_id, version)
);
CREATE UNIQUE INDEX bom_one_active ON bom(style_id) WHERE status = 'active';
CREATE UNIQUE INDEX bom_one_in_progress ON bom(style_id) WHERE status IN ('draft','submitted');

CREATE TABLE bom_line (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bom_id      uuid NOT NULL REFERENCES bom(id),
  line_no     int  NOT NULL,
  section     text NOT NULL CHECK (section IN ('FABRIC','TRIM','CUP','PACKING','PROCESS','WIP')),
  item_id     uuid NOT NULL REFERENCES item(id),
  qty         numeric(14,4) NOT NULL CHECK (qty > 0),          -- per piece
  unit        text NOT NULL REFERENCES unit(code),
  wastage_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (wastage_pct BETWEEN 0 AND 100),
  sizes       text[],                                           -- NULL = every size
  colours     text[],                                           -- NULL = every colour
  qty_by_size jsonb NOT NULL DEFAULT '{}',                      -- {"S":0.31,"M":0.34}: replaces qty for those sizes
  note        text,
  UNIQUE (bom_id, line_no)
);
CREATE INDEX bom_line_item ON bom_line(item_id);

-- A pack is the final box: one sellable item made of several SKUs (for example a 3-pack, or a size run of one colour)
-- plus the packing materials around them (box, carton, label, polybag).
CREATE TABLE sku_pack (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  item_id    uuid NOT NULL UNIQUE REFERENCES item(id),
  notes      text,
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_by uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sku_pack_line (
  id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id uuid NOT NULL REFERENCES sku_pack(id),
  kind    text NOT NULL CHECK (kind IN ('SKU','MATERIAL')),
  sku_id  uuid REFERENCES sku(id),
  item_id uuid REFERENCES item(id),
  qty     numeric(12,4) NOT NULL CHECK (qty > 0),
  CHECK ((kind='SKU' AND sku_id IS NOT NULL AND item_id IS NULL) OR (kind='MATERIAL' AND item_id IS NOT NULL AND sku_id IS NULL))
);
CREATE INDEX sku_pack_line_pack ON sku_pack_line(pack_id);
