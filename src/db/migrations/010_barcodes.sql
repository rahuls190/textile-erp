-- Barcode registry: every code the company uses is one row here, with a unique id and a unique code that is never reused.
CREATE TABLE barcode_series (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  entity_type text NOT NULL CHECK (entity_type IN ('item','lot','location','employee','carton','asset','generic')),
  prefix      text NOT NULL UNIQUE CHECK (prefix ~ '^[A-Z0-9]{1,6}$'),
  digits      int  NOT NULL DEFAULT 6 CHECK (digits BETWEEN 4 AND 10),
  next_no     bigint NOT NULL DEFAULT 1,
  symbology   text NOT NULL DEFAULT 'CODE128' CHECK (symbology IN ('CODE128','QR')),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE barcode (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[\x20-\x7e]{1,40}$'),
  series_id   uuid REFERENCES barcode_series(id),
  entity_type text NOT NULL CHECK (entity_type IN ('item','lot','location','employee','carton','asset','generic')),
  entity_id   uuid,                                   -- NULL = issued blank, to be attached later
  symbology   text NOT NULL DEFAULT 'CODE128' CHECK (symbology IN ('CODE128','QR')),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
  site_id     uuid REFERENCES site(id),
  note        text,
  issued_by   uuid REFERENCES app_user(id),           -- NULL = created automatically with the thing it names
  issued_at   timestamptz NOT NULL DEFAULT now(),
  assigned_at timestamptz,
  voided_by   uuid REFERENCES app_user(id),
  voided_at   timestamptz,
  void_reason text,
  print_count int NOT NULL DEFAULT 0
);
CREATE INDEX barcode_entity ON barcode(entity_type, entity_id);
CREATE INDEX barcode_status ON barcode(status, issued_at DESC);

-- a code's identity never changes and a code is never deleted: it can only be attached once, printed, or cancelled
CREATE FUNCTION barcode_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Barcodes are never deleted; cancel them instead'; END IF;
  IF NEW.code <> OLD.code OR NEW.series_id IS DISTINCT FROM OLD.series_id OR NEW.entity_type <> OLD.entity_type OR NEW.issued_at <> OLD.issued_at OR NEW.symbology <> OLD.symbology THEN
    RAISE EXCEPTION 'A barcode''s identity cannot be changed'; END IF;
  IF OLD.entity_id IS NOT NULL AND NEW.entity_id IS DISTINCT FROM OLD.entity_id THEN RAISE EXCEPTION 'This code is already attached to something'; END IF;
  IF OLD.status = 'void' AND NEW.status <> 'void' THEN RAISE EXCEPTION 'A cancelled code cannot be brought back'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER barcode_guard BEFORE UPDATE OR DELETE ON barcode FOR EACH ROW EXECUTE FUNCTION barcode_guard();

-- every print and reprint is recorded
CREATE TABLE barcode_print (
  id         bigserial PRIMARY KEY,
  batch_id   uuid NOT NULL,
  barcode_id uuid NOT NULL REFERENCES barcode(id),
  layout_id  uuid,
  layout_name text,
  copies     int NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 100),
  is_reprint boolean NOT NULL DEFAULT false,
  reason     text,
  printed_by uuid REFERENCES app_user(id),
  printed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX barcode_print_code ON barcode_print(barcode_id, printed_at DESC);
CREATE TRIGGER barcode_print_ro BEFORE UPDATE OR DELETE ON barcode_print FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- label designs: size, how many across a sheet, and the placed elements
CREATE TABLE label_layout (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  entity_type text NOT NULL CHECK (entity_type IN ('item','lot','location','employee','carton','asset','generic')),
  width_mm    numeric(6,1) NOT NULL CHECK (width_mm BETWEEN 15 AND 210),
  height_mm   numeric(6,1) NOT NULL CHECK (height_mm BETWEEN 10 AND 297),
  columns     int NOT NULL DEFAULT 1 CHECK (columns BETWEEN 1 AND 8),
  gap_mm      numeric(4,1) NOT NULL DEFAULT 2 CHECK (gap_mm BETWEEN 0 AND 20),
  elements    jsonb NOT NULL DEFAULT '[]',
  is_default  boolean NOT NULL DEFAULT false,
  active      boolean NOT NULL DEFAULT true,
  version     int NOT NULL DEFAULT 1,
  created_by  uuid REFERENCES app_user(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX label_layout_default ON label_layout(entity_type) WHERE is_default AND active;

-- things that already have a barcode-worthy identity get their registry row automatically
CREATE FUNCTION barcode_auto() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c text; t text; s uuid;
BEGIN
  IF TG_TABLE_NAME = 'lot' THEN c := NEW.label; t := 'lot'; s := NEW.site_id;
  ELSIF TG_TABLE_NAME = 'location' THEN c := 'L:' || NEW.code; t := 'location'; s := NEW.site_id;
  ELSIF TG_TABLE_NAME = 'item' THEN c := NEW.code; t := 'item'; s := NULL;
  ELSE c := NEW.code; t := 'employee'; s := NEW.site_id; END IF;
  IF c ~ '^[\x20-\x7e]{1,40}$' THEN
    INSERT INTO barcode(code, entity_type, entity_id, site_id, assigned_at) VALUES (c, t, NEW.id, s, now()) ON CONFLICT (code) DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lot_barcode AFTER INSERT ON lot FOR EACH ROW EXECUTE FUNCTION barcode_auto();
CREATE TRIGGER location_barcode AFTER INSERT ON location FOR EACH ROW EXECUTE FUNCTION barcode_auto();
CREATE TRIGGER item_barcode AFTER INSERT ON item FOR EACH ROW EXECUTE FUNCTION barcode_auto();
CREATE TRIGGER employee_barcode AFTER INSERT ON employee FOR EACH ROW EXECUTE FUNCTION barcode_auto();

-- backfill what already exists
INSERT INTO barcode(code, entity_type, entity_id, site_id, assigned_at) SELECT label, 'lot', id, site_id, now() FROM lot WHERE label ~ '^[\x20-\x7e]{1,40}$' ON CONFLICT (code) DO NOTHING;
INSERT INTO barcode(code, entity_type, entity_id, site_id, assigned_at) SELECT 'L:' || code, 'location', id, site_id, now() FROM location WHERE ('L:' || code) ~ '^[\x20-\x7e]{1,40}$' ON CONFLICT (code) DO NOTHING;
INSERT INTO barcode(code, entity_type, entity_id, assigned_at) SELECT code, 'item', id, now() FROM item WHERE code ~ '^[\x20-\x7e]{1,40}$' ON CONFLICT (code) DO NOTHING;
INSERT INTO barcode(code, entity_type, entity_id, site_id, assigned_at) SELECT code, 'employee', id, site_id, now() FROM employee WHERE code ~ '^[\x20-\x7e]{1,40}$' ON CONFLICT (code) DO NOTHING;

-- starting series for codes issued ahead of time
INSERT INTO barcode_series(name, entity_type, prefix, digits, symbology) VALUES
  ('Cartons', 'carton', 'CT', 6, 'CODE128'), ('Rolls (blank, pre-printed)', 'lot', 'RL', 6, 'CODE128'),
  ('Assets and tools', 'asset', 'AS', 5, 'CODE128'), ('General', 'generic', 'GN', 6, 'QR');

-- starting label layouts (mm)
INSERT INTO label_layout(name, entity_type, width_mm, height_mm, columns, is_default, elements) VALUES
 ('Roll label 50 x 25', 'lot', 50, 25, 1, true, '[{"type":"field","field":"item_code","x":2,"y":1.5,"w":24,"h":4,"size":8,"bold":true},{"type":"field","field":"date","x":26,"y":1.5,"w":22,"h":4,"size":6,"align":"right"},{"type":"field","field":"item_name","x":2,"y":6,"w":46,"h":3.5,"size":6},{"type":"barcode","x":2,"y":10,"w":46,"h":9},{"type":"field","field":"code","x":2,"y":20,"w":46,"h":4,"size":7,"align":"center"}]'),
 ('Shelf label 100 x 50', 'location', 100, 50, 1, true, '[{"type":"field","field":"code","x":4,"y":3,"w":60,"h":9,"size":18,"bold":true},{"type":"field","field":"kind","x":64,"y":4,"w":32,"h":6,"size":9,"align":"right"},{"type":"field","field":"name","x":4,"y":13,"w":92,"h":6,"size":11},{"type":"barcode","x":4,"y":21,"w":92,"h":20},{"type":"field","field":"barcode","x":4,"y":42,"w":92,"h":5,"size":9,"align":"center"}]'),
 ('Material tag 60 x 30', 'item', 60, 30, 1, true, '[{"type":"field","field":"name","x":2,"y":1.5,"w":56,"h":5,"size":9,"bold":true},{"type":"field","field":"unit","x":2,"y":7,"w":56,"h":4,"size":7},{"type":"barcode","x":2,"y":12,"w":56,"h":12},{"type":"field","field":"code","x":2,"y":25,"w":56,"h":4,"size":7,"align":"center"}]'),
 ('Carton label 100 x 70', 'carton', 100, 70, 1, true, '[{"type":"text","text":"CARTON","x":4,"y":3,"w":50,"h":8,"size":16,"bold":true},{"type":"field","field":"date","x":54,"y":4,"w":42,"h":6,"size":9,"align":"right"},{"type":"qr","x":4,"y":14,"w":40,"h":40},{"type":"field","field":"code","x":48,"y":18,"w":48,"h":8,"size":14,"bold":true},{"type":"field","field":"note","x":48,"y":28,"w":48,"h":20,"size":9},{"type":"line","x":4,"y":58,"w":92,"h":0},{"type":"field","field":"code","x":4,"y":60,"w":92,"h":6,"size":8,"align":"center"}]'),
 ('Staff badge tag 85 x 54', 'employee', 85, 54, 1, true, '[{"type":"field","field":"name","x":4,"y":4,"w":77,"h":9,"size":15,"bold":true},{"type":"field","field":"code","x":4,"y":14,"w":77,"h":6,"size":10},{"type":"barcode","x":4,"y":24,"w":77,"h":20},{"type":"field","field":"code","x":4,"y":45,"w":77,"h":5,"size":8,"align":"center"}]'),
 ('Asset tag 40 x 20', 'asset', 40, 20, 1, true, '[{"type":"qr","x":2,"y":2,"w":16,"h":16},{"type":"field","field":"code","x":20,"y":4,"w":18,"h":5,"size":8,"bold":true},{"type":"field","field":"note","x":20,"y":10,"w":18,"h":8,"size":6}]'),
 ('General QR 40 x 40', 'generic', 40, 40, 1, true, '[{"type":"qr","x":5,"y":3,"w":30,"h":30},{"type":"field","field":"code","x":2,"y":34,"w":36,"h":5,"size":8,"align":"center"}]');
